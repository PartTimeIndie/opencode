import { expect, test } from "bun:test"
import { createAudioCaptureBroker } from "./audio-capture"

function microphone() {
  const track = Object.assign(new EventTarget(), {
    stopped: 0,
    stop() {
      this.stopped++
    },
  })
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream }
}

test("a higher priority revokes an interruptible owner before acquiring and never automatically resumes it", async () => {
  const voice = microphone()
  const dictation = microphone()
  const constraints: MediaStreamConstraints[] = []
  const broker = createAudioCaptureBroker(async (input) => {
    constraints.push(input)
    if (constraints.length === 1) return voice.stream
    expect(voice.track.stopped).toBe(1)
    return dictation.stream
  })
  const first = await broker.acquire({ priority: 0, interruptible: true })
  const second = await broker.acquire({ priority: 100, interruptible: false, deviceID: "headset" })
  expect(first.ok && first.signal.aborted).toBe(true)
  expect(first.ok && first.signal.reason.name).toBe("AbortError")
  expect(first.ok && first.signal.reason.stack).toBe("")
  expect(second.ok).toBe(true)
  expect(await broker.acquire({ priority: 0, interruptible: true })).toMatchObject({ ok: false })
  expect(constraints[1]).toEqual({
    audio: {
      deviceId: { exact: "headset" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  if (second.ok) second.release()
  expect(dictation.track.stopped).toBe(1)
  expect(constraints).toHaveLength(2)
  broker.dispose()
})

test("cancelled permission prompts settle promptly and stop late streams without releasing the new owner", async () => {
  const late = microphone()
  const active = microphone()
  const pending = Promise.withResolvers<MediaStream>()
  let calls = 0
  const broker = createAudioCaptureBroker(() => (++calls === 1 ? pending.promise : Promise.resolve(active.stream)))
  const abort = new AbortController()
  const first = broker.acquire({ priority: 0, interruptible: true, signal: abort.signal })
  await Promise.resolve()
  abort.abort()
  expect(await first).toMatchObject({ ok: false })
  const second = await broker.acquire({ priority: 100, interruptible: false })
  pending.resolve(late.stream)
  await Promise.resolve()
  await Promise.resolve()
  expect(late.track.stopped).toBe(1)
  expect(second.ok && second.signal.aborted).toBe(false)
  expect(await broker.acquire({ priority: 100, interruptible: false })).toMatchObject({ ok: false })
  broker.dispose()
  expect(active.track.stopped).toBe(1)
})

test("device loss revokes capture, releases ownership, and release remains idempotent", async () => {
  const device = microphone()
  const broker = createAudioCaptureBroker(async () => device.stream)
  const lease = await broker.acquire({ priority: 0, interruptible: true })
  expect(lease.ok).toBe(true)
  device.track.dispatchEvent(new Event("ended"))
  expect(lease.ok && lease.signal.aborted).toBe(true)
  if (lease.ok) lease.release()
  expect(device.track.stopped).toBe(1)
  const replacement = await broker.acquire({ priority: 0, interruptible: true })
  expect(replacement.ok).toBe(true)
  broker.dispose()
})

test("permission failure and pre-aborted requests do not retain microphone ownership", async () => {
  let calls = 0
  const broker = createAudioCaptureBroker(async () => {
    calls++
    throw new Error("Permission denied")
  })
  expect(await broker.acquire({ priority: 0, interruptible: true, signal: AbortSignal.abort() })).toMatchObject({
    ok: false,
  })
  expect(calls).toBe(0)
  expect(await broker.acquire({ priority: 0, interruptible: true })).toMatchObject({ ok: false })
  expect(await broker.acquire({ priority: 100, interruptible: false })).toMatchObject({ ok: false })
  expect(calls).toBe(2)
})

test("a revoked owner cannot synchronously reacquire ahead of its replacement", async () => {
  const device = microphone()
  const broker = createAudioCaptureBroker(async () => device.stream)
  const voice = await broker.acquire({ priority: 0, interruptible: true })
  const attempted = Promise.withResolvers<boolean>()
  if (voice.ok)
    voice.signal.addEventListener("abort", () => {
      void broker.acquire({ priority: 0, interruptible: true }).then((result) => attempted.resolve(result.ok))
    })
  const dictation = await broker.acquire({ priority: 100, interruptible: false })
  expect(await attempted.promise).toBe(false)
  expect(dictation.ok && !dictation.signal.aborted).toBe(true)
  broker.dispose()
})

test("a missing selected device retains its error code for the caller's fallback", async () => {
  const broker = createAudioCaptureBroker(async () => {
    throw Object.assign(new Error("Device disappeared"), { name: "NotFoundError" })
  })
  expect(await broker.acquire({ priority: 100, interruptible: false, deviceID: "missing" })).toEqual({
    ok: false,
    error: "Device disappeared",
    code: "NotFoundError",
  })
})

test("equal and lower priorities cannot preempt an interruptible owner", async () => {
  const device = microphone()
  let captures = 0
  const broker = createAudioCaptureBroker(async () => {
    captures++
    return device.stream
  })
  const active = await broker.acquire({ priority: 7, interruptible: true })
  expect(await broker.acquire({ priority: 7, interruptible: false })).toMatchObject({ ok: false })
  expect(await broker.acquire({ priority: 6, interruptible: true })).toMatchObject({ ok: false })
  expect(active.ok && active.signal.aborted).toBe(false)
  expect(device.track.stopped).toBe(0)
  expect(captures).toBe(1)
  broker.dispose()
})

test("a non-interruptible owner cannot be preempted even by higher priority", async () => {
  const device = microphone()
  const broker = createAudioCaptureBroker(async () => device.stream)
  const active = await broker.acquire({ priority: -10, interruptible: false })
  expect(await broker.acquire({ priority: 1000, interruptible: false })).toMatchObject({ ok: false })
  expect(active.ok && active.signal.aborted).toBe(false)
  if (active.ok) active.release()
  const next = await broker.acquire({ priority: -20, interruptible: true })
  expect(next.ok).toBe(true)
  broker.dispose()
})

test("invalid arbitration parameters never revoke the existing owner", async () => {
  const device = microphone()
  let captures = 0
  const broker = createAudioCaptureBroker(async () => {
    captures++
    return device.stream
  })
  const active = await broker.acquire({ priority: 0, interruptible: true })
  expect(await broker.acquire({ priority: Number.POSITIVE_INFINITY, interruptible: true })).toMatchObject({ ok: false })
  expect(await broker.acquire({ priority: Number.NaN, interruptible: false })).toMatchObject({ ok: false })
  // JavaScript plugins also need runtime validation of the public contract.
  // @ts-expect-error missing required arbitration property
  expect(await broker.acquire({ priority: 100 })).toMatchObject({ ok: false })
  // @ts-expect-error old plugin API is deliberately rejected
  expect(await broker.acquire({ purpose: "dictation" })).toMatchObject({ ok: false })
  expect(captures).toBe(1)
  expect(active.ok && active.signal.aborted).toBe(false)
  broker.dispose()
})

test("disposal prevents a revoked owner's reentrant acquisition and further requests", async () => {
  const device = microphone()
  const broker = createAudioCaptureBroker(async () => device.stream)
  const active = await broker.acquire({ priority: 0, interruptible: true })
  const attempted = Promise.withResolvers<boolean>()
  if (active.ok)
    active.signal.addEventListener("abort", () => {
      void broker.acquire({ priority: 100, interruptible: false }).then((result) => attempted.resolve(result.ok))
    })
  broker.dispose()
  expect(await attempted.promise).toBe(false)
  expect(await broker.acquire({ priority: 100, interruptible: false })).toMatchObject({ ok: false })
  broker.dispose()
  expect(device.track.stopped).toBe(1)
})
