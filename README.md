# opencode-multi-provider

OpenCode plugin for **multi-key/provider account stacking and routing**.

It provides:

- **Multi-account** — register one virtual provider per account for the same API endpoint (any configured provider) so multiple keys can be used to increase rate limits. Switch with `/account` or `Alt+A` (TUI), with optional auto-switch/auto-retry on rotatable failures.
- **Gemini router** — adds `google/gemini-flash` and `google/gemini-flash-lite` router models that walk a model ladder and rotate API keys, with per-(model,key) quota awareness persisted in plugin storage.
- **Groq compat** — keeps the built-in `groq` provider usable with a curated chat model catalog, verified limits, `compatibility.maxTokensField = "max_tokens"`, live `/models` refresh, and `/groq-compat` (`status|refresh|test`).
- **Multi-router** — `multirouter/gpt-oss`, `multirouter/qwen`, `multirouter/command-a`, and `multirouter/command-r` ladder routers that rotate Groq/Cohere keys.

All sub-features are enabled by default.

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

TUI part (account picker / `Alt+A`): `opencode-multi-provider/tui` (where package exports/TUI loading apply).

## Configuration by feature

### Multi-account (generic stacking for any provider)

Config is merged from `~/.config/opencode/multi-account.json`, `<project>/.opencode/multi-account.json`, and plugin `options` (or `options.config`), in that order (last wins).

Defines `providers` with `accounts` (label + `apiKey` as `$VAR` / `${VAR}` / `!cmd` / literal, resolved in memory), `baseUrl`, `api`, optional `models` or `modelUrl`, headers, session headers, and related provider settings. Registers `provider-label/modelId` virtual providers per account.

Commands/bindings: `/account` (list/cycle/select), `Alt+A` cycles in the TUI. Auto-switch on rotatable failures is controlled by `autoSwitchOnFailure` and `autoRetry`.

### Gemini router

Options/env: `ladders`, `order` (`key-first` | `model-first`), `quotaAware`, `apiKeys` or `GEMINI_ROUTER_API_KEYS`, `keyHeader` (default `x-goog-api-key`), `googleProviderID`, `configPath` (default `~/.config/opencode/gemini-router.json`).

Registers `google/gemini-flash` and `google/gemini-flash-lite`.

Command: `/gemini-router` (`status` / `reset` / `quota-reset`).

### Groq compat

Options: `refreshAtStartup` (default `false`). Patches the built-in `groq` provider's models/compatibility.

Command: `/groq-compat` `status|refresh|test`. The `test` probe reads `GROQ_API_KEY` (with numbered-key fallbacks) from the environment.

### Multi-router (Groq/Cohere ladders)

Keys from environment `GROQ_API_KEY[_N]`, `COHERE_API_KEY[_N]` or options `groqKeys` / `cohereKeys`. Endpoints via `groqBaseURL` / `cohereBaseURL` options or `GROQ_BASE_URL` / `COHERE_BASE_URL` environment variables.

Registers `multirouter/gpt-oss`, `multirouter/qwen`, `multirouter/command-a`, and `multirouter/command-r`.

Command: `/multi-router` and `/multi-router reset [groq|cohere]`.

## Security notes

- API keys are resolved and held in memory for provider transforms; this plugin does not write secrets to disk. Prefer `$ENV_VAR` references in config files.
- Do not commit config files containing literal keys.

## Development

```bash
bun install
bun run typecheck   # if configured
bun test            # pure/helper tests where present
```

## License

MIT
