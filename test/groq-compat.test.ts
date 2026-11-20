/**
 * Port of the original pi-groq-compat smoke test.
 *
 * Stubs the OpenCode V2 plugin context surface that this plugin touches and
 * asserts that loading it registers the groq provider with the compat fix and
 * the curated model list, plus the /groq-compat command.
 *
 * Run with `bun test test/` after `bun install` (needs @opencode/plugin).
 */
import { expect, test } from "bun:test"
import plugin from "../src/index.ts"

interface AddedProvider {
  info: {
    name: string
    package: string
    activation: string
    settings?: Record<string, unknown>
    compatibility?: Record<string, unknown>
  }
  models: Array<{
    modelID?: string
    id?: string
    name?: string
    limit?: { context: number; output: number }
    compatibility?: Record<string, unknown>
  }>
}

async function load(existingGroq: unknown = undefined) {
  const added: AddedProvider[] = []
  const updates: Array<{ id: string; fn: (p: any) => void }> = []
  const setModels: Array<{ id: string; models: unknown[] }> = []
  const commands: Array<{ name: string; description?: string }> = []

  const providerEditor = {
    get: (_id: string) => existingGroq,
    add: (input: AddedProvider) => added.push(input),
    update: (id: string, fn: (p: any) => void) => updates.push({ id, fn }),
    models: {
      set: (id: string, models: unknown[]) => setModels.push({ id, models }),
      update: () => {},
      remove: () => {},
    },
  }

  const ctx = {
    options: {},
    provider: {
      transform: async (cb: (e: typeof providerEditor) => void) => cb(providerEditor),
      reload: async () => {},
      get: async () => ({ models: new Map() }),
    },
    command: {
      transform: async (cb: (e: { add: (c: any) => void }) => void) =>
        cb({ add: (c) => commands.push(c) }),
    },
    session: {
      get: async () => ({}),
      synthetic: async () => ({}),
    },
  }

  await (plugin as any).setup(ctx as any)
  return { added, updates, setModels, commands }
}

test("registers the groq provider with max_tokens compat and a curated model list", async () => {
  const { added, commands } = await load()
  expect(added.length).toBe(1)

  const groq = added[0]
  expect((groq.info.settings as any)?.baseURL).toBe("https://api.groq.com/openai/v1")
  expect(groq.info.compatibility?.maxTokensField).toBe("max_tokens")
  expect(groq.models.length).toBeGreaterThan(0)

  for (const model of groq.models) {
    expect(model.compatibility?.maxTokensField).toBe("max_tokens")
    expect(model.limit!.context).toBeGreaterThan(0)
    expect(model.limit!.output).toBeGreaterThan(0)
  }

  const ids = groq.models.map((m) => m.modelID ?? m.id)
  expect(ids).toContain("qwen/qwen3.8-27b")
  expect(ids).toContain("allam-2-7b")
  expect(ids).not.toContain("whisper-large-v3")
  expect(ids).not.toContain("llama-3.1-8b-instant")

  expect(commands.map((c) => c.name)).toContain("groq-compat")
})

test("patches the built-in groq provider in place when present", async () => {
  const { added, updates, setModels } = await load({ info: {}, models: new Map() })
  expect(added.length).toBe(0)
  expect(updates.length).toBe(1)
  expect(updates[0].id).toBe("groq")
  expect(setModels.length).toBe(1)
  expect(setModels[0].id).toBe("groq")

  const draft: any = { compatibility: undefined }
  updates[0].fn(draft)
  expect(draft.compatibility.maxTokensField).toBe("max_tokens")
})
