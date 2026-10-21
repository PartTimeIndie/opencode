import { afterEach, beforeEach, describe, expect } from "bun:test"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { Effect, Fiber, Layer } from "effect"
import path from "path"

const generateTextCalls: LanguageModelV3CallOptions[] = []
const testCommitModel = "opencode/deepseek-v4-flash-free"
let generatedText = "feat(cards): add elemental cards"
let generatedTexts: string[] = []
let generateErrors: Error[] = []
let beforeGenerate: (() => Promise<void>) | undefined

const { FSUtil } = await import("@opencode-ai/core/fs-util")
const { CrossSpawnSpawner } = await import("@opencode-ai/core/cross-spawn-spawner")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { Git } = await import("../../src/git")
const { Vcs } = await import("../../src/project/vcs")
const { ProviderTest } = await import("../fake/provider")
const { disposeAllInstances, TestInstance } = await import("../fixture/fixture")
const { testEffect } = await import("../lib/effect")
const { ModelV2 } = await import("@opencode-ai/core/model")
const { ProviderV2 } = await import("@opencode-ai/core/provider")

const fakeLanguage = {
  modelId: "commit-message-test",
  provider: "test",
  specificationVersion: "v3",
  supportedUrls: {},
  doGenerate: async (input) => {
    generateTextCalls.push(input)
    await beforeGenerate?.()
    const error = generateErrors.shift()
    if (error) throw error
    return {
      content: [{ type: "text", text: generatedTexts.shift() ?? generatedText }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }
  },
  doStream: async (input) => {
    generateTextCalls.push(input)
    await beforeGenerate?.()
    const error = generateErrors.shift()
    if (error) throw error
    const text = generatedTexts.shift() ?? generatedText
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "text" })
          controller.enqueue({ type: "text-delta", id: "text", delta: text })
          controller.enqueue({ type: "text-end", id: "text" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          })
          controller.close()
        },
      }),
    }
  },
} satisfies LanguageModelV3

const provider = ProviderTest.fake({
  model: ProviderTest.model({
    id: ModelV2.ID.make("deepseek-v4-flash-free"),
    providerID: ProviderV2.ID.make("opencode"),
  }),
  getLanguage: Effect.fn("TestProvider.getLanguage")(() => Effect.succeed(fakeLanguage)),
})

const layer = Layer.mergeAll(
  Vcs.layer.pipe(
    Layer.provideMerge(Git.defaultLayer),
    Layer.provideMerge(EventV2Bridge.defaultLayer),
    Layer.provideMerge(provider.layer),
  ),
  CrossSpawnSpawner.defaultLayer,
  FSUtil.defaultLayer,
)
const it = testEffect(layer)

const gitText = Effect.fn("VcsCommitMessageTest.gitText")(function* (cwd: string, args: string[]) {
  const result = yield* Git.Service.use((git) => git.run(args, { cwd }))
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`)
  return result.text().trim()
})

const write = Effect.fn("VcsCommitMessageTest.write")(function* (file: string, content: string) {
  yield* FSUtil.Service.use((fs) => fs.writeWithDirs(file, content))
})

const init = Effect.fn("VcsCommitMessageTest.init")(function* () {
  const vcs = yield* Vcs.Service
  yield* vcs.init()
  return vcs
})

const promptTextAt = (index: number) => {
  const message = generateTextCalls[index]?.prompt.find((message) => message.role === "user")
  if (!message || message.role !== "user") return ""
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}
const promptText = () => promptTextAt(0)

describe("Vcs commit message generation", () => {
  beforeEach(() => {
    generateTextCalls.length = 0
    generatedText = "feat(cards): add elemental cards"
    generatedTexts = []
    generateErrors = []
    beforeGenerate = undefined
  })

  afterEach(async () => {
    await disposeAllInstances()
  })

  it.instance(
    "commitAuto sends staged patch content for all open changes to the model",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")
        yield* write(path.join(test.directory, "cards", "ice.ts"), "export const ice = { slow: 2 }\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toBe("feat(cards): add elemental cards")
        expect(generateTextCalls).toHaveLength(1)
        expect(generateTextCalls[0]?.maxOutputTokens).toBe(8192)
        expect(promptText()).toContain("Staged diff context:")
        expect(promptText()).toContain("### cards/fire.ts")
        expect(promptText()).toContain("+export const fire")
        expect(promptText()).toContain("### cards/ice.ts")
        expect(promptText()).toContain("+export const ice")
        expect(promptText()).toContain("Never describe the commit by file count")
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto chunk summaries reserve reasoning capacity instead of a small output cap",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        for (let index = 0; index < 12; index++) {
          yield* write(
            path.join(test.directory, "cards", `element-${index}.ts`),
            `export const element${index} = { damage: ${index} }\n`,
          )
        }

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toBe("feat(cards): add elemental cards")
        // 12 files split into two summary chunks plus the final generation;
        // every step must keep the reasoning-aware default budget.
        expect(generateTextCalls).toHaveLength(3)
        expect(generateTextCalls.map((call) => call.maxOutputTokens)).toEqual([8192, 8192, 8192])
      }),
    { git: true },
    30_000,
  )

  it.instance(
    "commitAuto repairs an unusable model message before committing",
    () =>
      Effect.gen(function* () {
        generatedTexts = ["refactor: update 2 files", "feat(cards): add elemental cards"]
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")
        yield* write(path.join(test.directory, "cards", "ice.ts"), "export const ice = { slow: 2 }\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toBe("feat(cards): add elemental cards")
        expect(generateTextCalls).toHaveLength(2)
        expect(promptTextAt(1)).toContain("Rejected answer:")
        expect(promptTextAt(1)).toContain("refactor: update 2 files")
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto uses a local fallback when repair is also unusable",
    () =>
      Effect.gen(function* () {
        generatedText = "refactor: update 2 files"
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")
        yield* write(path.join(test.directory, "cards", "ice.ts"), "export const ice = { slow: 2 }\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toBe("feat: add cards")
        expect(result.message).toMatch(/local fallback/i)
        expect(generateTextCalls).toHaveLength(2)
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto commits with a local fallback message when the model is quota exhausted",
    () =>
      Effect.gen(function* () {
        generateErrors = [
          new Error("Cursor retry exhausted after 3 attempts: Cursor API error (code=resource_exhausted)"),
        ]
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toMatch(/^(feat|fix|chore|docs|test)(\([a-z0-9._/-]+\))?: \S/)
        expect(result.message).toMatch(/AI commit message generation failed/i)
        expect(result.message).toMatch(/resource_exhausted/i)
        expect(result.message).toMatch(/local fallback/i)
        // the commit happened: the working tree is clean again
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
        expect(yield* gitText(test.directory, ["log", "-1", "--format=%s"])).toBe(result.commit ?? "")
        // quota errors must not burn additional attempts after the bounded retry
        expect(generateTextCalls).toHaveLength(1)
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto commits with a local fallback message when generation fails",
    () =>
      Effect.gen(function* () {
        generateErrors = [new Error("provider returned 401 authentication error")]
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.message).toMatch(/AI commit message generation failed/i)
        expect(result.message).toMatch(/authentication error/i)
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto aborts when the working tree changes during message generation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "cards", "fire.ts")
        yield* write(file, "export const fire = { damage: 5 }\n")
        beforeGenerate = async () => {
          beforeGenerate = undefined
          await Bun.write(file, "export const fire = { damage: 6 }\n")
        }

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/changes moved while the commit message was generated/i)
        expect(yield* gitText(test.directory, ["log", "-1", "--format=%s"])).not.toBe("feat(cards): add elemental cards")
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).not.toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto aborts when another writer changes HEAD during message generation",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")
        beforeGenerate = async () => {
          beforeGenerate = undefined
          const child = Bun.spawn(
            [
              "git",
              "-c",
              `safe.directory=${test.directory}`,
              "-C",
              test.directory,
              "commit",
              "-m",
              "test: external writer",
            ],
            { stdout: "pipe", stderr: "pipe" },
          )
          const code = await child.exited
          if (code !== 0) throw new Error(await new Response(child.stderr).text())
        }

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(false)
        expect(result.message).toMatch(/repository identity changed before commit/i)
        expect(yield* gitText(test.directory, ["log", "-1", "--format=%s"])).toBe("test: external writer")
        expect(generateTextCalls).toHaveLength(1)
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto serializes concurrent requests for the same repository",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* write(path.join(test.directory, "cards", "fire.ts"), "export const fire = { damage: 5 }\n")

        let enteredResolve: (() => void) | undefined
        let releaseResolve: (() => void) | undefined
        const entered = new Promise<void>((resolve) => {
          enteredResolve = resolve
        })
        const release = new Promise<void>((resolve) => {
          releaseResolve = resolve
        })
        beforeGenerate = async () => {
          beforeGenerate = undefined
          enteredResolve?.()
          await release
        }

        const vcs = yield* init()
        const first = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel }).pipe(Effect.forkChild)
        yield* Effect.promise(() => entered)
        const second = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel }).pipe(Effect.forkChild)

        expect(generateTextCalls).toHaveLength(1)
        releaseResolve?.()
        const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: 2 })

        expect(results.filter((result) => result.ok)).toHaveLength(1)
        expect(results.find((result) => !result.ok)?.message).toMatch(/no changes to commit/i)
        expect(generateTextCalls).toHaveLength(1)
        expect(yield* gitText(test.directory, ["log", "-1", "--format=%s"])).toBe("feat(cards): add elemental cards")
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto summarizes safe chunks before writing the final commit message",
    () =>
      Effect.gen(function* () {
        generateErrors = [new Error("maximum context length exceeded")]
        const test = yield* TestInstance
        yield* Effect.all(
          ["fire", "ice", "storm", "earth"].map((name) =>
            write(
              path.join(test.directory, "cards", `${name}.ts`),
              Array.from({ length: 2_500 }, (_, index) => `export const ${name}${index} = ${index}`).join("\n") + "\n",
            ),
          ),
          { concurrency: 4 },
        )

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toBe("feat(cards): add elemental cards")
        expect(generateTextCalls).toHaveLength(4)
        expect(promptTextAt(0).length).toBeGreaterThan(promptTextAt(1).length)
        expect(promptTextAt(3)).toContain("Subagent reports:")
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
      }),
    { git: true },
    20_000,
  )

  it.instance(
    "commitAuto commits with a local fallback when chunk summarization is quota exhausted",
    () =>
      Effect.gen(function* () {
        generateErrors = Array.from(
          { length: 8 },
          () => new Error("Failed after 3 attempts. Last error: Error from provider (Console): Usage limit reached"),
        )
        const test = yield* TestInstance
        yield* Effect.all(
          ["fire", "ice", "storm", "earth"].map((name) =>
            write(
              path.join(test.directory, "cards", `${name}.ts`),
              Array.from({ length: 2_500 }, (_, index) => `export const ${name}${index} = ${index}`).join("\n") + "\n",
            ),
          ),
          { concurrency: 4 },
        )

        const vcs = yield* init()
        const result = yield* vcs.gitAction({ action: "commitAuto", commitModel: testCommitModel })

        expect(result.ok).toBe(true)
        expect(result.commit).toMatch(/^feat: add cards\b/)
        expect(result.message).toMatch(/AI commit message generation failed/i)
        expect(result.message).toMatch(/Usage limit reached/i)
        expect(result.message).toMatch(/local fallback/i)
        expect(yield* gitText(test.directory, ["status", "--porcelain"])).toBe("")
        expect(yield* gitText(test.directory, ["log", "-1", "--format=%s"])).toBe(result.commit ?? "")
        // fail fast: only in-flight chunk calls ran, and no compact single-shot retry was sent at a dead quota
        expect(generateTextCalls.length).toBeLessThanOrEqual(4)
        for (const call of generateTextCalls) {
          const user = call.prompt.find((message) => message.role === "user")
          expect(user?.content.map((part) => ("text" in part ? part.text : "")).join("\n")).toContain(
            "Analyze staged change chunk",
          )
        }
      }),
    { git: true },
    20_000,
  )
})
