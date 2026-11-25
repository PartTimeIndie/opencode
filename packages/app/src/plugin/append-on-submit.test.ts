import { describe, expect, test } from "bun:test"
import { createComposerRegistry } from "./composer-registry"
import {
  appendOnSubmitTarget,
  createAppendOnSubmitStore,
  createToolbarFinalAppend,
  referencePresent,
  resolveAppendOnSubmitTarget,
} from "./append-on-submit"

const target = { serverID: "server", directory: "C:/project", sessionID: "session-a", composerID: "composer-a" }
const agent = { getAgent: () => undefined as string | undefined, canSetAgent: () => false, setAgent: () => false }

function fixture(text = "initial", mode: "normal" | "shell" = "normal", current: Omit<typeof target, "sessionID"> & { sessionID?: string } = target) {
  const registry = createComposerRegistry()
  const store = createAppendOnSubmitStore()
  const state = { text, mode }
  const appended: string[] = []
  const editor = {
    read: () => ({ ...current, ...state }),
    change: (text: string) => {
      state.text = text
    },
    appendText: (text: string) => {
      state.text += `${state.text.trim() ? "\n\n" : ""}${text}`
      appended.push(text)
    },
    insertText: () => ({ ok: true as const }),
    submitText: async () => ({ ok: true as const }),
  }
  const dispose = registry.register(current, editor)
  registry.registerFinalAppend(createToolbarFinalAppend(store))
  store.toggle("image", current, "/codex-image")
  return { registry, store, state, appended, editor, dispose }
}

describe("standard toolbar target", () => {
  test("accepts one command or skill, rejects missing, ambiguous and malformed targets", () => {
    expect(appendOnSubmitTarget({ command: { name: "codex-image" } })).toEqual({ token: "/codex-image" })
    expect(appendOnSubmitTarget({ skill: { name: "review" } })).toEqual({ token: "/review" })
    for (const item of [
      {},
      { command: { name: "a" }, skill: { name: "b" } },
      { command: { name: "/a" } },
      { skill: { name: "a b" } },
    ])
      expect(appendOnSubmitTarget(item)).toHaveProperty("error")
  })
  test("custom handlers completely override the standard action", () => {
    expect(appendOnSubmitTarget({ command: { name: "a" }, run() {} })).toHaveProperty("error")
    expect(appendOnSubmitTarget({ command: { name: "a" }, mount() {} })).toHaveProperty("error")
  })
  test("requires an exact composer target", () => {
    expect(resolveAppendOnSubmitTarget("server", target)).toEqual({ target })
    expect(resolveAppendOnSubmitTarget("server", { directory: target.directory })).toHaveProperty("error")
  })
  test("deduplication matches whitespace tokens, not substrings", () => {
    expect(referencePresent("ask /codex-image now", "/codex-image")).toBe(true)
    expect(referencePresent("`/codex-image`", "/codex-image")).toBe(false)
    expect(referencePresent("prefix/codex-image", "/codex-image")).toBe(false)
  })
})

describe("actual shared final append phase", () => {
  test("arms an empty new-chat composer and appends only on its first admitted message", async () => {
    const current = { ...target, sessionID: undefined }
    const f = fixture("", "normal", current)
    f.store.remove("image")
    f.store.toggle("example", current, "/example-skill")
    expect(resolveAppendOnSubmitTarget("server", current)).toEqual({ target: current })
    const blank = await f.registry.runBeforeSubmit(current, agent)
    blank.commit?.()
    expect(f.state.text).toBe("")
    expect(f.store.armed("example", current)).toBe(true)
    f.state.text = "Implement the assignment"
    const result = await f.registry.runBeforeSubmit(current, agent)
    expect(result.ok).toBe(true)
    expect(f.state.text).toBe("Implement the assignment\n\n/example-skill")
    expect(f.store.armed("example", target)).toBe(false)
    expect(f.store.armed("example", current)).toBe(true)
    result.commit?.()
    expect(f.store.armed("example", current)).toBe(false)
  })
  test("appends after ordinary handlers and consumes only on admission", async () => {
    const f = fixture()
    f.registry.beforeSubmit(target, (input) => input.appendText("ordinary"))
    const result = await f.registry.runBeforeSubmit(target, agent)
    expect(result.ok).toBe(true)
    expect(f.state.text).toBe("initial\n\nordinary\n\n/codex-image")
    expect(f.appended).toEqual(["ordinary", "/codex-image"])
    expect(f.store.armed("image", target)).toBe(true)
    result.commit?.()
    result.commit?.()
    expect(f.store.armed("image", target)).toBe(false)
  })
  test("deduplicates shared targets and existing references without granting authorization", async () => {
    const f = fixture("initial /codex-image")
    f.store.toggle("same", target, "/codex-image")
    f.store.toggle("review", target, "/manual-review")
    const result = await f.registry.runBeforeSubmit(target, agent)
    expect(f.state.text).toBe("initial /codex-image\n\n/manual-review")
    result.commit?.()
    expect(f.store.tokens(target)).toEqual([])
  })
  test.each(["", " \n\t"])("keeps blank draft %j armed", async (text) => {
    const f = fixture(text)
    const result = await f.registry.runBeforeSubmit(target, agent)
    result.commit?.()
    expect(f.state.text).toBe(text)
    expect(f.store.armed("image", target)).toBe(true)
  })
  test("shell and excluded Resume paths neither append nor consume", async () => {
    const shell = fixture("initial", "shell")
    const resumed = fixture()
    for (const [f, options] of [
      [shell, undefined],
      [resumed, { finalAppend: false }],
    ] as const) {
      const result = await f.registry.runBeforeSubmit(target, agent, options)
      result.commit?.()
      expect(f.state.text).toBe("initial")
      expect(f.store.armed("image", target)).toBe(true)
    }
  })
  test("programmatic submit bypasses the shared phase", async () => {
    const f = fixture()
    await f.registry.submitText({ ...target, text: "Continue" })
    expect(f.state.text).toBe("initial")
    expect(f.store.armed("image", target)).toBe(true)
  })
  test("blocked, aborted and stale drafts retain activation", async () => {
    const blocked = fixture()
    blocked.registry.beforeSubmit(target, (input) => input.preventSubmit("review"))
    expect(await blocked.registry.runBeforeSubmit(target, agent)).toEqual({ ok: false, error: "review" })
    const stale = fixture()
    const sending = stale.registry.runBeforeSubmit(target, agent)
    stale.registry.change({ ...target, text: "edited" })
    expect((await sending).ok).toBe(false)
    const aborted = fixture()
    aborted.registry.beforeSubmit(target, async () => {
      aborted.dispose()
    })
    expect((await aborted.registry.runBeforeSubmit(target, agent)).ok).toBe(false)
    for (const f of [blocked, stale, aborted]) expect(f.store.armed("image", target)).toBe(true)
  })
  test("failure before admission and retry do not duplicate tokens or consume early", async () => {
    const f = fixture()
    await f.registry.runBeforeSubmit(target, agent) // no admission receipt
    const retry = await f.registry.runBeforeSubmit(target, agent)
    expect(f.state.text).toBe("initial\n\n/codex-image")
    expect(f.store.armed("image", target)).toBe(true)
    retry.commit?.()
    expect(f.store.armed("image", target)).toBe(false)
  })
  test("in-flight receipts never consume a newer toggle or sibling target", async () => {
    const f = fixture()
    const result = await f.registry.runBeforeSubmit(target, agent)
    f.store.toggle("image", target, "/codex-image")
    f.store.toggle("image", target, "/codex-image")
    const other = { ...target, serverID: "other" }
    f.store.toggle("image", other, "/codex-image")
    result.commit?.()
    expect(f.store.armed("image", target)).toBe(true)
    expect(f.store.armed("image", other)).toBe(true)
  })
  test("same-target remount preserves state; item disposal clears all its targets", async () => {
    const f = fixture()
    f.dispose()
    f.registry.register(target, f.editor)
    expect(f.store.armed("image", target)).toBe(true)
    f.store.remove("image")
    expect(f.store.armed("image", target)).toBe(false)
    expect(createAppendOnSubmitStore().armed("image", target)).toBe(false)
  })
  test("deactivation prunes only disabled targets and invalidates old receipts", async () => {
    const f = fixture()
    const receipt = await f.registry.runBeforeSubmit(target, agent)
    f.store.toggle("image", { ...target, sessionID: "other" }, "/codex-image")
    f.store.prune((_id, current) => current.sessionID !== target.sessionID)
    expect(f.store.armed("image", target)).toBe(false)
    expect(f.store.armed("image", { ...target, sessionID: "other" })).toBe(true)
    f.store.toggle("image", target, "/codex-image")
    receipt.commit?.()
    expect(f.store.armed("image", target)).toBe(true)
  })

  test("disposing one final phase never restores an already-disposed handler", async () => {
    const f = fixture()
    let first = 0
    let second = 0
    const disposeFirst = f.registry.registerFinalAppend(() => {
      first++
    })
    const disposeSecond = f.registry.registerFinalAppend(() => {
      second++
    })
    disposeFirst()
    disposeSecond()
    await f.registry.runBeforeSubmit(target, agent)
    expect(first).toBe(0)
    expect(second).toBe(0)
  })
})
