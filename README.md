# opencode-multi-provider

Unified OpenCode V2 plugin for **multi-key / provider account stacking and routing**. It merges the separate rewrite plugins into one package:

- **multi-account** — register one virtual provider per account for the same API endpoint (any provider) so multiple keys can be used to increase rate limits. Switch with `/account` or `Alt+A` (TUI); optional auto-switch/auto-retry on failure.
- **gemini-router** — adds `google/gemini-flash` and `google/gemini-flash-lite` router models that walk a model ladder and rotate API keys, with per-(model,key) quota awareness (RPD/RPM/suspected) persisted in plugin storage.
- **groq-compat** — keeps the `groq` provider usable: curated chat model catalog, verified limits, `compatibility.maxTokensField = "max_tokens"`, live `/models` refresh, and `/groq-compat` (`status|refresh|test`).
- **multi-router** — `multirouter/gpt-oss`, `multirouter/qwen`, `multirouter/command-a`, `multirouter/command-r` ladder routers that rotate Groq/Cohere keys (key-first across each ladder).

**Poolside router is intentionally excluded** (Poolside inference discontinued). This plugin replaces `opencode-multi-account`, `opencode-gemini-router`, `opencode-groq-compat`, and `opencode-multi-router`.

All sub-features are enabled by default. Ports are not 1:1 with the original pi extensions; behavior is adapted to OpenCode V2 APIs.

## Install / load

```jsonc title="opencode.jsonc"
{
  "plugins": [
    "opencode-multi-provider"
  ]
}
```

Local checkout:

```jsonc
{ "plugins": ["/home/hakergeniusz/Projects/opencode-multi-provider"] }
```

Disable sub-features or pass options:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-multi-provider",
      "options": {
        "multiAccount": true,
        "geminiRouter": true,
        "groqCompat": true,
        "multiRouter": true,
        "refreshAtStartup": false
      }
    }
  ]
}
```

TUI part (account picker / `Alt+A`): `opencode-multi-provider/tui` (loaded with the package exports where applicable).

## Configuration by feature

### Multi-account (generic stacking for any provider)
Config is merged from `~/.pi/agent/multi-account.json`, `~/.config/opencode/multi-account.json`, `<project>/.pi/multi-account.json`, `<project>/.opencode/multi-account.json`, and plugin `options` (or `options.config`). Defines `providers` with `accounts` (label + `apiKey` as `$VAR`/`!cmd`/literal resolved in-memory), models or `modelUrl`, headers, session headers, etc. Registers `provider-label/modelId` virtual providers.

Commands/bindings: `/account` (list/cycle/select), `Alt+A` cycles (TUI). Auto-switch on rotatable failures via retry hook (`autoSwitchOnFailure`, `autoRetry`).

### Gemini router
Options/env: `ladders`, `order` (`key-first`|`model-first`), `quotaAware`, `apiKeys` or `GEMINI_ROUTER_API_KEYS`, `keyHeader` (default `x-goog-api-key`), `googleProviderID`, `configPath` (`~/.config/opencode/gemini-router.json`). Registers `google/gemini-flash` and `google/gemini-flash-lite`. Command: `/gemini-router` (status/reset/quota-reset).

### Groq compat
Options: `refreshAtStartup` (default `false`). Patches built-in `groq` provider models/compat. Command: `/groq-compat` `status|refresh|test`. Reads `GROQ_API_KEY` only for the `test` probe.

### Multi-router (Groq/Cohere ladders)
Keys from env `GROQ_API_KEY[_N]`, `COHERE_API_KEY[_N]` or options `groqKeys`/`cohereKeys`; endpoints via `groqBaseURL`/`cohereBaseURL` or env. Command: `/multi-router` and `/multi-router reset [groq|cohere]`. Registers `multirouter/*` models.

## Security notes
- API keys are resolved/held in memory for provider transforms; this plugin does not write secrets to disk. Prefer `$ENV_VAR` references in config files.
- Do not commit config files containing literal keys.

## Development
```bash
bun install
bun run typecheck   # if configured
bun test            # pure helper tests where present
```

MIT — 2026 hakergeniusz. Consolidated from opencode/pi rewrites of pi-multi-account, pi-gemini-router, pi-groq-compat, pi-multi-router.
