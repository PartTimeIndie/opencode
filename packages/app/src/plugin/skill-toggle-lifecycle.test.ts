import { expect, test } from "bun:test"
import { createAppendOnSubmitStore, createToolbarFinalAppend, appendOnSubmitTarget } from "./append-on-submit"
import { createComposerRegistry } from "./composer-registry"

const target = { serverID: "server", directory: "C:/project", sessionID: "session-a", composerID: "session-a" }
const agent = { getAgent: () => undefined, canSetAgent: () => false, setAgent: () => false }

test.each([
  ["visual-qa-app", "/visual-qa-testing"],
  ["multi-agent-review-app", "/multi-agent-review"],
  ["progressive-plan-builder-app", "/progressive-plan-builder"],
])("%s preserves its selection for the same composer and consumes it only on admission", async (id, token) => {
  const plugin = await import(new URL(`../../../../.opencode/plugin-sources/${id}/index.js`, import.meta.url).href)
  let item: Parameters<typeof appendOnSubmitTarget>[0] | undefined
  plugin.default.app({
    toolbar: { register: (value: typeof item) => { item = value } },
    settings: { register: () => () => {} },
    signal: new AbortController().signal,
    client: { global: { config: { get: async () => ({ data: {} }) } } },
  })
  expect(item?.appendOnSubmit).toBe(true)
  expect(appendOnSubmitTarget(item!)).toEqual({ token })
  const store = createAppendOnSubmitStore()
  const registry = createComposerRegistry()
  const state = { text: "draft", mode: "normal" as const }
  const editor = {
    read: () => ({ ...target, ...state }),
    change: (text: string) => { state.text = text },
    insertText: () => ({ ok: true as const }),
    submitText: async () => ({ ok: true as const }),
  }
  const remove = registry.register(target, editor)
  registry.registerFinalAppend(createToolbarFinalAppend(store))
  store.toggle(id, target, token)
  remove()
  registry.register(target, editor)
  const other = { ...target, sessionID: "session-b", composerID: "session-b" }
  expect(store.armed(id, other)).toBe(false)
  expect(store.armed(id, target)).toBe(true)
  const blocked = registry.beforeSubmit(target, (detail) => detail.preventSubmit("blocked"))
  expect((await registry.runBeforeSubmit(target, agent)).ok).toBe(false)
  expect(store.armed(id, target)).toBe(true)
  blocked()
  const result = await registry.runBeforeSubmit(target, agent)
  expect(state.text).toBe(`draft\n\n${token}`)
  expect(store.armed(id, target)).toBe(true)
  result.commit?.()
  expect(store.armed(id, target)).toBe(false)
})
