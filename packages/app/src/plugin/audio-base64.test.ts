import { describe, expect, test } from "bun:test"
import { encodeAudioBase64 } from "./audio-base64"

describe("audio base64 transport", () => {
  test.each([0x8000, 0x8001, 0x10003])("preserves all %i audio bytes across chunk boundaries", (length) => {
    const input = Uint8Array.from({ length }, (_, index) => index % 251)
    const decoded = Uint8Array.from(atob(encodeAudioBase64(input)), (value) => value.charCodeAt(0))

    expect(decoded).toEqual(input)
  })
})
