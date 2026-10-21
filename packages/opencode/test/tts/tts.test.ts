import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { Registry, speak, supportsSpeechModel, type Adapter } from "@/tts/tts"

describe("TTS registry", () => {
  test("dispatches a second provider without changing the caller", async () => {
    const adapter: Adapter = {
      providerID: "local-test",
      supports: () => true,
      speak: (input) =>
        Effect.succeed({
          stream: stream([1, 2]),
          mimeType: "audio/pcm",
          format: "pcm",
          voice: input.voice,
          providerID: input.provider.id,
          modelID: input.modelID,
        }),
    }
    const result = await Effect.runPromise(new Registry([adapter]).speak(adapterInput("local-test")))
    expect(result.providerID).toBe("local-test")
    expect(result.modelID).toBe("voice")
    expect(await bytes(result.stream)).toEqual([1, 2])
  })

  test("requires dedicated speech capability", () => {
    expect(supportsSpeechModel({ capabilities: { input: { text: true }, output: { speech: true } } })).toBe(true)
    expect(supportsSpeechModel({ capabilities: { input: { text: true }, output: { speech: false } } })).toBe(false)
  })

  test("rejects an unavailable model even when an adapter accepts its identifier", async () => {
    const service = {
      getProvider: () => Effect.die("instance provider resolution must not run"),
    } as unknown as Provider.Interface
    const error = await Effect.runPromise(
      speak({
        provider: {
          id: ProviderV2.ID.make("openrouter"),
          name: "OpenRouter",
          source: "api",
          env: [],
          options: {},
          models: {
            "vendor/tts": {
              capabilities: { input: { text: true }, output: { speech: true } },
              supported_voices: ["allowed"],
            },
          },
        } as unknown as Provider.Info,
        model: "openrouter/vendor/missing-tts",
        text: "Hallo",
        voice: "blocked",
      }).pipe(Effect.provideService(Provider.Service, service), Effect.flip),
    )
    expect(error.code).toBe("unsupported_model")
  })

  test.each([
    { voice: "second", defaultVoice: "first", expected: "second" },
    { voice: "stale", defaultVoice: "second", expected: "second" },
    { voice: "stale", defaultVoice: "stale-default", expected: "first" },
    { voice: undefined, defaultVoice: undefined, expected: "first" },
  ])("resolves compatible voices in priority order: %j", async ({ voice, defaultVoice, expected }) => {
    const requests: Array<{ voice: string; format?: string }> = []
    const registry = new Registry([
      {
        providerID: "local-test",
        supports: () => true,
        capabilities: () => ({ defaultVoice }),
        speak: (input) => {
          requests.push(input)
          return Effect.succeed({
            stream: stream([1]),
            mimeType: "audio/mpeg",
            format: "mp3",
            voice: input.voice,
            providerID: input.provider.id,
            modelID: input.modelID,
          })
        },
      },
    ])
    await Effect.runPromise(
      registry.speak({
        ...adapterInput("local-test"),
        provider: {
          ...adapterInput("local-test").provider,
          models: { voice: { supported_voices: ["first", "second"] } },
        } as unknown as Provider.Info,
        voice,
      }),
    )
    expect(requests[0]).toMatchObject({ voice: expected, format: "mp3" })
  })

  test("uses PCM automatically only when the adapter confirms support", async () => {
    const registry = new Registry([
      {
        providerID: "local-test",
        supports: () => true,
        capabilities: () => ({ formats: ["pcm", "mp3"] }),
        speak: (input) =>
          Effect.succeed({
            stream: stream([1]),
            mimeType: "audio/pcm",
            format: input.format!,
            voice: input.voice,
            providerID: input.provider.id,
            modelID: input.modelID,
          }),
      },
    ])
    expect((await Effect.runPromise(registry.speak(adapterInput("local-test")))).format).toBe("pcm")
    expect((await Effect.runPromise(registry.speak({ ...adapterInput("local-test"), format: "mp3" }))).format).toBe(
      "mp3",
    )
  })

  test("reports missing voices before provider dispatch", async () => {
    const registry = new Registry([
      {
        providerID: "local-test",
        supports: () => true,
        speak: () => Effect.die("must not dispatch without a compatible voice"),
      },
    ])
    const error = await Effect.runPromise(
      registry.speak({ ...adapterInput("local-test"), voice: undefined }).pipe(Effect.flip),
    )
    expect(error.code).toBe("missing_voice")
    expect(error.message).toContain("local-test/voice")
  })
})

function adapterInput(providerID: string) {
  return {
    provider: { id: ProviderV2.ID.make(providerID), options: {} } as Provider.Info,
    modelID: "voice",
    text: "Hallo",
    voice: "neutral",
  }
}

function stream(values: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(values))
      controller.close()
    },
  })
}

async function bytes(input: ReadableStream<Uint8Array>) {
  const result: number[] = []
  const reader = input.getReader()
  while (true) {
    const next = await reader.read()
    if (next.done) return result
    result.push(...next.value)
  }
}
