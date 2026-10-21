import { describe, expect, test } from "bun:test"
import { MAX_RECORDING_BYTES, speechRecorderHandler } from "../../script/speech-recorder"

const token = "a".repeat(32)
const url = `http://127.0.0.1:12345/${token}`

describe("local speech benchmark recorder", () => {
  test("saves exact audio bytes and codec MIME metadata", async () => {
    const saved: Array<{ audio: Uint8Array; mimeType: string }> = []
    const handler = speechRecorderHandler({
      token,
      save: async (audio, mimeType) => {
        saved.push({ audio, mimeType })
      },
    })
    const response = await handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "audio/webm;codecs=opus", origin: new URL(url).origin },
        body: new Uint8Array([1, 2, 3]),
      }),
    )
    expect(response.status).toBe(200)
    expect([...saved[0].audio]).toEqual([1, 2, 3])
    expect(saved[0].mimeType).toBe("audio/webm;codecs=opus")
  })

  test("rejects foreign origins, DNS rebinding, wrong tokens and non-audio uploads", async () => {
    const handler = speechRecorderHandler({
      token,
      save: async () => {
        throw new Error("Must not save")
      },
    })
    expect((await handler(new Request(url, { headers: { origin: "https://example.com" } }))).status).toBe(403)
    expect((await handler(new Request(`http://example.com/${token}`))).status).toBe(403)
    expect((await handler(new Request(`${url}wrong`))).status).toBe(404)
    expect((await handler(new Request(url, { method: "POST", body: "not audio" }))).status).toBe(415)
  })

  test("rejects empty and oversized audio, including without content-length", async () => {
    const handler = speechRecorderHandler({
      token,
      save: async () => {
        throw new Error("Must not save")
      },
    })
    expect(
      (
        await handler(
          new Request(url, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array() }),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await handler(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "audio/webm" },
            body: new Uint8Array(MAX_RECORDING_BYTES + 1),
          }),
        )
      ).status,
    ).toBe(413)
  })

  test("serves an explicit microphone UI without caching", async () => {
    const handler = speechRecorderHandler({ token, save: async () => {} })
    const response = await handler(new Request(url))
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain("Aufnahme starten")
  })
})
