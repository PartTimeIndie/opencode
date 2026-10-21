import { expect, test } from "bun:test"
import type { SpeechResult } from "@opencode-ai/plugin/media"
import { createMediaRegistry } from "../../src/plugin/media"

const request = {provider:{id:"neutral",options:{}},modelID:"speaker",text:"Hallo",voice:"local"}

test.each(["reject", "hang"])("identity mismatch remains visible when stream cleanup would %s",async (mode) => {
  const registry = createMediaRegistry()
  let cancelled = false
  const dispose = registry.register(process.cwd(),{providerID:"neutral",speech:{supports:() => true,async speak() {
    return {providerID:"wrong-provider",modelID:"speaker",voice:"local",format:"mp3",mimeType:"audio/mpeg",stream:new ReadableStream<Uint8Array>({cancel() {
      cancelled = true
      return mode === "reject" ? Promise.reject(new Error("cleanup failed")) : new Promise(() => {})
    }})}
  }}})
  try {
    await expect(Promise.race([
      registry.list(process.cwd())[0].speech!.speak(request),
      Bun.sleep(100).then(() => {throw new Error("cleanup blocked identity result")}),
    ])).rejects.toThrow("another provider or model")
    expect(cancelled).toBe(true)
  } finally {dispose()}
})

test("disposal rejects a pending speech call and cancels its eventual stream",async () => {
  const registry = createMediaRegistry()
  const pending = Promise.withResolvers<SpeechResult>()
  const entered = Promise.withResolvers<void>()
  let cancelled = false
  const dispose = registry.register(process.cwd(),{providerID:"neutral",speech:{supports:() => true,speak() {entered.resolve();return pending.promise}}})
  const output = registry.list(process.cwd())[0].speech!.speak(request).catch((error: unknown) => error)
  await entered.promise
  dispose()
  expect(await output).toMatchObject({name:"AbortError"})
  pending.resolve({providerID:"neutral",modelID:"speaker",voice:"local",format:"mp3",mimeType:"audio/mpeg",stream:new ReadableStream<Uint8Array>({cancel(){cancelled=true}})})
  await Bun.sleep(0)
  expect(cancelled).toBe(true)
})
