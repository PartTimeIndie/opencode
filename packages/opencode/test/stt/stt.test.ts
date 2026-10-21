import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Provider } from "@/provider/provider"
import { Registry, transcribe, type Adapter } from "@/stt/stt"
import { mediaRegistry } from "@/plugin/media"
import type { MediaAdapters } from "@opencode-ai/plugin/media"

describe("STT registry", () => {
  test("dispatches a second provider without changing the caller", async () => {
    const adapter: Adapter = {
      providerID: "local-test",
      supports: () => true,
      transcribe: (input) =>
        Effect.succeed({ text: "Local transcript", providerID: input.provider.id, modelID: input.modelID }),
    }
    const result = await Effect.runPromise(new Registry([adapter]).transcribe(input("local-test")))
    expect(result).toEqual({ text: "Local transcript", providerID: "local-test", modelID: "asr" })
  })

  test("returns a stable error for an unknown provider", async () => {
    const error = await Effect.runPromise(new Registry([]).transcribe(input("unknown")).pipe(Effect.flip))
    expect(error.code).toBe("unsupported_provider")
  })

  test("rejects transcription models outside an adapter's dedicated model format", async () => {
    const adapter: Adapter = {
      providerID: "local-test",
      supports: () => false,
      transcribe: () => Effect.die("unsupported models must not be dispatched"),
    }
    const error = await Effect.runPromise(new Registry([adapter]).transcribe(input("local-test")).pipe(Effect.flip))
    expect(error.code).toBe("unsupported_model")
    expect(error.message).toBe("Unknown transcription model local-test/asr")
  })

  test("uses a supplied provider without resolving the instance provider", async () => {
    const service = {
      getProvider: () => Effect.die("instance provider resolution must not run"),
    } as unknown as Provider.Interface
    const error = await Effect.runPromise(
      transcribe({
        provider: { id: ProviderV2.ID.make("openrouter"), options: {} } as Provider.Info,
        model: "openrouter/not-a-dedicated-model",
        audio: new Uint8Array([1]),
        mimeType: "audio/wav",
      }).pipe(Effect.provideService(Provider.Service, service), Effect.flip),
    )
    expect(error.code).toBe("unsupported_model")
  })

  test("dispatches a host-validated model when the lightweight provider has no catalog", async () => {
    const releases: Array<() => void> = []
    const module = await import(new URL("../../../../../opencode-openrouter-media/dist/index.js",import.meta.url).href)
    await module.default.server({host:{media:{register(adapters: MediaAdapters) {releases.push(mediaRegistry.register(process.cwd(),adapters))}}}})
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ text: "Configured provider transcript" })
      },
    })
    try {
      const service = {
        getProvider: () => Effect.die("instance provider resolution must not run"),
      } as unknown as Provider.Interface
      const result = await Effect.runPromise(
        transcribe({
          provider: {
            id: ProviderV2.ID.make("openrouter"),
            name: "OpenRouter",
            source: "config",
            env: [],
            key: "server-secret",
            options: { baseURL: `${server.url}api/v1` },
            models: {},
          } as Provider.Info,
          model: "openrouter/qwen/qwen3-asr-0.6b",
          audio: new Uint8Array([1]),
          mimeType: "audio/wav",
          allowUncataloguedModel: true,
        }).pipe(Effect.provideService(Provider.Service, service)),
      )
      expect(result).toMatchObject({
        text: "Configured provider transcript",
        providerID: "openrouter",
        modelID: "qwen/qwen3-asr-0.6b",
      })
    } finally {
      releases.forEach((release) => release())
      server.stop(true)
    }
  })
})

function input(providerID: string) {
  return {
    provider: {
      id: ProviderV2.ID.make(providerID),
      options: {},
    } as Provider.Info,
    modelID: "asr",
    audio: new Uint8Array([1]),
    mimeType: "audio/webm",
  }
}
