import { expect, test } from "bun:test"
import { createRoot, onCleanup } from "solid-js"
import { createComposerRegistry } from "./composer-registry"
import { createComposerSendIntents, type PreparedComposerSubmission } from "./composer-send-intent"

const target = { serverID: "server-a", directory: "dir-a", sessionID: "session-a", composerID: "session-a" }

function submission(sent: string[]) {
  const value: PreparedComposerSubmission = {
    prompt: [{ type: "text", content: "Approved", start: 0, end: 8 }], cursor: 8, agent: "build",
    canSetAgent: () => true,
    async execute(input) { input.dispatched(); sent.push(input.prompt.map((part) => "content" in part ? part.content : "").join("")); return { status: "admitted" } },
    settle() {}, dispose() {},
  }
  return value
}

test("reserves synchronously, joins repeated Send and survives editor disappearance", async () => {
  const broker = createComposerSendIntents()
  const done = Promise.withResolvers<{ ok: true; text: string }>()
  let prepares = 0
  let captures = 0
  const sent: string[] = []
  broker.register(target, { operationID: "record-1", isActive: () => true, subscribe: () => () => {}, prepare() { prepares++; return done.promise } }, new AbortController().signal)
  const capture = () => { captures++; return submission(sent) }
  const first = broker.submit(target, capture)
  expect(broker.submit(target, capture)).toBe(first)
  expect(captures).toBe(1)
  expect(sent).toEqual([])
  done.resolve({ ok: true, text: "finished" })
  expect((await first)?.status).toBe("admitted")
  expect(prepares).toBe(1)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain("Approved finished")
  expect(broker.submit(target, capture)).toBeUndefined()
})

test("cancellation and late completion never dispatch or fall back to Continue", async () => {
  const broker = createComposerSendIntents()
  const done = Promise.withResolvers<{ ok: true; text: string }>()
  const controller = new AbortController()
  const sent: string[] = []
  broker.register(target, { operationID: "record-2", isActive: () => true, subscribe: () => () => {}, prepare: () => done.promise }, controller.signal)
  const running = broker.submit(target, () => submission(sent))
  controller.abort()
  done.resolve({ ok: true, text: "late" })
  expect((await running)?.status).toBe("cancelled")
  expect(sent).toEqual([])
})

test("targets, failed preparation and unknown dispatch are fail closed", async () => {
  const broker = createComposerSendIntents()
  broker.register(target, { operationID: "record-3", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: false, error: "improvement failed" }) }, new AbortController().signal)
  expect(broker.available({ ...target, serverID: "server-b" })).toBe(false)
  const sent: string[] = []
  expect((await broker.submit(target, () => submission(sent)))?.status).toBe("blocked")
  expect(sent).toEqual([])
  const next = { ...target, composerID: "another" }
  broker.register(next, { operationID: "record-4", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, text: "ready" }) }, new AbortController().signal)
  const input = submission(sent)
  input.execute = async ({ dispatched }) => { dispatched(); throw new Error("lost response") }
  expect((await broker.submit(next, () => input))?.status).toBe("unknown")
  expect(broker.submit(next, () => input)).toBeUndefined()
})

test("a blocked preparation keeps its draft before presentation and never dispatches", async () => {
  const broker = createComposerSendIntents()
  const done = Promise.withResolvers<{ ok: false; error: string; insertDraft?: string }>()
  const order: string[] = []
  const kept: string[] = []
  const settled: unknown[] = []
  const sent: string[] = []
  broker.register(target, { operationID: "keep-draft", isActive: () => true, subscribe: () => () => {}, prepare: () => done.promise }, new AbortController().signal)
  const input = submission(sent)
  input.insertDraft = (text) => { order.push("insert"); kept.push(text); return { ok: true } }
  input.settle = (result) => { order.push("settle"); settled.push(result) }
  const running = broker.submit(target, () => input)!
  done.resolve({ ok: false, error: "Improvement failed - raw transcript inserted, not sent", insertDraft: "Raw transcript" })
  expect(await running).toEqual({ status: "blocked", error: "Improvement failed - raw transcript inserted, not sent", insertDraft: "Raw transcript" })
  // The draft is kept before the host restores/presents the blocked send, so the
  // restored prompt never overwrites the kept text and the toast reflects it.
  expect(order).toEqual(["insert", "settle"])
  expect(kept).toEqual(["Raw transcript"])
  expect(settled).toEqual([{ status: "blocked", error: "Improvement failed - raw transcript inserted, not sent", insertDraft: "Raw transcript" }])
  expect(sent).toEqual([])
  expect(broker.busy(target)).toBe(false)
})

test("a kept draft that cannot be inserted is reported and cancellation discards it", async () => {
  const done = Promise.withResolvers<{ ok: false; error: string; insertDraft?: string }>()
  const settled: unknown[] = []
  const sent: string[] = []
  const failing = createComposerSendIntents()
  failing.register(target, { operationID: "kept-failure", isActive: () => true, subscribe: () => () => {}, prepare: () => done.promise }, new AbortController().signal)
  const input = submission(sent)
  input.insertDraft = () => ({ ok: false, error: "Transcript insertion would alter a file or agent reference" })
  input.settle = (result) => settled.push(result)
  const running = failing.submit(target, () => input)!
  done.resolve({ ok: false, error: "Improvement failed", insertDraft: "Raw transcript" })
  expect(await running).toMatchObject({ status: "blocked" })
  const failure = settled[0] as { error?: string; insertDraft?: string }
  expect(failure.error).toContain("Improvement failed")
  expect(failure.error).toContain("Transcript insertion would alter a file or agent reference")
  expect(failure.insertDraft).toBeUndefined()
  expect(sent).toEqual([])

  const late = Promise.withResolvers<{ ok: false; error: string; insertDraft?: string }>()
  const controller = new AbortController()
  const cancelled: unknown[] = []
  let inserts = 0
  const cancellingBroker = createComposerSendIntents()
  cancellingBroker.register(target, { operationID: "kept-cancel", isActive: () => true, subscribe: () => () => {}, prepare: () => late.promise }, controller.signal)
  const cancelling = submission([])
  cancelling.insertDraft = () => { inserts++; return { ok: true } }
  cancelling.settle = (result) => cancelled.push(result)
  const pending = cancellingBroker.submit(target, () => cancelling)!
  controller.abort()
  late.resolve({ ok: false, error: "Improvement failed", insertDraft: "late" })
  expect(await pending).toMatchObject({ status: "cancelled" })
  expect(inserts).toBe(0)
  expect(cancelled).toHaveLength(1)
  expect(cancelled[0]).toMatchObject({ status: "cancelled" })
  expect((cancelled[0] as { insertDraft?: string }).insertDraft).toBeUndefined()

  // Submissions without draft support keep the plain blocked contract.
  const plain = Promise.withResolvers<{ ok: false; error: string; insertDraft?: string }>()
  const plainSettled: unknown[] = []
  const legacyBroker = createComposerSendIntents()
  legacyBroker.register(target, { operationID: "kept-plain", isActive: () => true, subscribe: () => () => {}, prepare: () => plain.promise }, new AbortController().signal)
  const legacy = submission([])
  legacy.settle = (result) => plainSettled.push(result)
  const blocking = legacyBroker.submit(target, () => legacy)!
  plain.resolve({ ok: false, error: "Improvement failed", insertDraft: "Raw transcript" })
  expect(await blocking).toEqual({ status: "blocked", error: "Improvement failed", insertDraft: "Raw transcript" })
  expect(plainSettled).toEqual([{ status: "blocked", error: "Improvement failed", insertDraft: "Raw transcript" }])
})

test("insertion receipts are scoped, one-shot and do not duplicate an already inserted transcript", async () => {
  const broker = createComposerSendIntents()
  const original = submission([]).prompt
  const inserted = [{ type: "text" as const, content: "Approved ready", start: 0, end: 14 }]
  let receipt = ""
  broker.register(target, { operationID: "record-5", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, insertionReceiptID: receipt }) }, new AbortController().signal)
  receipt = broker.recordInsertion(target, "record-5", original, inserted, "ready", 8)!
  const sent: string[] = []
  const input = submission(sent)
  input.prompt = inserted
  expect((await broker.submit(target, () => input))?.status).toBe("admitted")
  expect(sent[0]!.match(/ready/g)).toHaveLength(1)
})

test("a verified transcript replacement is sent instead of appending a second copy", async () => {
  const broker = createComposerSendIntents()
  const sent: string[] = []
  const input = submission(sent)
  input.prompt = [{ type: "text", content: "Approved raw", start: 0, end: 12 }]
  const after = [{ type: "text" as const, content: "Approved polished", start: 0, end: 17 }]
  let receipt = ""
  broker.register(target, { operationID: "polish", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, insertionReceiptID: receipt }) }, new AbortController().signal)
  receipt = broker.recordInsertion(target, "polish", input.prompt, after, "polished", 12, { replace: "raw", cursor: 17 })!
  expect((await broker.submit(target, () => input))?.status).toBe("admitted")
  expect(sent).toEqual(["Approved polished"])
})

test("captured hook lease survives its actual Solid editor owner, but not plugin revocation", async () => {
  for (const revoke of [false, true]) {
    const broker = createComposerSendIntents()
    const registry = createComposerRegistry()
    const plugin = new AbortController()
    const ready = Promise.withResolvers<{ ok: true; text: string }>()
    const sent: string[] = []
    const dispose = createRoot((dispose) => {
      onCleanup(registry.register(target, {
        read: () => ({ ...target, mode: "normal", text: "Approved" }), change() {},
        insertText: () => ({ ok: true }), submitText: async () => ({ ok: true }),
      }))
      onCleanup(registry.beforeSubmit(target, (draft) => { draft.appendText("Hook attachment") }, plugin.signal))
      return dispose
    })
    broker.register(target, { operationID: "lease", isActive: () => true, subscribe: () => () => {}, prepare: () => ready.promise }, plugin.signal)
    const running = broker.submit(target, () => submission(sent), registry.leaseBeforeSubmit(target))
    dispose()
    if (revoke) plugin.abort()
    ready.resolve({ ok: true, text: "ready" })
    expect((await running)?.status).toBe(revoke ? "cancelled" : "admitted")
    expect(sent).toEqual(revoke ? [] : ["Approved ready\n\nHook attachment"])
  }
})

test.each(["forged", "other-operation", "other-target", "changed-draft"])("rejects %s insertion receipt without dispatch", async (kind) => {
  const broker = createComposerSendIntents()
  const sent: string[] = []
  const input = submission(sent)
  let receipt = "forged"
  broker.register(target, { operationID: "receipt", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, insertionReceiptID: receipt }) }, new AbortController().signal)
  if (kind !== "forged") receipt = broker.recordInsertion(kind === "other-target" ? { ...target, serverID: "different" } : target,
    kind === "other-operation" ? "other" : "receipt", input.prompt, [], "ready", 8) ?? "invalid"
  if (kind === "changed-draft") input.prompt = [{ type: "text", content: "New draft", start: 0, end: 9 }]
  expect((await broker.submit(target, () => input))?.status).toBe("blocked")
  expect(sent).toEqual([])
})

test("host cancellation is target-scoped and cancels a volatile queue wait", async () => {
  const broker = createComposerSendIntents()
  const sent: string[] = []
  const queued = Promise.withResolvers<void>()
  const input = submission(sent)
  input.execute = async ({ signal, dispatched }) => {
    queued.resolve()
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    signal.throwIfAborted()
    dispatched()
    return { status: "admitted" }
  }
  broker.register(target, { operationID: "queue", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, text: "ready" }) }, new AbortController().signal)
  const running = broker.submit(target, () => input)
  await queued.promise
  broker.cancel((value) => value.serverID === "other-server")
  expect(broker.busy(target)).toBe(true)
  broker.cancel((value) => value.composerID === target.composerID)
  expect((await running)?.status).toBe("cancelled")
  expect(sent).toEqual([])
  expect(createComposerSendIntents().available(target)).toBe(false)
})

test("capture setup failure releases reservation and never dispatches", async () => {
  const broker = createComposerSendIntents()
  const preparation = { operationID: "bad-capture", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true as const, text: "ready" }) }
  broker.register(target, preparation, new AbortController().signal)
  const bad = submission([])
  bad.prompt = [{ type: "text", content: "bad", start: 0, end: 3, invalid: () => {} } as never]
  expect((await broker.submit(target, () => bad))?.status).toBe("blocked")
  expect(broker.busy(target)).toBe(false)
  expect(broker.available(target)).toBe(true)
})

test("closing a tab revokes even an armed preparation before Send", () => {
  const broker = createComposerSendIntents()
  let unsubscribed = 0
  broker.register(target, { operationID: "armed", isActive: () => true, subscribe: () => () => { unsubscribed++ }, prepare: async () => ({ ok: true, text: "ready" }) }, new AbortController().signal)
  broker.revoke((value) => value.composerID === target.composerID)
  expect(unsubscribed).toBe(1)
  expect(broker.available(target)).toBe(false)
  expect(broker.submit(target, () => submission([]))).toBeUndefined()
})

test("ambiguous command cannot be sent unchanged after unknown dispatch", async () => {
  const broker = createComposerSendIntents()
  broker.register(target, { operationID: "unknown-command", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, text: "this" }) }, new AbortController().signal)
  const input = submission([])
  input.prompt = [{ type: "text", content: "/review ", start: 0, end: 8 }]
  input.execute = async ({ dispatched }) => { dispatched(); throw new Error("response lost") }
  expect((await broker.submit(target, () => input))?.status).toBe("unknown")
  expect(broker.ambiguousCommand(target, [{ type: "text", content: "/review this", start: 0, end: 12 }])).toBe(true)
  expect(broker.ambiguousCommand(target, [{ type: "text", content: "/review changed", start: 0, end: 15 }])).toBe(false)
})

test("presentation, cleanup and post-admission failures cannot hang or repeat an admitted send", async () => {
  const broker = createComposerSendIntents()
  const input = submission([])
  input.settle = () => { throw new Error("presentation") }
  input.dispose = () => { throw new Error("cleanup") }
  broker.register(target, { operationID: "settle", isActive: () => true, subscribe: () => () => {}, prepare: async () => ({ ok: true, text: "ready" }) }, new AbortController().signal)
  const result = await broker.submit(target, () => input, async () => ({ ok: true, commit() { throw new Error("commit") } }))
  expect(result?.status).toBe("admitted")
  expect(broker.busy(target)).toBe(false)
  expect(broker.submit(target, () => input)).toBeUndefined()
})
