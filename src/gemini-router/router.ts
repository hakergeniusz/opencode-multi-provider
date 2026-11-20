/**
 * Pure routing / quota helpers for opencode-gemini-router.
 *
 * This module has no dependency on OpenCode or on the pi runtime, so the
 * rotation and quota-classification logic can be unit tested on its own.
 * Treat every string passed to these helpers as untrusted data.
 */

export type AdvanceOrder = "key-first" | "model-first"
export type QuotaKind = "rpd" | "minute" | "suspected"

export interface QuotaMark {
  kind: QuotaKind
  /** Epoch ms until which the pair is considered dead. */
  until: number
}

export type QuotaMarks = Record<string, QuotaMark>

export interface RouterState {
  /** Index into the ladder. */
  modelIndex: number
  /** Index into the configured API keys. */
  keyIndex: number
  /** Bumped by the reset command; a mismatch restarts the walk. */
  epoch: number
  /** Number of (model, key) pairs that have failed in the current walk. */
  tried: number
}

/** Newest first. `-latest` aliases sit right behind the newest concrete model. */
export const DEFAULT_FLASH_LADDER = [
  "gemini-4-hydrogen",
  "gemini-flash-latest",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
]

export const DEFAULT_FLASH_LITE_LADDER = [
  "gemini-flash-lite-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
]

/** Free-tier TPM is 250K per project/model; advertise that so long sessions compact early. */
export const FLASH_CONTEXT_WINDOW = 250_000
export const FLASH_MAX_TOKENS = 65_536

export const SUSPECTED_RPD_TTL_MS = 30 * 60 * 1000
export const MINUTE_COOLDOWN_DEFAULT_MS = 75 * 1000
export const MINUTE_COOLDOWN_MAX_MS = 120 * 1000

export function pairKey(modelId: string, keyId: string): string {
  return modelId + "|" + keyId
}

export function ladderLabel(ladder: readonly string[]): string {
  return ladder.join(" → ")
}

/** Wall-clock offset of America/Los_Angeles at the given epoch (ms). */
export function pacificOffsetMs(epochMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(new Date(epochMs))) parts[p.type] = p.value
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  )
  return asUTC - Math.floor(epochMs / 1000) * 1000
}

/** Epoch ms of the next 00:00 in America/Los_Angeles (free-tier RPD reset). */
export function nextPacificMidnight(epochMs: number): number {
  const offset = pacificOffsetMs(epochMs)
  const wall = epochMs + offset
  const nextDayWall = Math.floor(wall / 86_400_000) * 86_400_000 + 86_400_000
  return nextDayWall - offset
}

/** Classify a 429/quota error into a mark, or undefined when not quota-flavored. */
export function quotaMarkOf(errorMessage: string): QuotaMark | undefined {
  if (!/429|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests/i.test(errorMessage)) return undefined
  const now = Date.now()
  // Daily buckets first: they outrank any retry hint inside the same body.
  if (/PerDay|requests? per day|RequestsPerDay/i.test(errorMessage)) {
    return { kind: "rpd", until: nextPacificMidnight(now) }
  }
  if (/per minute|PerMinute/i.test(errorMessage)) {
    return { kind: "minute", until: now + MINUTE_COOLDOWN_DEFAULT_MS }
  }
  // Google usually says how long the per-minute window needs: "Please retry in 33.81s".
  const retryIn = errorMessage.match(/retry in ([0-9.]+)\s*s/i)
  if (retryIn) {
    const ms = Math.min(MINUTE_COOLDOWN_MAX_MS, Math.max(5000, Number(retryIn[1]) * 1000 + 3000))
    return { kind: "minute", until: now + ms }
  }
  return { kind: "suspected", until: now + SUSPECTED_RPD_TTL_MS }
}

/** Humanized remaining time for status output. */
export function remainingLabel(mark: QuotaMark): string {
  const leftMs = mark.until - Date.now()
  const mins = Math.max(0, Math.round(leftMs / 60_000))
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m left`
  return `${mins}m left`
}

const ROTATABLE_ERROR_PATTERN =
  /429|RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests|high demand|UNAVAILABLE|503|500|502|504|overloaded/i
const PAIR_SPECIFIC_ERROR_PATTERN =
  /\b400\b|INVALID_ARGUMENT|NOT_FOUND|FAILED_PRECONDITION|thought_signature|not found|not supported/i
const NON_ROTATABLE_ERROR_PATTERN =
  /exceeds the maximum|token limit|input token|context length|request too large|payload too large|too many tokens/i

/** Whether the failure is worth trying another (model, key) pair for. */
export function isRotatableError(errorMessage: string): boolean {
  if (!errorMessage) return false
  // An invalid key is a permanent per-key problem: rotating the key is the fix.
  if (/API[_ ]KEY[_ ]INVALID|API key not valid|PERMISSION_DENIED|401|403/i.test(errorMessage)) return true
  if (NON_ROTATABLE_ERROR_PATTERN.test(errorMessage)) return false
  return ROTATABLE_ERROR_PATTERN.test(errorMessage) || PAIR_SPECIFIC_ERROR_PATTERN.test(errorMessage)
}

/** Gemini major version, or undefined for non-gemini ids. */
export function geminiMajorVersion(modelId: string): number | undefined {
  const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/)
  return match ? Number.parseInt(match[1], 10) : undefined
}

/** Linear index of a (model, key) pair in the configured advance order. */
export function pairIndex(
  modelIndex: number,
  keyIndex: number,
  ladderLength: number,
  keyCount: number,
  order: AdvanceOrder,
): number {
  return order === "model-first"
    ? keyIndex * ladderLength + modelIndex
    : modelIndex * keyCount + keyIndex
}

/** Advance the (model, key) pair by one step. */
export function advanceState(
  state: RouterState,
  ladderLength: number,
  keyCount: number,
  order: AdvanceOrder,
  epoch: number,
): RouterState {
  const total = Math.max(1, ladderLength * keyCount)
  const from = pairIndex(state.modelIndex, state.keyIndex, ladderLength, keyCount, order)
  const next = (from + 1) % total
  return {
    modelIndex: order === "model-first" ? next % ladderLength : Math.floor(next / keyCount) % ladderLength,
    keyIndex: order === "model-first" ? Math.floor(next / ladderLength) % keyCount : next % keyCount,
    epoch,
    tried: (state.tried ?? 0) + 1,
  }
}

/**
 * First usable pair from the current position, or a fallback pair when every
 * pair is marked dead/unavailable. A dead-pair fallback must never brick the
 * router: stale marks are allowed to be probed again.
 */
export function pickPair(
  ladderLength: number,
  keyCount: number,
  order: AdvanceOrder,
  state: Pick<RouterState, "modelIndex" | "keyIndex">,
  isUnusable: (modelIndex: number, keyIndex: number) => boolean,
): { modelIndex: number; keyIndex: number } | undefined {
  if (ladderLength < 1 || keyCount < 1) return undefined
  const total = ladderLength * keyCount
  const from = pairIndex(state.modelIndex, state.keyIndex, ladderLength, keyCount, order)
  let fallback: { modelIndex: number; keyIndex: number } | undefined
  for (let step = 0; step < total; step++) {
    const idx = (from + step) % total
    const modelIndex = order === "model-first"
      ? idx % ladderLength
      : Math.floor(idx / keyCount) % ladderLength
    const keyIndex = order === "model-first"
      ? Math.floor(idx / ladderLength) % keyCount
      : idx % keyCount
    if (!fallback) fallback = { modelIndex, keyIndex }
    if (isUnusable(modelIndex, keyIndex)) continue
    return { modelIndex, keyIndex }
  }
  return fallback
}
