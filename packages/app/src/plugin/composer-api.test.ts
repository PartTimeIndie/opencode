import { expect, test } from "bun:test"
import { createComposerApi } from "./composer-api"
import { createComposerRegistry } from "./composer-registry"

test("a retained composer API cannot read, edit, insert, submit or subscribe after switching servers", async () => {
  const registry = createComposerRegistry()
  const target = { directory: "/project", sessionID: "session", composerID: "composer" }
  const calls: string[] = []
  const state = { server: "first", active: true }
  const controller = new AbortController()
  for (const serverID of ["first", "second"]) registry.register({ ...target, serverID }, {
    read: () => ({ ...target, text: serverID, mode: "normal" }),
    change: () => { calls.push(`${serverID}:change`) },
    insertText: () => { calls.push(`${serverID}:insert`); return { ok: true } },
    submitText: async () => { calls.push(`${serverID}:submit`); return { ok: true } },
  })
  const api = createComposerApi({ serverID: "first", currentServer: () => state.server, active: () => state.active,
    signal: controller.signal, track: (dispose) => dispose,
    insertText: async (input) => registry.insertText({ ...input, composerID: input.composerID!, serverID: "first" })!,
    submitText: (input) => registry.submitText({ ...input, serverID: "first" }),
  }, registry)
  expect(api.read(target)?.text).toBe("first")
  expect(await api.insertText({ ...target, text: "valid" })).toEqual({ ok: true })
  expect(await api.submitText({ ...target, text: "valid" })).toEqual({ ok: true })
  expect(calls).toEqual(["first:insert", "first:submit"])
  state.server = "second"
  expect(api.read(target)).toBeUndefined()
  expect(api.change({ ...target, text: "stale" }).ok).toBe(false)
  expect((await api.insertText({ ...target, text: "stale" })).ok).toBe(false)
  expect((await api.submitText({ ...target, text: "stale" })).ok).toBe(false)
  api.beforeSubmit(target, () => { calls.push("stale callback") })
  await registry.runBeforeSubmit({ ...target, serverID: "first" }, { getAgent: () => undefined, canSetAgent: () => false, setAgent: () => false })
  expect(calls).toEqual(["first:insert", "first:submit"])
  state.server = "first"
  controller.abort()
  expect((await api.submitText({ ...target, text: "unloaded" })).ok).toBe(false)
})
