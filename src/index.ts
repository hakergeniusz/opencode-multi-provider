/**
 * opencode-multi-provider — unified multi-key / provider account stacking for OpenCode V2.
 *
 * Merges (and replaces) the separate opencode rewrites:
 *   - multi-account: virtual providers per account for any configured provider, /account, auto-switch/rotate on failure
 *   - gemini-router: google/gemini-flash and google/gemini-flash-lite ladder routers with per-(model,key) quota awareness
 *   - groq-compat: Groq model catalog/compat fixes (max_tokens, live /models sync) and /groq-compat command
 *   - multi-router: Groq/Cohere ladder routers (multirouter/*) with key rotation
 *
 * Poolside router is intentionally not included (Poolside inference discontinued).
 *
 * All sub-features are enabled by default. Disable individually with options:
 *   { "multiAccount": false, "geminiRouter": false, "groqCompat": false, "multiRouter": false }
 * Options passed through are forwarded to sub-features (e.g. multi-account config,
 * groq compat refreshAtStartup, gemini-router ladders/order/apiKeys, multi-router keys/base URLs).
 */
import { Plugin } from "@opencode/plugin"
import { setupGeminiRouter } from "./gemini-router/index.ts"
import { setupGroqCompat } from "./groq-compat/index.ts"
import { setupMultiAccount } from "./multi-account/index.ts"
import { setupMultiRouter } from "./multi-router/index.ts"

type AnyCtx = any

function enabled(opt: unknown, def = true): boolean {
  if (opt === undefined) return def
  return Boolean(opt)
}

export default Plugin.define({
  id: "opencode-multi-provider",
  async setup(ctx) {
    const c = ctx as AnyCtx
    const opts = (c.options ?? {}) as Record<string, unknown>
    const cleanups: Array<() => void | Promise<void>> = []

    const run = async (name: string, on: boolean, fn: (ctx: AnyCtx) => Promise<any>) => {
      if (!on) return
      try {
        const cleanup = await fn(c)
        if (typeof cleanup === "function") cleanups.push(cleanup)
      } catch (err) {
        console.error(`[opencode-multi-provider] ${name} setup failed:`, err)
      }
    }

    // Order matters a bit: groq-compat patches the groq provider catalog;
    // multi-account/multi-router register virtual providers; gemini-router adds router models.
    await run("groq-compat", enabled(opts.groqCompat), setupGroqCompat)
    await run("multi-account", enabled(opts.multiAccount), setupMultiAccount)
    await run("multi-router", enabled(opts.multiRouter), setupMultiRouter)
    await run("gemini-router", enabled(opts.geminiRouter), setupGeminiRouter)

    return () => {
      for (const fn of cleanups) {
        try {
          const r = fn()
          if (r && typeof (r as any).then === "function") void (r as Promise<void>).catch(() => {})
        } catch {
          // ignore
        }
      }
    }
  },
})
