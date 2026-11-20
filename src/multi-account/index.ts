/**
 * OpenCode V2 plugin: multiple API accounts per provider.
 *
 * One virtual OpenCode provider is registered per account, each carrying its
 * own key (resolved into memory only). `/account` and the TUI `alt+a` binding
 * switch between them; a retry hook rotates accounts on rotating failures.
 */

import { Plugin, Model, Provider } from "@opencode/plugin"
import {
  accountCount,
  buildGroups,
  expandSessionHeaders,
  findAccount,
  findGroupByProvider,
  isRotatableError,
  loadConfig,
  mapApiToPackage,
  matchAccountByLabel,
  nextAccount,
  resolveKeys,
  type AccountGroup,
  type ModelConfig,
  type MultiAccountConfig,
} from "./config"

interface CachedModels {
  checkedAt: number
  models: ModelConfig[]
}

const MODELS_CACHE_TTL_MS = 30 * 60 * 1000
const PLUGIN_ID = "multi-account"

export async function setupMultiAccount(ctx: any) {
    let cfg: MultiAccountConfig = loadConfig(ctx.location.directory, ctx.options)
    let groups: AccountGroup[] = buildGroups(cfg)
    // In-memory only. Provider transforms reference this map; nothing is
    // written to disk, and no credential is created through ctx.integration.
    let keys = resolveKeys(cfg, groups)

    const modelCatalogs = new Map<string, ModelConfig[]>()
    const modelsCache = new Map<string, CachedModels>()
    const inflight = new Map<string, Promise<ModelConfig[]>>()
    const sessionModels = new Map<string, { providerID: string; id: string }>()
    const attempts = new Map<string, number>()

    async function fetchModels(group: AccountGroup): Promise<ModelConfig[]> {
      const url = group.modelUrl!
      const cached = modelsCache.get(group.providerName)
      if (cached && Date.now() - cached.checkedAt < MODELS_CACHE_TTL_MS) return cached.models
      const running = inflight.get(group.providerName)
      if (running) return running
      const job = (async () => {
        try {
          const res = await fetch(url)
          if (!res.ok) throw new Error(`modelUrl fetch failed: ${res.status}`)
          const data = (await res.json()) as { data?: Array<{ id: string; name?: string }> }
          const models: ModelConfig[] = (data.data ?? []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 4096,
          }))
          modelsCache.set(group.providerName, { checkedAt: Date.now(), models })
          return models
        } catch (e) {
          if (cached) return cached.models
          console.error(`[multi-account] modelUrl refresh failed for ${group.providerName}`, e)
          return []
        } finally {
          inflight.delete(group.providerName)
        }
      })()
      inflight.set(group.providerName, job)
      return job
    }

    async function rebuild() {
      cfg = loadConfig(ctx.location.directory, ctx.options)
      groups = buildGroups(cfg)
      keys = resolveKeys(cfg, groups)
      modelCatalogs.clear()
      await Promise.all(
        groups.filter((g) => g.modelUrl).map(async (g) => modelCatalogs.set(g.providerName, await fetchModels(g))),
      )
      await ctx.provider.reload()
    }

    function modelsFor(group: AccountGroup): ModelConfig[] {
      return group.modelUrl ? (modelCatalogs.get(group.providerName) ?? []) : group.models
    }

    function toModelInfo(providerID: string, model: ModelConfig) {
      const id = Model.ID.make(model.id)
      const pid = Provider.ID.make(providerID)
      const input = model.input ?? (model.reasoning ? ["text"] : ["text"])
      return {
        ...Model.Info.default(pid, id),
        name: model.name || model.id,
        capabilities: { tools: true, input, output: ["text"], temperature: true },
        limit: {
          context: model.contextWindow ?? 128000,
          output: model.maxTokens ?? 4096,
        },
        // Cost is informational metadata; the numeric fields are branded in
        // the SDK schema. Cast keeps config numbers usable without pulling a
        // brand constructor into this plugin.
        cost: [
          {
            input: model.cost?.input ?? 0,
            output: model.cost?.output ?? 0,
            cache: {
              read: model.cost?.cacheRead ?? 0,
              write: model.cost?.cacheWrite ?? 0,
            },
          },
        ] as any,
      }
    }

    await ctx.provider.transform((editor) => {
      for (const group of groups) {
        const catalog = modelsFor(group)
        for (const account of group.accounts) {
          const providerID = Provider.ID.make(account.providerID)
          const compat = group.compat ?? {}
          // Provider-level `compat` keys map to OpenCode provider compatibility fields where supported.
          const compatibility: Record<string, unknown> = {}
          for (const key of [
            "streamingUsage",
            "supportsPromptCacheKey",
            "requireReasoning",
            "maxTokensField",
            "requireFinishReason",
            "requireAssistantAfterTool",
            "cacheFormat",
            "mediaInput",
          ]) {
            if (key in compat) compatibility[key === "streamingUsage" ? "streamUsage" : key] = compat[key]
          }
          const settings: Record<string, unknown> = { baseURL: group.baseUrl, ...compat }
          // `authHeader: false` means no bearer header; pass `apiKey: false`
          // so the driver skips auth and only custom headers are used.
          settings.apiKey = group.authHeader === false ? false : (keys.get(account.providerID) ?? "")
          editor.add({
            info: {
              ...Provider.Info.empty(providerID),
              name: `${group.providerLabel} (${account.label})`,
              activation: "enabled",
              package: mapApiToPackage(group.api, group.package),
              headers: { ...account.headers },
              ...(Object.keys(compatibility).length ? { compatibility: compatibility as any } : {}),
              settings: settings as any,
            },
            models: catalog.map((m) => toModelInfo(account.providerID, m)),
          } as any)
        }
      }
    })

    // Track the session's selected model so commands can switch without a
    // round trip, even though commands do not receive the current model.
    await ctx.session.hook("experimental.model.resolve", (event) => {
      sessionModels.set(event.sessionID, { providerID: event.model.providerID, id: event.model.id })
    })

    // Every fresh prompt starts a new rotation budget.
    await ctx.session.hook("prompt", (event) => {
      attempts.set(event.sessionID, 0)
    })

    // Dynamic per-session headers, e.g. `x-opencode-session: $sessionId`.
    await ctx.session.hook("http.request", (event) => {
      const group = findGroupByProvider(groups, event.model.providerID)
      if (!group?.sessionHeaders) return
      for (const [name, value] of Object.entries(expandSessionHeaders(group.sessionHeaders, event.sessionID))) {
        event.request.headers.set(name, value)
      }
    })

    async function currentModel(sessionID: string): Promise<{ providerID: string; id: string } | undefined> {
      const tracked = sessionModels.get(sessionID)
      if (tracked) return tracked
      try {
        const session = await ctx.session.get({ sessionID })
        if (!session.model) return undefined
        const model = { providerID: session.model.providerID, id: session.model.id }
        sessionModels.set(sessionID, model)
        return model
      } catch {
        return undefined
      }
    }

    async function switchTo(
      sessionID: string,
      group: AccountGroup,
      providerID: string,
      modelID?: string,
    ): Promise<boolean> {
      const account = findAccount(group, providerID)
      if (!account) return false
      const id = modelID && modelsFor(group).some((m) => m.id === modelID) ? modelID : modelsFor(group)[0]?.id
      if (!id) return false
      await ctx.session.switchModel({ sessionID, model: { providerID, id } })
      sessionModels.set(sessionID, { providerID, id })
      return true
    }

    async function say(sessionID: string, text: string) {
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch (e) {
        console.error("[multi-account] could not post status message", e)
      }
    }

    // Auto-switch on failure: switch the session model to the next account and
    // retry immediately on the new key when a failure is rotatable.
    await ctx.session.hook("retry", async (event) => {
      if (cfg.autoSwitchOnFailure === false) return
      const group = findGroupByProvider(groups, event.model.providerID)
      if (!group || group.accounts.length < 2) return
      if (!isRotatableError(event.error)) return

      const used = attempts.get(event.sessionID) ?? 0
      if (used >= group.accounts.length) {
        attempts.set(event.sessionID, 0)
        event.decision = { retry: false }
        await say(event.sessionID, `Multi-account: all ${group.accounts.length} accounts on ${group.providerLabel} failed. Stopping auto-switch.`)
        return
      }

      const from = findAccount(group, event.model.providerID)
      const next = nextAccount(group, event.model.providerID)
      attempts.set(event.sessionID, used + 1)
      const ok = await switchTo(event.sessionID, group, next.providerID, event.model.id)
      if (!ok) return

      if (cfg.autoRetry === false) {
        // Switch the key but leave the failed turn for the user to resend.
        event.decision = { retry: false }
        await say(event.sessionID, `Multi-account: ${from?.label ?? "account"} failed. Switched to ${next.label}. Resend your message to retry.`)
        return
      }
      event.decision = { retry: true, delay: 0 }
      await say(event.sessionID, `Multi-account: ${from?.label ?? "account"} failed. Switched to ${next.label} — continuing on it.`)
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "account",
        description: "Manage multi-account providers (switch, cycle, list)",
        execute: async ({ sessionID, prompt }) => {
          if (groups.length === 0) {
            await say(sessionID, "No multi-account providers configured. Add `providers` to a multi-account.json config file.")
            return
          }
          const arg = (prompt.text ?? "").trim().toLowerCase()
          if (arg === "" || arg === "list") {
            const model = await currentModel(sessionID)
            const lines: string[] = []
            for (const group of groups) {
              for (const account of group.accounts) {
                const marker = model?.providerID === account.providerID ? "●" : "○"
                lines.push(`${marker} ${group.providerLabel} / ${account.label}`)
              }
            }
            await say(sessionID, lines.join("\n"))
            return
          }
          if (arg === "cycle") {
            const model = await currentModel(sessionID)
            const group = model && findGroupByProvider(groups, model.providerID)
            if (!group || group.accounts.length < 2) {
              await say(sessionID, "Current model is not on a multi-account provider.")
              return
            }
            const next = nextAccount(group, model!.providerID)
            if (await switchTo(sessionID, group, next.providerID, model!.id)) {
              await say(sessionID, `Switched to ${next.label}.`)
            }
            return
          }
          for (const group of groups) {
            const match = matchAccountByLabel(group, arg)
            if (!match) continue
            const model = await currentModel(sessionID)
            if (await switchTo(sessionID, group, match.providerID, model?.id)) {
              await say(sessionID, `Switched to ${match.label}.`)
            }
            return
          }
          await say(sessionID, `Account "${arg}" not found.`)
        },
      })
    })

    // Refresh dynamic catalogs (and config) periodically. Captured inputs need reload().
    const timer = setInterval(() => {
      void rebuild().catch((e) => console.error("[multi-account] catalog refresh failed", e))
    }, MODELS_CACHE_TTL_MS)
    timer.unref?.()

    console.log(
      `[multi-account] loaded ${groups.length} provider group(s), ${accountCount(groups)} account(s)`,
    )

    return () => clearInterval(timer)
  },
}

export default Plugin.define({ id: PLUGIN_ID, setup: setupMultiAccount })
