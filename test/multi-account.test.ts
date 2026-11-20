/** Pure-logic tests for the ported helpers (no pi / no OpenCode host needed). `bun test`. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  buildGroups,
  expandSessionHeaders,
  findGroupByProvider,
  isRotatableError,
  matchAccountByLabel,
  mergeConfigs,
  nextAccount,
  resolveApiKey,
  sanitizeLabel,
  virtualProviderName,
  type MultiAccountConfig,
} from "../src/config"

const providerConfig = {
  baseUrl: "https://api.example.com/v1",
  api: "openai-completions",
  headers: { "X-Provider": "prov" },
  sessionHeaders: { "X-Session": "$sessionId" },
  models: [{ id: "m1", name: "M1" }],
  accounts: [
    { label: "Work Account!", apiKey: "k1", headers: { "X-Account": "a1" } },
    { label: "second", apiKey: "k2" },
  ],
}

const cfg: MultiAccountConfig = { providers: { acme: providerConfig } }

test("labels map to stable virtual provider slugs", () => {
  assert.equal(sanitizeLabel("Work Account!"), "work-account")
  assert.equal(virtualProviderName("acme", providerConfig.accounts[0], 0), "acme-work-account")
  assert.equal(virtualProviderName("acme", { label: "" }, 3), "acme-acc3")
})

test("config merge keeps scalar knobs and merges provider maps with last-wins", () => {
  const merged = mergeConfigs([
    { providers: { a: providerConfig }, autoRetry: true },
    { providers: { b: providerConfig }, autoSwitchOnFailure: false },
  ])
  assert.equal(merged.autoRetry, true)
  assert.equal(merged.autoSwitchOnFailure, false)
  assert.deepEqual(Object.keys(merged.providers).sort(), ["a", "b"])
})

test("buildGroups produces one account view per account with merged headers", () => {
  const groups = buildGroups(cfg)
  assert.equal(groups.length, 1)
  assert.deepEqual(
    groups[0].accounts.map((a) => a.providerID),
    ["acme-work-account", "acme-second"],
  )
  assert.deepEqual(groups[0].accounts[0].headers, { "X-Provider": "prov", "X-Account": "a1" })
  assert.equal(findGroupByProvider(groups, "acme-second")?.providerLabel, "acme")
})

test("account selection cycles and matches labels by substring", () => {
  const groups = buildGroups(cfg)
  const group = groups[0]
  assert.equal(nextAccount(group, "acme-second").providerID, "acme-work-account")
  assert.equal(nextAccount(group, "acme-work-account").providerID, "acme-second")
  assert.equal(matchAccountByLabel(group, "work")?.providerID, "acme-work-account")
  assert.equal(matchAccountByLabel(group, "SECOND")?.providerID, "acme-second")
  assert.equal(matchAccountByLabel(group, "missing"), undefined)
})

test("apiKey references resolve from env, commands and literals in memory", () => {
  process.env.MA_TEST_KEY = "from-env"
  assert.equal(resolveApiKey("$MA_TEST_KEY"), "from-env")
  assert.equal(resolveApiKey("${MA_TEST_KEY}"), "from-env")
  assert.equal(resolveApiKey("!printf command-key"), "command-key")
  assert.equal(resolveApiKey("literal-key"), "literal-key")
  assert.equal(resolveApiKey(undefined), "")
  delete process.env.MA_TEST_KEY
})

test("$sessionId headers expand without mutating config", () => {
  const expanded = expandSessionHeaders(providerConfig.sessionHeaders, "session-42")
  assert.equal(expanded["X-Session"], "session-42")
  assert.equal(providerConfig.sessionHeaders!["X-Session"], "$sessionId")
})

test("abort and service-level failures are not rotatable; quota/auth are", () => {
  assert.equal(isRotatableError({ message: "429 rate limit exceeded" }), true)
  assert.equal(isRotatableError({ message: "invalid api key" }), true)
  assert.equal(isRotatableError({ message: "Request aborted by user" }), false)
  assert.equal(isRotatableError({ message: "503 high demand", status: 503 }), false)
  assert.equal(isRotatableError({ message: "overloaded", status: 502 }), false)
})
