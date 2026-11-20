/**
 * opencode-gemini-router — native OpenCode V2 provider/model routing plugin.
 *
 * Ported from `pi-gemini-router`. The original offered two virtual models on
 * the `google` provider:
 *
 *   google/gemini-flash        ladder: gemini-4-hydrogen → gemini-flash-latest → 3.8 → … → 3-flash-preview
 *   google/gemini-flash-lite   ladder: gemini-flash-lite-latest → 3.5-flash-lite → 3.1-flash-lite
 *
 * and walked the (model, key) matrix until one pair answered. In OpenCode V2
 * the equivalents are:
 *
 *   - register router models via `ctx.provider.transform`
 *   - route a request to the current ladder entry via the
 *     `experimental.model.resolve` session hook
 *   - rotate API keys via the `http.request` hook (OpenCode's resolve hook
 *     cannot cross providers, so `google-keyN` providers from pi-multi-account
 *     are replaced by an ordered key list applied to the `google` provider)
 *   - make quota 429s retryable and advance the pair via the `retry` hook
 *   - persist state/quota marks via `ctx.storage`
 *   - `/gemini-router` via `ctx.command.transform`
 *
 * See README.md for the mapping notes and gaps. Treat all external data
 * (config files, options, error strings, HTTP bodies) as untrusted.
 */

import { Model, Plugin, Provider } from "@opencode/plugin"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  advanceState,
  DEFAULT_FLASH_LADDER,
  DEFAULT_FLASH_LITE_LADDER,
  FLASH_CONTEXT_WINDOW,
  FLASH_MAX_TOKENS,
  geminiMajorVersion,
  isRotatableError,
  ladderLabel,
  pairKey,
  pickPair,
  quotaMarkOf,
  remainingLabel,
  type AdvanceOrder,
  type QuotaKind,
  type QuotaMark,
  type QuotaMarks,
  type RouterState,
} from "./router.ts"

interface RouterOptions {
  /** Overrides ladders loaded from the config file. */
  ladders?: Partial<Record<"gemini-flash" | "gemini-flash-lite", string[]>>
  order?: AdvanceOrder
  quotaAware?: boolean
  /** API keys rotated per request. Takes precedence over GEMINI_ROUTER_API_KEYS. */
  apiKeys?: string[]
  /** Request header used to send a rotated key. Default: x-goog-api-key. */
  keyHeader?: string
  /** Provider to attach the router models to. Default: google. */
  googleProviderID?: string
  /** Optional JSON config file. Default: ~/.config/opencode/gemini-router.json */
  configPath?: string
}

const THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator"

const QUOTA_PREFIX = "quota/"
const STATE_PREFIX = "state/"

/** State captured when a request is routed, consumed by the HTTP/retry hooks. */
interface ActiveRoute {
  routerID: "gemini-flash" | "gemini-flash-lite"
  ladder: readonly string[]
  modelIndex: number
  keyIndex: number
  tried: number
  wantXhigh: boolean
}

export async function setupGeminiRouter(ctx: any) {
    // ---- configuration ----------------------------------------------------
    const fromCtx = (ctx.options ?? {}) as RouterOptions
    let fromFile: RouterOptions = {}
    try {
      const path = fromCtx.configPath ?? join(homedir(), ".config", "opencode", "gemini-router.json")
      fromFile = JSON.parse(readFileSync(path, "utf-8")) as RouterOptions
    } catch {
      fromFile = {}
    }
    const options: RouterOptions = { ...fromFile, ...fromCtx }
    const providerID = options.googleProviderID || "google"
    const order: AdvanceOrder = options.order === "model-first" ? "model-first" : "key-first"
    const quotaAware = options.quotaAware !== false
    const keyHeader = options.keyHeader || "x-goog-api-key"

    const ladders: Record<"gemini-flash" | "gemini-flash-lite", string[]> = {
      "gemini-flash":
        options.ladders?.["gemini-flash"]?.length ? [...options.ladders["gemini-flash"]] : [...DEFAULT_FLASH_LADDER],
      "gemini-flash-lite":
        options.ladders?.["gemini-flash-lite"]?.length
          ? [...options.ladders["gemini-flash-lite"]]
          : [...DEFAULT_FLASH_LITE_LADDER],
    }
    const routerIDs = Object.keys(ladders) as Array<keyof typeof ladders>

    const envKeys = (process.env.GEMINI_ROUTER_API_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean)
    const apiKeys = (options.apiKeys?.filter((k) => typeof k === "string" && k.length > 0) ?? envKeys)
    // A single synthetic key keeps the matrix maths simple; the HTTP hook
    // leaves the provider's own credential untouched when this is the case.
    const keyIds = apiKeys.length > 0 ? apiKeys : ["<provider-default>"]
    const rotateKeys = apiKeys.length > 1

    function routerIDOf(id: string): keyof typeof ladders | undefined {
      return id === "gemini-flash" || id === "gemini-flash-lite" ? id : undefined
    }

    // ---- persisted state --------------------------------------------------
    const quotaMarks: QuotaMarks = {}
    const states = new Map<string, RouterState>()
    const activeRoutes = new Map<string, ActiveRoute>()
    let epoch = 0

    async function scanAll(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
      const out: Array<{ key: string; value: unknown }> = []
      let after: string | undefined
      for (;;) {
        const page = await ctx.storage.scan({ prefix, limit: 500, ...(after ? { after } : {}) })
        out.push(...(page.entries as Array<{ key: string; value: unknown }>))
        after = page.next
        if (!after) break
      }
      return out
    }

    for (const entry of await scanAll(QUOTA_PREFIX)) {
      const mark = entry.value as QuotaMark | undefined
      if (mark && typeof mark.until === "number" && mark.until > Date.now()) {
        quotaMarks[entry.key.slice(QUOTA_PREFIX.length)] = mark
      }
    }

    async function getState(sessionID: string): Promise<RouterState> {
      let state = states.get(sessionID)
      if (!state) {
        const stored = (await ctx.storage.get(STATE_PREFIX + sessionID)) as RouterState | undefined
        state = stored && typeof stored.modelIndex === "number"
          ? { ...stored, tried: stored.tried ?? 0 }
          : { modelIndex: 0, keyIndex: 0, epoch: 0, tried: 0 }
        states.set(sessionID, state)
      }
      if (state.epoch !== epoch) {
        state = { modelIndex: 0, keyIndex: 0, epoch, tried: 0 }
        states.set(sessionID, state)
      }
      return state
    }

    async function setState(sessionID: string, state: RouterState): Promise<void> {
      states.set(sessionID, state)
      await ctx.storage.set(STATE_PREFIX + sessionID, state as never)
    }

    function isDead(modelID: string, keyID: string): boolean {
      const mark = quotaMarks[pairKey(modelID, keyID)]
      return !!mark && mark.until > Date.now()
    }

    async function recordHit(modelID: string, keyID: string, message: string): Promise<QuotaMark | undefined> {
      const mark = quotaMarkOf(message)
      if (!mark) return undefined
      quotaMarks[pairKey(modelID, keyID)] = mark
      await ctx.storage.set(QUOTA_PREFIX + pairKey(modelID, keyID), mark as never)
      return mark
    }

    async function clearHit(modelID: string, keyID: string): Promise<void> {
      const k = pairKey(modelID, keyID)
      if (!quotaMarks[k]) return
      delete quotaMarks[k]
      await ctx.storage.remove(QUOTA_PREFIX + k)
    }

    async function clearAllQuota(): Promise<void> {
      for (const entry of await scanAll(QUOTA_PREFIX)) {
        await ctx.storage.remove(entry.key)
      }
      for (const k of Object.keys(quotaMarks)) delete quotaMarks[k]
    }

    // Which concrete models actually exist on the provider; missing (model,
    // key) pairs are skipped instead of being sent to the network.
    let availableModels = new Set<string>()
    async function refreshModels(): Promise<void> {
      const list = await ctx.model.list()
      availableModels = new Set(
        list.data.filter((m) => m.providerID === providerID).map((m) => m.id)
      )
    }
    await refreshModels()

    // ---- registrations ----------------------------------------------------
    const registrations: Array<{ dispose(): Promise<void> }> = []

    // Register the two router models under the existing provider. `models.set`
    // replaces the source inventory, so keep every existing model first.
    registrations.push(await ctx.provider.transform((editor) => {
      const record = editor.get(providerID)
      if (!record) return
      const existing = Array.from(record.models.values())
      const additions = routerIDs.map((id) => {
        const base = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id))
        return {
          ...base,
          name: id === "gemini-flash" ? "Gemini Flash (router)" : "Gemini Flash Lite (router)",
          limit: { ...base.limit, context: FLASH_CONTEXT_WINDOW, output: FLASH_MAX_TOKENS },
        }
      })
      editor.models.set(providerID, [...existing, ...additions] as never)
    }))

    // Cap the context window of every concrete ladder model: free-tier TPM is
    // 250K per project/model, so a larger advertised window just guarantees a
    // 429 later on.
    registrations.push(await ctx.model.transform((editor) => {
      const allLadderModels = new Set(routerIDs.flatMap((id) => ladders[id]))
      for (const model of editor.list(providerID)) {
        if (!allLadderModels.has(model.id)) continue
        editor.update(providerID, model.id, (draft) => {
          draft.limit.context = Math.min(draft.limit.context, FLASH_CONTEXT_WINDOW)
        })
      }
    }))

    // Route the selected virtual model to the current (model, key) pair.
    registrations.push(await ctx.session.hook(
      "experimental.model.resolve",
      async (event) => {
        if (event.kind === "title") return
        const routerID = routerIDOf(event.model.id)
        if (!routerID) return
        const ladder = ladders[routerID]
        const state = await getState(event.sessionID)
        const chosen = pickPair(
          ladder.length,
          keyIds.length,
          order,
          state,
          (m, k) => !availableModels.has(ladder[m]) || (quotaAware && isDead(ladder[m], keyIds[k]))
        )
        if (!chosen) return
        const modelID = ladder[chosen.modelIndex]
        activeRoutes.set(event.sessionID, {
          routerID,
          ladder,
          modelIndex: chosen.modelIndex,
          keyIndex: chosen.keyIndex,
          tried: state.tried,
          wantXhigh: activeRoutes.get(event.sessionID)?.wantXhigh ?? false,
        })
        await setState(event.sessionID, {
          modelIndex: chosen.modelIndex,
          keyIndex: chosen.keyIndex,
          epoch,
          tried: state.tried,
        })
        event.model = { ...event.model, id: Model.ID.make(modelID) }
      },
      { providerID }
    ))

    // Remember whether this request asked for xhigh; the resolve hook has no
    // access to request options, but it runs before this hook.
    registrations.push(await ctx.session.hook(
      "context",
      (event) => {
        const route = activeRoutes.get(event.sessionID)
        if (!route) return
        const opts = event.options as Record<string, unknown>
        const level = opts.reasoningEffort ?? opts.thinkingLevel ?? opts.reasoning
        route.wantXhigh = typeof level === "string" && level.toLowerCase() === "xhigh"
      },
      { providerID }
    ))

    // Rotate the credential and apply the wire-level Gemini fixes.
    registrations.push(await ctx.session.hook(
      "http.request",
      async (event) => {
        const e = event as unknown as {
          sessionID: string
          model: { id: string }
          request: Request
        }
        const route = activeRoutes.get(e.sessionID)
        const keyID = keyIds[route?.keyIndex ?? 0]
        if (rotateKeys && keyID) {
          e.request.headers.set(keyHeader, keyID)
        }

        const major = geminiMajorVersion(e.model.id)
        const strict = major !== undefined && major >= 3
        const wantXhigh = strict && !!route?.wantXhigh
        if (!strict && !wantXhigh) return

        let body: Record<string, unknown>
        try {
          body = JSON.parse(await e.request.clone().text()) as Record<string, unknown>
        } catch {
          return
        }
        let changed = false

        // Model switches drop thought signatures on prior function calls;
        // Google's sentinel skips validation for those unsigned parts.
        if (strict && Array.isArray(body.contents)) {
          for (const content of body.contents as Array<Record<string, unknown>>) {
            const parts = content?.parts
            if (!Array.isArray(parts)) continue
            for (const part of parts as Array<Record<string, unknown>>) {
              if (part && "functionCall" in part && !part.thoughtSignature) {
                part.thoughtSignature = THOUGHT_SIGNATURE_SENTINEL
                changed = true
              }
            }
          }
        }

        // xhigh lives on v1alpha. OpenCode may already resolve it; only
        // rewrite when the request actually asks for it and a HIGH level is
        // present, so other requests are untouched.
        const url = new URL(e.request.url)
        if (wantXhigh) {
          for (const key of ["config", "generationConfig"]) {
            const cfg = body[key] as { thinkingConfig?: { thinkingLevel?: unknown } } | undefined
            if (cfg?.thinkingConfig?.thinkingLevel === "HIGH") {
              cfg.thinkingConfig.thinkingLevel = "XHIGH"
              changed = true
            }
          }
          if (url.pathname.includes("/v1beta")) {
            url.pathname = url.pathname.replace("/v1beta", "/v1alpha")
            changed = true
          }
        }
        if (!changed) return
        e.request = new Request(url, {
          method: e.request.method,
          headers: e.request.headers,
          body: JSON.stringify(body),
        })
      },
      { providerID }
    ))

    // A successful response proves the pair is alive: drop its mark and end
    // the walk so the next prompt starts fresh.
    registrations.push(await ctx.session.hook(
      "http.response",
      async (event) => {
        const e = event as unknown as {
          sessionID: string
          kind?: string
          response: Response
        }
        if (e.kind && e.kind !== "primary") return
        if (e.response.status >= 400) return
        const route = activeRoutes.get(e.sessionID)
        if (!route) return
        const keyID = keyIds[route.keyIndex]
        if (keyID) await clearHit(route.ladder[route.modelIndex], keyID)
        const state = await getState(e.sessionID)
        if (state.tried) await setState(e.sessionID, { ...state, tried: 0 })
      },
      { providerID }
    ))

    // OpenCode does not retry quota exhaustion by default. Take over the
    // decision, advance the pair, and record what the failure means for the
    // pair's quota. The key rotation also takes effect through http.request
    // even if a retry reuses the already-resolved model.
    registrations.push(await ctx.session.hook(
      "retry",
      async (event) => {
        const message = event.error?.message ?? ""
        if (!isRotatableError(message)) return
        const route = activeRoutes.get(event.sessionID)
        if (!route) return
        const ladder = route.ladder
        const total = ladder.length * keyIds.length
        if (route.tried >= total || event.attempt >= total) return

        const current: RouterState = {
          modelIndex: route.modelIndex,
          keyIndex: route.keyIndex,
          epoch,
          tried: route.tried,
        }
        const failedKey = keyIds[current.keyIndex]
        if (quotaAware && failedKey) {
          await recordHit(ladder[current.modelIndex], failedKey, message)
        }
        const next = advanceState(current, ladder.length, keyIds.length, order, epoch)
        await setState(event.sessionID, next)
        activeRoutes.set(event.sessionID, {
          ...route,
          modelIndex: next.modelIndex,
          keyIndex: next.keyIndex,
          tried: next.tried,
        })
        event.decision = { retry: true, delay: 0 }
      },
      { providerID }
    ))

    // ---- /gemini-router command -------------------------------------------
    registrations.push(await ctx.command.transform((editor) => {
      editor.add({
        name: "gemini-router",
        description: "Show the Gemini router ladders, keys, and quota marks; or reset",
        execute: async ({ sessionID, prompt }) => {
          const raw = (prompt.text ?? "").trim()
          const stripped = raw.replace(/^\/?gemini-router\b/i, "").trim().toLowerCase()
          const cmd = stripped || raw.toLowerCase()

          if (cmd === "reset") {
            epoch += 1
            states.clear()
            activeRoutes.clear()
            await ctx.session.synthetic({
              sessionID,
              text: "gemini-router: reset — next request starts at the ladder head on key1",
            })
            return
          }
          if (cmd === "quota-reset") {
            await clearAllQuota()
            await ctx.session.synthetic({
              sessionID,
              text: "gemini-router: quota marks cleared — every pair is considered live again",
            })
            return
          }

          const lines = [
            "gemini-router ladders:",
            "  gemini-flash       " + ladderLabel(ladders["gemini-flash"]),
            "  gemini-flash-lite  " + ladderLabel(ladders["gemini-flash-lite"]),
            "keys configured: " + (rotateKeys ? String(apiKeys.length) : "1 (provider default)"),
            "advance: " + order +
              (order === "key-first"
                ? " (all keys on one model, then next model)"
                : " (whole ladder per key, then next key)") +
              "; holds (model, key) until it errors",
            "quota awareness: " + (quotaAware ? "on" : "off"),
          ]
          const byKind = (kind: QuotaKind) =>
            Object.entries(quotaMarks)
              .filter(([, mark]) => mark.kind === kind && mark.until > Date.now())
              .map(([k, mark]) => k + " (" + remainingLabel(mark) + ")")
          lines.push("  RPD-dead until midnight PT: " + (byKind("rpd").join(", ") || "none"))
          lines.push("  possibly RPD: " + (byKind("suspected").join(", ") || "none"))
          lines.push("  cooling (per-minute): " + (byKind("minute").join(", ") || "none"))
          lines.push("/gemini-router reset — restart at the ladder head; quota-reset — clear quota marks")
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") })
        },
      })
    }))

    return async () => {
      await Promise.all(registrations.map((r) => r.dispose()))
    }
  },
}

export default Plugin.define({ id: "opencode-gemini-router", setup: setupGeminiRouter })
