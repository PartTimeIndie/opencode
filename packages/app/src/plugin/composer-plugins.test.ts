import { expect, test } from "bun:test"
import { createComposerRegistry } from "./composer-registry"
import type { AppHostComposerTarget, AppHostComposerBeforeSubmitHandler } from "@opencode-ai/plugin/app"

const target = { directory: "C:/project", sessionID: "session-a", composerID: "composer-a" }
const agent = { getAgent: () => "default", canSetAgent: () => false, setAgent: () => false }

async function fixture(name: string, response = Promise.resolve({ ok: true, text: "improved" })) {
  const plugin = await import(new URL(`../../../../.opencode/plugin-sources/${name}/index.js`, import.meta.url).href)
  const registry = createComposerRegistry()
  const controller = new AbortController()
  const state = { text: "initial", mode: "normal" as "normal" | "shell" }
  const values = new Map<string, unknown>()
  const sessionMetadata: Record<string, unknown> = {}
  const invoked = Promise.withResolvers<void>()
  const applied = Promise.withResolvers<boolean>()
  const element = document.createElement("section")
  const dispose = registry.register(
    { ...target, serverID: "test" },
    {
      read: () => ({ ...target, ...state }),
      change: (text) => {
        state.text = text
      },
      insertText: () => ({ ok: true }),
      submitText: async () => ({ ok: true }),
    },
  )
  let mount: (context: {
    element: HTMLElement
    context: AppHostComposerTarget
    signal: AbortSignal
  }) => () => void = () => {
    throw new Error("Plugin did not register a toolbar mount")
  }
  plugin.default.app({
    signal: controller.signal,
    client: {
      global: { config: { get: async () => ({ data: {} }) } },
      session: {
        get: async () => ({ data: { metadata: { ...sessionMetadata } } }),
        update: async (input: { metadata?: Record<string, unknown> }) => {
          Object.keys(sessionMetadata).forEach((key) => delete sessionMetadata[key])
          Object.assign(sessionMetadata, input.metadata)
          return { data: { metadata: { ...sessionMetadata } } }
        },
      },
    },
    toolbar: {
      register(item: { mount: typeof mount }) {
        mount = item.mount
        return () => {}
      },
    },
    kv: {
      get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
      set: (key: string, value: unknown) => values.set(key, value),
    },
    settings: {
      get: (_key: string, fallback: unknown) => fallback,
      register: () => () => {},
      subscribe: () => () => {},
    },
    host: {
      composer: {
        read: (input: AppHostComposerTarget) => registry.read({ ...input, serverID: "test" }),
        change(input: AppHostComposerTarget & { text: string; expectedText?: string }) {
          const result = registry.change({ ...input, serverID: "test" })
          applied.resolve(result.ok)
          return result
        },
        beforeSubmit: (input: AppHostComposerTarget, handler: AppHostComposerBeforeSubmitHandler) =>
          registry.beforeSubmit({ ...input, serverID: "test" }, handler, controller.signal),
      },
      ai: {
        run: () => {
          invoked.resolve()
          return response
        },
      },
    },
  })
  const unmount = mount({ element, context: target, signal: controller.signal })
  const button = element.querySelector("button")!
  return {
    registry,
    state,
    sessionMetadata,
    element,
    button,
    invoked: invoked.promise,
    applied: applied.promise,
    submit: () => registry.runBeforeSubmit({ ...target, serverID: "test" }, agent),
    dispose() {
      controller.abort()
      unmount()
      dispose()
    },
  }
}

test.each([
  ["multi-agent-review-app", "/multi-agent-review"],
  ["multi-agent-problem-solver-app", "/multi-agent-problem-solver"],
  ["progressive-plan-builder-app", "/progressive-plan-builder"],
  ["visual-qa-app", "/visual-qa-testing"],
])("%s appends its skill once without any composer DOM ancestor", async (name, skill) => {
  const view = await fixture(name!)
  const other = { ...target, composerID: "other", serverID: "test" }
  const removeOther = view.registry.register(other, {
    read: () => ({ ...other, mode: "normal", text: "other draft" }),
    change() {
      throw new Error("Wrong composer was amended")
    },
    insertText: () => ({ ok: false }),
    submitText: async () => ({ ok: false }),
  })
  expect(view.element.closest("form")).toBeNull()
  view.button.click()
  expect((await view.registry.runBeforeSubmit(other, agent)).ok).toBe(true)
  expect(view.state.text).toBe("initial")
  view.state.mode = "shell"
  await view.submit()
  expect(view.state.text).toBe("initial")
  view.state.mode = "normal"
  expect((await view.submit()).ok).toBe(true)
  expect(view.state.text).toBe(`initial\n\n${skill}`)
  await view.submit()
  expect(view.state.text).toBe(`initial\n\n${skill}`)
  view.button.click()
  view.dispose()
  removeOther()
})

test("Goal reads and changes only its named composer outside a form", async () => {
  const view = await fixture("goal-app")
  view.button.click()
  expect(view.state.text).toBe("/goal initial")
  view.button.click()
  expect(view.state.text).toBe("/goal initial")
  view.dispose()
})

test("Goal leaves submit ownership to the central composer flow", async () => {
  const view = await fixture("goal-app")
  view.button.click()
  expect((await view.submit()).ok).toBe(true)
  expect(view.sessionMetadata).toEqual({})
  view.dispose()
})

test.each([false, true])("Prompt Improve applies through compare-and-set (draft edited: %s)", async (edited) => {
  const response = Promise.withResolvers<{ ok: boolean; text: string }>()
  const view = await fixture("prompt-improve-app", response.promise)
  view.button.click()
  await view.invoked
  if (edited) view.registry.change({ ...target, serverID: "test", text: "new user text" })
  response.resolve({ ok: true, text: "improved draft" })
  expect(await view.applied).toBe(!edited)
  expect(view.state.text).toBe(edited ? "new user text" : "improved draft")
  view.dispose()
})
