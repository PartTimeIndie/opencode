import { expect, test } from "bun:test"
import { createComposerRegistry } from "./composer-registry"

const target = { serverID: "server-a", directory: "/project", sessionID: "session-a", composerID: "composer-a" }
const agent = {
  getAgent: () => "default",
  canSetAgent: (name: string) => name === "reviewer",
  setAgent: (name: string) => name === "reviewer",
}

function fixture() {
  const registry = createComposerRegistry()
  const state = { text: "initial", mode: "normal" as "normal" | "shell" }
  const editor = {
    read: () => ({ ...target, ...state }),
    change: (text: string) => {
      state.text = text
    },
    insertText: (input: { text: string }) => {
      state.text += input.text
      return { ok: true }
    },
    submitText: async (text: string) => ({ ok: text === "Continue" }),
  }
  const dispose = registry.register(target, editor)
  return { registry, state, editor, dispose }
}

test("availability observers see late mount, disposal and remount without stale registrations", () => {
  const registry = createComposerRegistry()
  const observed: boolean[] = []
  const unsubscribe = registry.subscribe(() => observed.push(!!registry.read(target)))
  const editor = {
    read: () => ({ ...target, text: "draft", mode: "normal" as const }),
    change: () => {},
    insertText: () => ({ ok: true }),
    submitText: async () => ({ ok: true }),
  }
  expect(registry.read(target)).toBeUndefined()
  const first = registry.register(target, editor)
  expect(observed).toEqual([true])
  expect(() => registry.register(target, editor)).toThrow("already registered")
  expect(observed).toEqual([true])
  first()
  first()
  expect(observed).toEqual([true, false])
  const second = registry.register(target, editor)
  first()
  expect(observed).toEqual([true, false, true])
  unsubscribe()
  second()
  expect(observed).toEqual([true, false, true])
  expect(registry.read(target)).toBeUndefined()
})

test("composer read/change/insert/submit use exact server, directory, session and composer identity", async () => {
  const view = fixture()
  expect(view.registry.read(target)?.text).toBe("initial")
  expect(view.registry.change({ ...target, expectedText: "wrong", text: "lost" }).ok).toBe(false)
  expect(view.registry.change({ ...target, expectedText: "initial", text: "updated" }).ok).toBe(true)
  expect(view.registry.insertText({ ...target, text: "!" })?.ok).toBe(true)
  expect(view.state.text).toBe("updated!")
  expect((await view.registry.submitText({ ...target, text: "Continue" })).ok).toBe(true)
  for (const change of [
    { serverID: "server-b" },
    { directory: "/other" },
    { sessionID: "other" },
    { composerID: "other" },
  ]) {
    expect(view.registry.read({ ...target, ...change })).toBeUndefined()
    expect(view.registry.change({ ...target, ...change, text: "lost" }).ok).toBe(false)
  }
  view.dispose()
  expect(view.registry.read(target)).toBeUndefined()
})

test("awaits callbacks in registration order and commits changes once all callbacks accept", async () => {
  const view = fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const seen: string[] = []
  view.registry.beforeSubmit(target, async (context) => {
    started.resolve()
    await release.promise
    context.appendText("first")
  })
  view.registry.beforeSubmit(target, (context) => {
    seen.push(context.getText())
    context.appendText("second")
  })
  const sending = view.registry.runBeforeSubmit(target, agent)
  await started.promise
  expect(view.state.text).toBe("initial")
  expect((await view.registry.runBeforeSubmit(target, agent)).ok).toBe(false)
  release.resolve()
  expect((await sending).ok).toBe(true)
  expect(seen).toEqual(["initial\n\nfirst"])
  expect(view.state.text).toBe("initial\n\nfirst\n\nsecond")
  view.dispose()
})

test("cancellation discards staged text and agent selection", async () => {
  const view = fixture()
  const applied: string[] = []
  view.registry.beforeSubmit(target, (context) => {
    context.setText("never committed")
    expect(context.setAgent("unknown")).toBe(false)
    expect(context.setAgent("reviewer")).toBe(true)
    context.preventSubmit("Review first")
  })
  expect(
    await view.registry.runBeforeSubmit(target, {
      ...agent,
      setAgent: (name) => {
        applied.push(name)
        return true
      },
    }),
  ).toEqual({ ok: false, error: "Review first" })
  expect(view.state.text).toBe("initial")
  expect(applied).toEqual([])
  view.dispose()
})

test("an asynchronous callback cannot overwrite edits made while it was running", async () => {
  const view = fixture()
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  view.registry.beforeSubmit(target, async (context) => {
    started.resolve()
    await release.promise
    context.setText("stale")
  })
  const sending = view.registry.runBeforeSubmit(target, agent)
  await started.promise
  view.registry.change({ ...target, text: "user edit" })
  release.resolve()
  expect((await sending).ok).toBe(false)
  expect(view.state.text).toBe("user edit")
  view.dispose()
})

test.each(["plugin", "composer"])("%s unload cancels a pending callback and rejects late writes", async (kind) => {
  const view = fixture()
  const started = Promise.withResolvers<void>()
  const plugin = new AbortController()
  let signal!: AbortSignal
  let lateWrite = () => {}
  view.registry.beforeSubmit(
    target,
    (context) => {
      signal = context.signal
      lateWrite = () => context.setText("late")
      started.resolve()
      return new Promise(() => {})
    },
    plugin.signal,
  )
  const sending = view.registry.runBeforeSubmit(target, agent)
  await started.promise
  if (kind === "plugin") plugin.abort()
  else view.dispose()
  expect((await sending).ok).toBe(false)
  expect(signal.reason.name).toBe("AbortError")
  expect(signal.reason.stack).toBe("")
  expect(lateWrite).toThrow()
  expect(view.state.text).toBe("initial")
  view.dispose()
})

test("unsubscribed callbacks and callbacks for other composers never run", async () => {
  const view = fixture()
  let calls = 0
  const unsubscribe = view.registry.beforeSubmit(target, () => {
    calls++
  })
  view.registry.beforeSubmit({ ...target, composerID: "other" }, () => {
    calls++
  })
  unsubscribe()
  unsubscribe()
  expect((await view.registry.runBeforeSubmit(target, agent)).ok).toBe(true)
  expect(calls).toBe(0)
  view.dispose()
})

test("callback failures leave the draft intact and permit a later submit", async () => {
  const view = fixture()
  const unsubscribe = view.registry.beforeSubmit(target, (context) => {
    context.setText("discard")
    throw new Error("Plugin failed")
  })
  expect(await view.registry.runBeforeSubmit(target, agent)).toEqual({ ok: false, error: "Plugin failed" })
  expect(view.state.text).toBe("initial")
  unsubscribe()
  expect((await view.registry.runBeforeSubmit(target, agent)).ok).toBe(true)
  view.dispose()
})

test("append callbacks preserve the editor's structured-append operation", async () => {
  const registry = createComposerRegistry()
  const appended: string[] = []
  const dispose = registry.register(target, {
    read: () => ({ ...target, mode: "normal", text: "@file initial" }),
    change() {
      throw new Error("must not flatten structured content")
    },
    appendText: (text) => {
      appended.push(text)
    },
    insertText: () => ({ ok: true }),
    submitText: async () => ({ ok: true }),
  })
  registry.beforeSubmit(target, (context) => context.appendText("/review"))
  expect((await registry.runBeforeSubmit(target, agent)).ok).toBe(true)
  expect(appended).toEqual(["/review"])
  dispose()
})

test("uniqueComposerID resolves only one exact composer and never guesses", async () => {
  const registry = createComposerRegistry()
  const editor = (composerID = target.composerID) => ({
    read: () => ({ ...target, composerID, mode: "normal" as const, text: "draft" }),
    change() {},
    insertText: () => ({ ok: true }),
    submitText: async () => ({ ok: true }),
  })
  const dispose = registry.register(target, editor())
  expect(
    registry.uniqueComposerID({ serverID: target.serverID, directory: target.directory, sessionID: target.sessionID }),
  ).toBe(target.composerID)
  expect(
    registry.uniqueComposerID({ serverID: target.serverID, directory: target.directory, sessionID: "other" }),
  ).toBeUndefined()
  registry.register({ ...target, composerID: "other" }, editor("other"))
  expect(
    registry.uniqueComposerID({ serverID: target.serverID, directory: target.directory, sessionID: target.sessionID }),
  ).toBeUndefined()
  dispose()
})

test("final append runs after plugin handlers and commits only on acceptance", async () => {
  const view = fixture()
  const order: string[] = []
  let committed = false
  view.registry.beforeSubmit(target, (context) => {
    context.appendText("first")
    order.push(`handler:${context.getText()}`)
  })
  view.registry.registerFinalAppend(({ getText, appendText }) => {
    order.push(`final:${getText()}`)
    appendText("second")
    return {
      commit: () => {
        committed = true
      },
    }
  })
  const result = await view.registry.runBeforeSubmit(target, agent)
  expect(result.ok).toBe(true)
  expect(order).toEqual(["handler:initial\n\nfirst", "final:initial\n\nfirst"])
  expect(committed).toBe(false)
  result.commit?.()
  expect(committed).toBe(true)
  expect(view.state.text).toBe("initial\n\nfirst\n\nsecond")
  view.dispose()

  const blocked = fixture()
  blocked.registry.beforeSubmit(target, (context) => context.preventSubmit("Review first"))
  let blockedCommit = false
  blocked.registry.registerFinalAppend(() => ({
    commit: () => {
      blockedCommit = true
    },
  }))
  expect(await blocked.registry.runBeforeSubmit(target, agent)).toEqual({ ok: false, error: "Review first" })
  expect(blockedCommit).toBe(false)
  blocked.dispose()
})
