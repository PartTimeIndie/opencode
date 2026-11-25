import { expect, test } from "bun:test"
import { createDelegationSettingsModel, type DelegationTarget, type DelegationSnapshot } from "../src/components/settings-v2/delegation-settings-model"

const snapshot = (revision = 0): DelegationSnapshot => ({ scope: "session", revision, value: {} })
const target = (): DelegationTarget => ({ server: {}, sessionID: "session-a", scope: "session", directory: "/project" })
const pending = <T>() => {
  let complete: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => { complete = resolve })
  return { promise, complete(value: T) { if (!complete) throw new Error("Missing resolver"); complete(value) } }
}

test("Settings CAS uses the loaded Session revision, snapshots patches and does not retry conflicts", async () => {
  const current = target()
  const writes: unknown[] = []
  const model = createDelegationSettingsModel({ target: () => current, read: async () => snapshot(4),
    patch: async (target, patch, expected) => { writes.push({ target, patch, expected }); throw new Error("Revision conflict") } })
  await model.read()
  const patch = { ordinaryQuestions: false }
  const saving = model.save(patch)
  patch.ordinaryQuestions = true
  await saving
  expect(writes).toEqual([{ target: current, patch: { ordinaryQuestions: false }, expected: { expectedRevision: 4 } }])
  expect(model.state.error).toBe("Revision conflict")
  expect(model.state.snapshot).toBeUndefined()
  await model.save({ ordinaryQuestions: true })
  expect(writes).toHaveLength(1)
  model.dispose()
})

test("Settings resolves Session and server at click time and refuses a stale target receipt", async () => {
  let current = target()
  let writes = 0
  const model = createDelegationSettingsModel({ target: () => current, read: async () => snapshot(),
    patch: async () => { writes++; return snapshot(1) } })
  await model.read()
  current = { ...current, sessionID: "session-b" }
  await model.save({ ordinaryQuestions: false })
  expect(writes).toBe(0)
  expect(model.state.error).toContain("target changed")
  await model.read()
  current = { ...current, server: {} }
  await model.save({ ordinaryQuestions: false })
  expect(writes).toBe(0)
  model.dispose()
})

test("late reads and saves never replace a different scope or revived same Session", async () => {
  let current = target()
  const read = pending<DelegationSnapshot>()
  const write = pending<DelegationSnapshot>()
  let reads = 0
  const model = createDelegationSettingsModel({ target: () => current,
    read: () => ++reads === 1 ? read.promise : Promise.resolve(snapshot(9)), patch: () => write.promise })
  const oldRead = model.read()
  model.reset()
  await model.read()
  read.complete(snapshot(1))
  expect(await oldRead).toBeUndefined()
  expect(model.state.snapshot?.revision).toBe(9)
  const saving = model.save({ ordinaryQuestions: false })
  current = { ...current, scope: "project" }
  model.reset()
  write.complete(snapshot(10))
  await saving
  expect(model.state.snapshot).toBeUndefined()
  expect(model.state.busy).toBe(false)
  model.dispose()
})

test("project/global writes use file versions and missing preconditions fail closed", async () => {
  const current = { ...target(), scope: "project" as const }
  const writes: unknown[] = []
  let value: DelegationSnapshot = { scope: "project", version: "a".repeat(64), value: {} }
  const model = createDelegationSettingsModel({ target: () => current, read: async () => value,
    patch: async (_, patch, expected) => { writes.push({ patch, expected }); return { ...value, version: "b".repeat(64) } } })
  await model.read()
  await model.save({ rules: null })
  expect(writes).toEqual([{ patch: { rules: null }, expected: { expectedVersion: "a".repeat(64) } }])
  value = { scope: "project", value: {} }
  await model.read()
  await model.save({ preferences: null })
  expect(writes).toHaveLength(1)
  expect(model.state.error).toContain("did not return")
  model.dispose()
})

test("task scope requires an explicit target and disposal ignores late results", async () => {
  let current = { ...target(), scope: "task" as const, taskID: "" }
  const reading = pending<DelegationSnapshot>()
  let reads = 0
  const model = createDelegationSettingsModel({ target: () => current, read: () => { reads++; return reading.promise },
    patch: async () => { throw new Error("Unexpected write") } })
  await model.read()
  expect(reads).toBe(0)
  current = { ...current, taskID: "task-owned" }
  const late = model.read()
  model.dispose()
  reading.complete({ scope: "task", taskID: "task-owned", revision: 1, value: {} })
  await late
  expect(model.state.snapshot).toBeUndefined()
})
