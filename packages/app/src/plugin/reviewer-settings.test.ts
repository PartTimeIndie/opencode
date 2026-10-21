import { expect, test } from "bun:test"
import type { AppSettingsItem } from "@opencode-ai/plugin/app"
import { updatePluginSetting } from "../components/settings-v2/plugin-setting-values"

for (const key of ["review", "problem_solver"]) {
  test(`${key} serializes nested edits and reset against the latest persisted reviewer tree`, async () => {
    const name = key === "review" ? "multi-agent-review-app" : "multi-agent-problem-solver-app"
    const plugin = await import(new URL(`../../../../.opencode/plugin-sources/${name}/settings.js`, import.meta.url).href)
    const config = { multi_agent: { [key]: { reviewers: [{ model: "test/first", variant: "high" }, { model: "test/second", variant: "high" }] } } }
    let item: AppSettingsItem | undefined
    let gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
    const result = plugin.registerReviewerSettings({ signal: new AbortController().signal,
      client: { global: { config: {
        async get() { return { data: structuredClone(config) } },
        async update(input: { configUpdate: typeof config }) {
          gate.started.resolve()
          await gate.release.promise
          config.multi_agent = { ...config.multi_agent, ...structuredClone(input.configUpdate.multi_agent) }
        },
      } } },
      settings: { register(value: AppSettingsItem) { item = value; return () => {} } },
      ui: { models: { resolve: () => ({ providerID: "test", id: "default" }) } },
    }, key, "Checks", "/checks")
    await result.ready
    const storage = item!.storage!
    const first = storage.update("reviewers", (current) => updatePluginSetting(current, [0, "selection", "model"], "test/changed"))
    await gate.started.promise
    const second = storage.update("reviewers", (current) => updatePluginSetting(current, [1, "selection", "variant"], "low"))
    gate.release.resolve()
    await Promise.all([first, second])
    expect(config.multi_agent[key]!.reviewers).toEqual([{ model: "test/changed", variant: "high" }, { model: "test/second", variant: "low" }])
    expect(storage.read("reviewers", [])).toEqual(config.multi_agent[key]!.reviewers.map((selection) => ({ selection })))
    gate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
    const reset = item!.sections[0]!.actions![0]!.run()
    await gate.started.promise
    const edit = storage.update("reviewers", (current) => updatePluginSetting(current, [0, "selection", "variant"], "medium"))
    gate.release.resolve()
    await Promise.all([reset, edit])
    expect(config.multi_agent[key]!.reviewers).toEqual([{ model: "zhipuai-coding-plan/glm-5.3", variant: "medium" }, { model: "openai/gpt-6.1-sol", variant: "high" }])
  })

  test(`${key} plugin preserves configured models, variants and unrelated settings`, async () => {
    const name = key === "review" ? "multi-agent-review-app" : "multi-agent-problem-solver-app"
    const plugin = await import(new URL(`../../../../.opencode/plugin-sources/${name}/settings.js`, import.meta.url).href)
    const signal = new AbortController()
    let config = { multi_agent: { max_threads: 7, [key]: { extra: "preserved", reviewers: [{ model: "test/first", variant: "high" }] }, other: { reviewers: [{ model: "test/other" }] } } }
    let item: AppSettingsItem | undefined
    let disposed = 0
    let notifications = 0
    const initial = Promise.withResolvers<void>()
    let reads = 0
    const result = plugin.registerReviewerSettings({
      signal: signal.signal,
      client: { global: { config: {
        async get() { if (++reads === 1) await initial.promise; return { data: structuredClone(config) } },
        async update(input: { configUpdate: typeof config }) { config.multi_agent = { ...config.multi_agent, ...structuredClone(input.configUpdate.multi_agent) } },
      } } },
      settings: { register(value: AppSettingsItem) { item = value; return () => disposed++ } },
      ui: { models: { resolve: () => ({ providerID: "test", id: "default" }) } },
    }, key, "Checks", "/checks")
    const storage = item!.storage!
    storage.subscribe(() => notifications++)
    const write = storage.write("reviewers", [{ selection: { model: "test/next", variant: "low" } }])
    initial.resolve()
    await result.ready
    await write
    expect(storage.read("reviewers", [])).toEqual([{ selection: { model: "test/next", variant: "low" } }])
    expect(config.multi_agent[key]).toEqual({ extra: "preserved", reviewers: [{ model: "test/next", variant: "low" }] })
    expect(config.multi_agent.max_threads).toBe(7)
    expect(config.multi_agent.other.reviewers).toEqual([{ model: "test/other" }])
    expect(item!.searchEntries!()[0]!.keywords).toContain("test/next")
    const field = item!.sections[0]!.fields[0]!
    expect(field.type).toBe("list")
    if (field.type !== "list") throw new Error("Expected list")
    expect(field.minItems).toBe(key === "review" ? 0 : 1)
    expect(field.createItem!([])).toEqual({ selection: { model: "test/default" } })
    if (key === "review") {
      await storage.write("reviewers", [])
      expect(storage.read("reviewers", [{ selection: { model: "stale/snapshot" } }])).toEqual([])
    } else {
      await expect(Promise.resolve(storage.write("reviewers", []))).rejects.toThrow("Choose a provider model")
    }
    await item!.sections[0]!.actions![0]!.run()
    expect(config.multi_agent[key]).toMatchObject({ extra: "preserved", reviewers: [
      { model: "zhipuai-coding-plan/glm-5.3" }, { model: "openai/gpt-6.1-sol", variant: "high" },
    ] })
    signal.abort()
    expect(disposed).toBe(1)
    expect(notifications).toBe(key === "review" ? 4 : 3)
    await expect(Promise.resolve(storage.write("reviewers", [{ selection: { model: "test/late" } }]))).rejects.toThrow("unloaded")
  })
}

test("multi-agent review settings save, invalidate and reload all six reviewers", async () => {
  const plugin = await import(
    new URL("../../../../.opencode/plugin-sources/multi-agent-review-app/settings.js", import.meta.url).href
  )
  const reviewers: Array<{ model: string; variant?: string }> = Array.from(
    { length: 6 },
    (_, index) => ({ model: `test/reviewer-${index + 1}` }),
  )
  const config = { multi_agent: { review: { reviewers } } }
  const signal = new AbortController()
  let item: AppSettingsItem | undefined
  let notifications = 0
  const result = plugin.registerReviewerSettings(
    {
      signal: signal.signal,
      client: {
        global: {
          config: {
            async get() {
              return { data: structuredClone(config) }
            },
            async update(input: { configUpdate: typeof config }) {
              config.multi_agent = { ...config.multi_agent, ...structuredClone(input.configUpdate.multi_agent) }
            },
          },
        },
      },
      settings: { register(value: AppSettingsItem) { item = value; return () => {} } },
      ui: { models: { resolve: () => ({ providerID: "test", id: "default" }) } },
    },
    "review",
    "Checks",
    "/checks",
  )
  await result.ready
  const storage = item!.storage!
  storage.subscribe(() => notifications++)

  expect(storage.read("reviewers", [])).toHaveLength(6)
  await storage.update("reviewers", (current) => updatePluginSetting(current, [5, "selection", "variant"], "low"))
  expect(config.multi_agent.review.reviewers).toHaveLength(6)
  expect(config.multi_agent.review.reviewers.at(-1)).toEqual({ model: "test/reviewer-6", variant: "low" })
  expect(storage.read("reviewers", [])).toHaveLength(6)
  expect(notifications).toBe(1)

  signal.abort()
  const reloadedSignal = new AbortController()
  let reloadedItem: AppSettingsItem | undefined
  const reloaded = plugin.registerReviewerSettings(
    {
      signal: reloadedSignal.signal,
      client: {
        global: {
          config: {
            async get() {
              return { data: structuredClone(config) }
            },
            async update(input: { configUpdate: typeof config }) {
              config.multi_agent = { ...config.multi_agent, ...structuredClone(input.configUpdate.multi_agent) }
            },
          },
        },
      },
      settings: { register(value: AppSettingsItem) { reloadedItem = value; return () => {} } },
      ui: { models: { resolve: () => ({ providerID: "test", id: "default" }) } },
    },
    "review",
    "Checks",
    "/checks",
  )
  await reloaded.ready
  expect(reloadedItem!.storage!.read("reviewers", [])).toHaveLength(6)
  expect(reloadedItem!.storage!.read("reviewers", [])).toEqual(
    config.multi_agent.review.reviewers.map((selection) => ({ selection })),
  )
  reloadedSignal.abort()
})

test("multi-agent review settings don't restore fixed reviewers when none are configured", async () => {
  const plugin = await import(
    new URL("../../../../.opencode/plugin-sources/multi-agent-review-app/settings.js", import.meta.url).href
  )
  const config: {
    model?: string
    multi_agent: { review?: { reviewers?: Array<{ model: string; variant?: string }> } }
  } = {
    model: "test/base-model",
    multi_agent: {},
  }
  const signal = new AbortController()
  let item: AppSettingsItem | undefined
  let writes = 0
  const result = plugin.registerReviewerSettings(
    {
      signal: signal.signal,
      client: {
        global: {
          config: {
            async get() {
              return { data: structuredClone(config) }
            },
            async update(input: { configUpdate: typeof config }) {
              writes++
              config.multi_agent = { ...config.multi_agent, ...structuredClone(input.configUpdate.multi_agent) }
            },
          },
        },
      },
      settings: { register(value: AppSettingsItem) { item = value; return () => {} } },
      ui: {
        models: {
          resolve(target: string) {
            if (target === "default") return
            if (target === config.model) return { providerID: "test", id: "base-model" }
          },
        },
      },
    },
    "review",
    "Checks",
    "/checks",
  )
  await result.ready
  const storage = item!.storage!
  expect(storage.read("reviewers", [{ selection: { model: "stale/snapshot" } }])).toEqual([])
  expect(writes).toBe(0)
  const reviewersField = item!.sections[0]!.fields[0]!
  if (reviewersField.type !== "list") throw new Error("Expected reviewer list")
  expect(reviewersField.createItem!([])).toEqual({ selection: { model: "test/base-model" } })

  await storage.write("reviewers", [])
  expect(config.multi_agent.review?.reviewers).toEqual([])
  expect(storage.read("reviewers", [{ selection: { model: "stale/snapshot" } }])).toEqual([])
  expect(writes).toBe(1)
  signal.abort()
})
