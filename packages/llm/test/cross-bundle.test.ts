import { afterAll, describe, expect } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Option, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMClient, LLMError, Model } from "../src"
import { dynamicResponse } from "./lib/http"
import { it } from "./lib/effect"
import { sseEvents } from "./lib/sse"

const temporaryRoot = path.resolve(import.meta.dir, "..", ".agent-tmp")
await mkdir(temporaryRoot, { recursive: true })
const temporary = await mkdtemp(path.join(temporaryRoot, "llm-cross-bundle-"))
afterAll(() => rm(temporary, { recursive: true, force: true }))

const build = await Bun.build({
  entrypoints: [path.resolve(import.meta.dir, "../src/protocols/openai-responses.ts")],
  outdir: temporary,
  target: "bun",
  format: "esm",
  packages: "external",
})
if (!build.success) throw new Error(build.logs.map((log) => log.message).join("\n"))

const foreign = await import(pathToFileURL(build.outputs[0].path).href)

describe("cross-bundle LLM boundaries", () => {
  it.effect("prepares and sends a request through an isolated Codex route bundle", () =>
    Effect.gen(function* () {
      const foreignModel = foreign.codexRoute.model({ id: "gpt-cross-bundle" })
      expect(foreignModel).not.toBeInstanceOf(Model)

      const request = LLM.request({
        model: foreignModel,
        prompt: "Say hello.",
        generation: { maxTokens: 20 },
        http: {
          query: { trace: "kept" },
          body: { max_output_tokens: 4096, metadata: { trace: "kept" } },
        },
      })

      expect(request.model).toBeInstanceOf(Model)

      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((transport) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(transport.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://chatgpt.com/backend-api/codex/responses?trace=kept")
              expect(yield* Effect.promise(() => web.json())).toEqual({
                model: "gpt-cross-bundle",
                input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
                stream: true,
                metadata: { trace: "kept" },
              })
              return transport.respond(
                sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "Ready" },
                  { type: "response.completed", response: {} },
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )

      expect(response.text).toBe("Ready")
    }),
  )

  it.effect("preserves host authentication and terminal quota errors through a foreign bundled route", () =>
    Effect.gen(function* () {
      const foreignModel = foreign.codexRoute.model({ id: "gpt-cross-bundle-errors" })
      const request = LLM.request({ model: foreignModel, prompt: "Say hello.", generation: { maxTokens: 20 } })
      for (const scenario of [
        { status: 401, body: { error: { message: "invalid credentials", type: "authentication_error" } }, reason: "Authentication", retryable: false },
        { status: 402, body: { error: { message: "insufficient_quota", type: "insufficient_quota" } }, reason: "QuotaExceeded", retryable: false },
      ] as const) {
        const exit = yield* Effect.exit(
          LLMClient.generate(request).pipe(
            Effect.provide(dynamicResponse((input) =>
              Effect.succeed(input.respond(JSON.stringify(scenario.body), {
                status: scenario.status,
                headers: { "content-type": "application/json" },
              })),
            )),
          ),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.squash(exit.cause)
          const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(LLMError)(error))
          expect(decoded).toBeDefined()
          expect(decoded?.reason._tag).toBe(scenario.reason)
          expect(decoded?.retryable).toBe(scenario.retryable)
        }
      }
    }),
  )
})
