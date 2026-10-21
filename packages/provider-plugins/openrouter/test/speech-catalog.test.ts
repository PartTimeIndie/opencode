import { expect, test } from "bun:test"
import type { ProviderConfigurationRecord } from "@opencode-ai/plugin/provider"
import { refreshSpeechCatalog } from "../src/speech-catalog"

function provider(baseURL: string): ProviderConfigurationRecord {
  return {
    id: "openrouter", name: "OpenRouter", source: "config", env: [], options: { baseURL },
    models: Object.fromEntries(["openai/gpt-4o-mini-tts-2025-12-15", "microsoft/mai-voice-2"].map(id => [id, {
      id, providerID: "openrouter", name: id, api: { id, url: baseURL, npm: "@openrouter/ai-sdk-provider" },
      capabilities: {
        temperature: false, reasoning: false, attachment: false, toolcall: true, interleaved: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: false, audio: false, image: false, video: false, pdf: false, speech: true },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 0, output: 0 },
      status: "active", options: {}, headers: {}, release_date: "", variants: {},
    }])),
  }
}

test("enriches installed synthetic models using the speech catalogue and retains no unavailable runtime placeholder", async () => {
  const requests: string[] = []
  const server = Bun.serve({ port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname + new URL(request.url).search)
    return Response.json({ data: [
      { id: "microsoft/mai-voice-2", name: "MAI Voice 2", supported_voices: ["en-US-Harper:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"] },
      { id: "mistralai/voxtral-mini-tts-2603", name: "Voxtral Mini TTS", supported_voices: ["en_paul_sad", "en_paul_neutral"] },
    ] })
  } })
  try {
    const data = provider(`${server.url}api/v1`)
    await refreshSpeechCatalog(data, new AbortController().signal)
    expect(data.models["openai/gpt-4o-mini-tts-2025-12-15"]).toBeUndefined()
    expect(data.models["microsoft/mai-voice-2"].supported_voices).toEqual(["en-US-Harper:MAI-Voice-2", "de-DE-Klaus:MAI-Voice-2"])
    expect(data.models["mistralai/voxtral-mini-tts-2603"].capabilities.output.speech).toBe(true)
    data.models["microsoft/mai-voice-2"].supported_voices!.push("not-a-real-voice")
    const next = provider(`${server.url}api/v1`)
    await refreshSpeechCatalog(next, new AbortController().signal)
    expect(next.models["microsoft/mai-voice-2"].supported_voices).not.toContain("not-a-real-voice")
    expect(requests).toEqual(["/api/v1/models?output_modalities=speech"])
  } finally { server.stop(true) }
})

test.each(["outage", "invalid"])("does not erase configured models when the catalogue is %s", async (mode) => {
  const server = Bun.serve({ port: 0, fetch: () => mode === "outage" ? new Response("unavailable", { status: 503 }) : Response.json({ data: [{ id: "broken" }] }) })
  try {
    const data = provider(`${server.url}api/v1`)
    const before = structuredClone(data)
    await refreshSpeechCatalog(data, new AbortController().signal)
    expect(data).toEqual(before)
  } finally { server.stop(true) }
})

test("honors lifecycle cancellation without changing the catalogue", async () => {
  const controller = new AbortController()
  controller.abort()
  const data = provider("http://127.0.0.1:1/api/v1")
  const before = structuredClone(data)
  await expect(refreshSpeechCatalog(data, controller.signal)).rejects.toThrow()
  expect(data).toEqual(before)
})
