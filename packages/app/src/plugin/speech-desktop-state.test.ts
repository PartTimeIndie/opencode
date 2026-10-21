import { expect, test } from "bun:test"

const speech = await import(new URL("../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href)

test("speech owns its desktop captions, microphone detail and shortcut actions", () => {
  expect(speech.desktopSpeechState({ phase: "recording", elapsedMs: 1_000, microphone: "USB microphone" })).toEqual({
    phase: "active", label: "OpenCode is listening", elapsedMs: 1_000, detail: "USB microphone", actionLabel: "Stop",
  })
  expect(speech.desktopSpeechState({ phase: "transcribing" })).toEqual({ phase: "active", label: "OpenCode is transcribing", actionLabel: "Cancel" })
  expect(speech.desktopSpeechState({ phase: "success" })).toEqual({ phase: "success", label: "Text inserted" })
})

test("speech retains actionable errors and caps the IPC caption", () => {
  const message = speech.desktopSpeechErrorLabel("Transcription failed with status 402: payment required")
  expect(message).toContain("payment required")
  expect(message).toContain("Settings → Plugins → Speech to Text")
  expect(speech.desktopSpeechErrorLabel("Microphone permission denied")).toBe("Microphone permission denied")
  expect(speech.desktopSpeechErrorLabel("Text recovered to clipboard")).toBe("Text copied to clipboard")
  expect(speech.desktopSpeechState({ phase: "error", message: "x".repeat(600) }).label.length).toBe(512)
})
