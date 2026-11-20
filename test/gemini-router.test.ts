// Pure logic tests ported from pi-gemini-router's smoke.ts. No network, no
// credentials, no pi/OpenCode dependencies.
// Run: bun test/router.test.ts   (or node --experimental-strip-types test/router.test.ts)
import assert from "node:assert/strict"
import {
  advanceState,
  DEFAULT_FLASH_LADDER,
  DEFAULT_FLASH_LITE_LADDER,
  geminiMajorVersion,
  isRotatableError,
  nextPacificMidnight,
  pickPair,
  quotaMarkOf,
  type RouterState,
} from "../src/router.ts"

function state(modelIndex: number, keyIndex: number, tried = 0): RouterState {
  return { modelIndex, keyIndex, epoch: 0, tried }
}
function assertEq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`)
}

// 1. First pick is the ladder head on key1.
let picked = pickPair(DEFAULT_FLASH_LADDER.length, 7, "key-first", state(0, 0), () => false)!
assertEq(`${picked.modelIndex}/${picked.keyIndex}`, "0/0", "first pick")

// 2. key-first: key advances on failure, model holds until all keys failed.
let s = state(0, 0)
for (let i = 0; i < 6; i++) s = advanceState(s, DEFAULT_FLASH_LADDER.length, 7, "key-first", 0)
assertEq(`${s.modelIndex}/${s.keyIndex}`, "0/6", "last key on the head model")
s = advanceState(s, DEFAULT_FLASH_LADDER.length, 7, "key-first", 0)
assertEq(`${s.modelIndex}/${s.keyIndex}`, "1/0", "model advances only after all keys failed")
assertEq(s.tried, 7, "tried counts the pairs walked")

// 3. model-first: walk the ladder on one key before moving to the next.
let m = state(0, 0)
m = advanceState(m, 2, 2, "model-first", 0)
assertEq(`${m.modelIndex}/${m.keyIndex}`, "1/0", "model-first advances the model first")
m = advanceState(m, 2, 2, "model-first", 0)
assertEq(`${m.modelIndex}/${m.keyIndex}`, "0/1", "model-first wraps to the next key")

// 4. Dead/unavailable pairs are skipped; all-dead falls back to a held pair.
const dead = (mi: number, ki: number) => mi === 0 && ki < 3
picked = pickPair(3, 5, "key-first", state(0, 0), dead)!
assertEq(`${picked.modelIndex}/${picked.keyIndex}`, "0/3", "dead pairs skipped")
const allDead = pickPair(2, 3, "key-first", state(0, 0), () => true)!
assertEq(`${allDead.modelIndex}/${allDead.keyIndex}`, "0/0", "fully dead falls back, never throws")

// 5. Flash-lite ladder shape and skip of a key missing a model.
picked = pickPair(DEFAULT_FLASH_LITE_LADDER.length, 7, "key-first", state(0, 2), (_mi, ki) => ki === 2)!
assertEq(`${picked.modelIndex}/${picked.keyIndex}`, "0/3", "missing pair skipped")

// 6. Rotatable error classification.
assert(isRotatableError("429 RESOURCE_EXHAUSTED quota"), "quota rotates")
assert(isRotatableError("400 Function call is missing a thought_signature"), "signature 400 rotates")
assert(isRotatableError("models/gemini-4-hydrogen is not found for API version v1beta"), "404 rotates")
assert(isRotatableError("API key not valid"), "bad key rotates")
assert(!isRotatableError("exceeds the maximum context length"), "context overflow does not rotate")
assert(!isRotatableError(""), "empty does not rotate")

// 7. Quota classification.
assertEq(quotaMarkOf("429 ... GenerateRequestsPerDayPerProjectPerModel requests per day")?.kind, "rpd", "RPD mark")
assertEq(quotaMarkOf("429 ... tokens per minute limit. Please retry in 33.81s.")?.kind, "minute", "minute mark")
assertEq(quotaMarkOf("429 You exceeded your current quota")?.kind, "suspected", "suspected mark")
assertEq(quotaMarkOf("plain network error"), undefined, "non-quota error unmarked")
const minute = quotaMarkOf("429 Please retry in 33s.")!
assert(minute.until - Date.now() <= 120_000, "minute cooldown capped")

// 8. Misc helpers.
assert(nextPacificMidnight(Date.now()) > Date.now(), "next midnight is in the future")
assertEq(geminiMajorVersion("gemini-3.5-flash"), 3, "gemini major version")
assertEq(geminiMajorVersion("gemma-3"), undefined, "non-gemini id")

console.log("OK — ladder, rotation, skip/fallback, error and quota classification all pass")
