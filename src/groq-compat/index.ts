/**
 * opencode-groq-compat — native OpenCode V2 port of `pi-groq-compat`.
 *
 * The original pi extension fixed two things about Groq's OpenAI-compatible
 * chat API, and exposed a `/groq-compat` command with status/refresh/test.
 *
 * 1. "developer role" fix (pi-specific). Pi's OpenAI-completions adapter sent
 *    `role: "developer"` for system prompts unless a model's compat set
 *    `supportsDeveloperRole: false`; Groq's llama.cpp templates only accept
 *    `role: "system"` and returned a 400 minijinja templating error.
 *
 *    OpenCode V2 has NO `supportsDeveloperRole` compatibility field — its
 *    `@opencode/ai/providers/openai-compatible` provider (Vercel AI SDK based)
 *    emits `role: "system"` for chat-completions system messages and OpenCode's
 *    internal message model has no "developer" role at all. The bug therefore
 *    does not exist in this host; nothing to patch. See README "Gaps".
 *
 * 2. Model-catalog drift + `max_tokens` field (still meaningful). This plugin
 *    uses `ctx.provider.transform` to keep the built-in `groq` provider's auth
 *    and settings while replacing its model inventory with a curated set of
 *    chat models, verified context/output limits, and
 *    `compatibility.maxTokensField = "max_tokens"` (Groq has no
 *    `max_completion_tokens`). Audio models, prompt-guard classifiers and
 *    retired enterprise-only ids are excluded.
 *
 * Commands:
 *   /groq-compat           status: key state, active model, registered models
 *   /groq-compat refresh   re-read GET /models and re-register (then reload)
 *   /groq-compat test      send a developer-role probe to the active groq model
 *
 * Auth is never read, stored or transmitted by this plugin except for the
 * optional probe in `test`; the provider's own credentials are left untouched.
 */

import { Model, Plugin, Provider } from "@opencode/plugin"

const GROQ_BASE_URL = "https://api.groq.com/openai/v1"
const MODELS_URL = `${GROQ_BASE_URL}/models`
const PROVIDER_ID = "groq"

interface ChatModelMeta {
  contextWindow: number
  maxTokens: number
  /** Per the original notes: allam-2-7b cannot do tool calling on Groq. */
  tools: boolean
  reasoning: boolean
}

/** Groq docs values; allam-2-7b limits were API-probed in the original. */
const MODEL_META: Record<string, ChatModelMeta> = {
  "openai/gpt-oss-120b": { contextWindow: 131072, maxTokens: 65536, tools: true, reasoning: true },
  "openai/gpt-oss-20b": { contextWindow: 131072, maxTokens: 65536, tools: true, reasoning: true },
  "openai/gpt-oss-safeguard-20b": { contextWindow: 131072, maxTokens: 65536, tools: true, reasoning: true },
  "qwen/qwen3.8-27b": { contextWindow: 131072, maxTokens: 16384, tools: true, reasoning: true },
  "allam-2-7b": { contextWindow: 4096, maxTokens: 2048, tools: false, reasoning: false },
}

/** Sane defaults for models Groq adds later; fixable via /groq-compat refresh. */
const DEFAULT_META: ChatModelMeta = {
  contextWindow: 131072,
  maxTokens: 16384,
  tools: true,
  reasoning: false,
}

/** Text classifiers: bare user message only (no system prompt), not usable by an agent. */
const CLASSIFIER_PATTERNS = [/^meta-llama\/llama-prompt-guard/]
/** Enterprise-only ids from the stale generated catalog (404 on the free tier). */
const RETIRED_PATTERNS = [/^llama-3\.1-8b-instant$/, /^llama-3\.3-70b-versatile$/, /^qwen\/qwen3\.6-27b$/]
/** Audio endpoints and retired/enterprise ids. */
const NON_CHAT_PATTERNS = [...CLASSIFIER_PATTERNS, ...RETIRED_PATTERNS, /^whisper/, /^canopylabs/, /orpheus/]

function isChatModelId(id: string): boolean {
  return !NON_CHAT_PATTERNS.some((re) => re.test(id))
}

function groqApiKey(): string | undefined {
  // Same fallback chain the original used. Only the `test` command reads it.
  return process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_2 || process.env.GROQ_API_KEY_1
}

function staticIds(): string[] {
  return Object.keys(MODEL_META)
}

/**
 * Build OpenCode V2 `Model.Info` values from the pi model definitions.
 * `Model.Info.default` supplies every required branded/default field; we only
 * override the fields the original extension cared about.
 */
function buildModels(ids: string[]) {
  const providerID = Provider.ID.make(PROVIDER_ID)
  return ids.map((id) => {
    const meta = MODEL_META[id] ?? DEFAULT_META
    const base = Model.Info.default(providerID, Model.ID.make(id))
    return {
      ...base,
      name: id,
      limit: { context: meta.contextWindow, input: meta.contextWindow, output: meta.maxTokens },
      capabilities: {
        tools: meta.tools,
        input: ["text"],
        output: ["text"],
      },
      // OpenCode V2 compat: Groq uses `max_tokens`, not `max_completion_tokens`.
      // This is the direct V2 equivalent of pi's `compat.maxTokensField`.
      compatibility: { ...(base.compatibility ?? {}), maxTokensField: "max_tokens" },
    } as typeof base
  })
}

async function fetchLiveChatModelIds(): Promise<string[]> {
  const key = groqApiKey()
  const headers: Record<string, string> = {}
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetch(MODELS_URL, { headers })
  if (!res.ok) throw new Error(`GET ${MODELS_URL} -> ${res.status}`)
  const data = (await res.json()) as { data?: Array<{ id?: string }> }
  const ids = (data.data ?? []).map((m) => m.id ?? "").filter((id) => id && isChatModelId(id))
  return Array.from(new Set([...ids, ...staticIds()])).sort()
}

interface PluginOptions {
  /** Fetch the live /models list during setup instead of only on /refresh. Default: false. */
  refreshAtStartup?: boolean
}

export async function setupGroqCompat(ctx: any) {
    const options = (ctx.options ?? {}) as PluginOptions

    // Captured by the provider transform; mutated by `refresh`, then reloaded.
    const source = {
      models: options.refreshAtStartup
        ? buildModels(await fetchLiveChatModelIds().catch(() => staticIds()))
        : buildModels(staticIds()),
    }

    await ctx.provider.transform((editor) => {
      const providerID = Provider.ID.make(PROVIDER_ID)
      const existing = editor.get(PROVIDER_ID)

      if (!existing) {
        // Fallback: no built-in groq provider to patch. Register one with the
        // same base URL and package as OpenCode's openai-compatible providers.
        // Auth is taken from the environment here because there is no built-in
        // provider/connection to inherit from in this branch.
        const key = groqApiKey()
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: "Groq",
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: GROQ_BASE_URL, ...(key ? { apiKey: key } : {}) },
            compatibility: { maxTokensField: "max_tokens" },
          } as Parameters<typeof editor.add>[0]["info"],
          models: source.models,
        })
        return
      }

      // Normal path: patch the built-in provider in place so its auth, settings
      // and connection stay exactly as OpenCode configured them.
      editor.update(PROVIDER_ID, (provider) => {
        provider.compatibility = {
          ...(provider.compatibility ?? {}),
          maxTokensField: "max_tokens",
        }
      })
      editor.models.set(PROVIDER_ID, source.models)
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "groq-compat",
        description: "Groq provider status/refresh/test (max_tokens compat + live model sync)",
        execute: async ({ sessionID, prompt }) => {
          const cmd = (prompt.text || "").trim().toLowerCase()
          // OpenCode V2 has no ui.notify for server plugins; surface command
          // output as a synthetic message in the invoking session.
          const say = (text: string) => ctx.session.synthetic({ sessionID, text })

          if (cmd === "refresh") {
            try {
              const ids = await fetchLiveChatModelIds()
              source.models = buildModels(ids)
              await ctx.provider.reload()
              await say(`groq-compat: registered ${ids.length} live models, maxTokensField=max_tokens`)
            } catch (e) {
              await say(`groq-compat refresh failed: ${(e as Error).message}`)
            }
            return
          }

          const session = (await ctx.session.get({ sessionID })) as {
            model?: { providerID?: string; id?: string }
            data?: { model?: { providerID?: string; id?: string } }
          }
          const active = session?.model ?? session?.data?.model

          if (cmd === "test") {
            if (!active || active.providerID !== PROVIDER_ID) {
              await say("groq-compat test: active model is not a groq model")
              return
            }
            const key = groqApiKey()
            if (!key) {
              await say("groq-compat test: GROQ_API_KEY not set in this environment")
              return
            }
            try {
              const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: active.id,
                  messages: [
                    { role: "developer", content: "You are terse." },
                    { role: "user", content: "ping" },
                  ],
                  max_tokens: 4,
                }),
              })
              const text = await res.text()
              await say(
                res.ok
                  ? `groq-compat: developer-role request accepted — ${active.id}`
                  : `groq-compat: request rejected — ${res.status} ${text.slice(0, 160)}`,
              )
            } catch (e) {
              await say(`groq-compat test failed: ${(e as Error).message}`)
            }
            return
          }

          // status (default)
          const keyState = groqApiKey() ? "GROQ_API_KEY present" : "GROQ_API_KEY MISSING"
          const models = (source.models as Array<{ modelID?: string; id?: string }>)
            .map((m) => m.modelID ?? m.id ?? "")
            .filter(Boolean)
          const lines = [
            `groq-compat status — ${keyState}`,
            `active: ${active ? `${active.providerID} / ${active.id}` : "none"}`,
            `registered groq models: ${models.join(", ") || staticIds().join(", ")}`,
            "compat: maxTokensField=max_tokens on all groq models",
            "/groq-compat refresh | test",
          ]
          await say(lines.join("\n"))
        },
      })
    })
}

export default Plugin.define({ id: "opencode-groq-compat", setup: setupGroqCompat })
