/**
 * Shared configuration + pure helpers for the OpenCode multi-account plugin.
 *
 * This module never writes to disk. It only reads user-owned JSON config files
 * and resolves key references into memory. API keys are deliberately kept as
 * plain strings in memory (see `resolveKeys`); they are never persisted by the
 * plugin, logged, or embedded in a file.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AccountConfig {
  label: string
  /** `$ENV_VAR`, `${ENV_VAR}`, `!command`, or a literal value. */
  apiKey?: string
  headers?: Record<string, string>
}

export interface ModelConfig {
  id: string
  name?: string
  reasoning?: boolean
  input?: string[]
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  contextWindow?: number
  maxTokens?: number
  thinkingLevelMap?: Record<string, string | null>
}

export interface ProviderAccountConfig {
  name?: string
  baseUrl: string
  api: string
  /** Explicit `@opencode/ai/providers/...` package; overrides the `api` mapping. */
  package?: string
  accounts: AccountConfig[]
  models?: ModelConfig[]
  modelUrl?: string
  headers?: Record<string, string>
  authHeader?: boolean
  sessionHeaders?: Record<string, string>
  compat?: Record<string, unknown>
}

export interface MultiAccountConfig {
  providers: Record<string, ProviderAccountConfig>
  cycleShortcut?: string
  autoSwitchOnFailure?: boolean
  autoRetry?: boolean
}

export interface AccountView {
  index: number
  label: string
  /** Virtual OpenCode provider ID, e.g. `opencode-primary`. */
  providerID: string
  headers: Record<string, string>
}

export interface AccountGroup {
  providerName: string
  providerLabel: string
  baseUrl: string
  api: string
  package?: string
  accounts: AccountView[]
  models: ModelConfig[]
  modelUrl?: string
  sessionHeaders?: Record<string, string>
  compat?: Record<string, unknown>
  authHeader?: boolean
}

const OPENAI_COMPATIBLE = "@opencode/ai/providers/openai-compatible"
const API_PACKAGES: Record<string, string> = {
  "openai-completions": OPENAI_COMPATIBLE,
  "openai-compatible": OPENAI_COMPATIBLE,
  "openai-responses": "@opencode/ai/providers/openai",
  "openai-codex-responses": "@opencode/ai/providers/openai",
  anthropic: "@opencode/ai/providers/anthropic",
  "anthropic-messages": "@opencode/ai/providers/anthropic",
  google: "@opencode/ai/providers/google",
  "google-generative-ai": "@opencode/ai/providers/google",
}

export function mapApiToPackage(api: string | undefined, override?: string): string {
  if (override) return override
  return API_PACKAGES[(api ?? "").toLowerCase()] ?? OPENAI_COMPATIBLE
}

export function sanitizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function virtualProviderName(providerName: string, account: AccountConfig, index: number): string {
  const slug = sanitizeLabel(account.label ?? "")
  return slug ? `${providerName}-${slug}` : `${providerName}-acc${index}`
}

function readJson(path: string): MultiAccountConfig | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MultiAccountConfig
  } catch (e) {
    console.error(`[multi-account] Failed to load ${path}`, e)
    return undefined
  }
}

/** Config file locations, in merge order (last wins). */
export function configPaths(directory: string): string[] {
  const home = homedir()
  return [
    join(home, ".config", "opencode", "multi-account.json"),
    join(directory, ".opencode", "multi-account.json"),
  ]
}

export function mergeConfigs(configs: Array<MultiAccountConfig | undefined>): MultiAccountConfig {
  const merged: MultiAccountConfig = { providers: {} }
  for (const cfg of configs) {
    if (!cfg) continue
    const previousProviders = merged.providers
    Object.assign(merged, cfg)
    merged.providers = { ...previousProviders, ...(cfg.providers ?? {}) }
    if (cfg.cycleShortcut) merged.cycleShortcut = cfg.cycleShortcut
  }
  merged.providers ??= {}
  return merged
}

/** Load config from disk and overlay plugin options (passed via `opencode.json(c)`). */
export function loadConfig(directory: string, options?: Record<string, any>): MultiAccountConfig {
  const fromDisk = configPaths(directory).map(readJson)
  const optionConfig =
    options && typeof options === "object"
      ? ((options.config && typeof options.config === "object" ? options.config : options) as MultiAccountConfig)
      : undefined
  const merged = mergeConfigs([...fromDisk, optionConfig])
  merged.cycleShortcut ??= "alt+a"
  return merged
}

/** Build the secret-free account index shared by the server and TUI parts. */
export function buildGroups(cfg: MultiAccountConfig): AccountGroup[] {
  const groups: AccountGroup[] = []
  for (const [providerName, pc] of Object.entries(cfg.providers ?? {})) {
    if (!pc?.accounts?.length) continue
    if (!pc.modelUrl && !pc.models?.length) continue
    const accounts: AccountView[] = pc.accounts.map((account, index) => ({
      index,
      label: account.label,
      providerID: virtualProviderName(providerName, account, index),
      headers: { ...(pc.headers ?? {}), ...(account.headers ?? {}) },
    }))
    groups.push({
      providerName,
      providerLabel: pc.name || providerName,
      baseUrl: pc.baseUrl,
      api: pc.api,
      package: pc.package,
      accounts,
      models: pc.models ?? [],
      modelUrl: pc.modelUrl,
      sessionHeaders: pc.sessionHeaders,
      compat: pc.compat,
      authHeader: pc.authHeader,
    })
  }
  return groups
}

/** Resolve every account key into an in-memory map keyed by virtual provider ID. */
export function resolveKeys(cfg: MultiAccountConfig, groups: AccountGroup[]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const group of groups) {
    const accounts = cfg.providers[group.providerName]?.accounts ?? []
    group.accounts.forEach((view, i) => {
      keys.set(view.providerID, resolveApiKey(accounts[i]?.apiKey))
    })
  }
  return keys
}

/** `$VAR`, `${VAR}`, `!command` or literal. Resolved only in memory. */
export function resolveApiKey(raw: string | undefined): string {
  if (!raw) return ""
  const value = raw.trim()
  const env = /^\$\{([^}]+)\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value)
  if (env) return process.env[env[1]] ?? ""
  if (value.startsWith("!")) {
    try {
      return execFileSync("sh", ["-c", value.slice(1)], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch (e) {
      console.error("[multi-account] apiKey command failed", e)
      return ""
    }
  }
  return value
}

export function findGroupByProvider(groups: AccountGroup[], providerID: string): AccountGroup | undefined {
  return groups.find((g) => g.accounts.some((a) => a.providerID === providerID))
}

export function findAccount(group: AccountGroup, providerID: string): AccountView | undefined {
  return group.accounts.find((a) => a.providerID === providerID)
}

export function nextAccount(group: AccountGroup, providerID: string): AccountView {
  const current = Math.max(0, group.accounts.findIndex((a) => a.providerID === providerID))
  return group.accounts[(current + 1) % group.accounts.length]
}

export function matchAccountByLabel(group: AccountGroup, query: string): AccountView | undefined {
  const q = query.toLowerCase()
  return (
    group.accounts.find((a) => a.label.toLowerCase() === q) ??
    group.accounts.find((a) => a.label.toLowerCase().includes(q))
  )
}

export function expandSessionHeaders(
  headers: Record<string, string> | undefined,
  sessionID: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = value === "$sessionId" ? sessionID : value
  }
  return out
}

const ABORT_PATTERNS = ["aborted", "cancelled", "canceled", "interrupted", "user abort"]
const SERVICE_LEVEL_PATTERN =
  /\b(?:503|502|504)\b|unavailable|high demand|overloaded|internal server error/i

/** Rotating accounts cannot help with user aborts or service/model-level 5xx. */
export function isRotatableError(error: { type?: string; message?: string; status?: number }): boolean {
  const text = `${error.type ?? ""} ${error.message ?? ""}`.toLowerCase()
  if ([502, 503, 504].includes(error.status ?? 0)) return false
  if (ABORT_PATTERNS.some((pattern) => text.includes(pattern))) return false
  if (SERVICE_LEVEL_PATTERN.test(text)) return false
  return true
}

/** Number of virtual providers registered across all groups. */
export function accountCount(groups: AccountGroup[]): number {
  return groups.reduce((total, g) => total + g.accounts.length, 0)
}
