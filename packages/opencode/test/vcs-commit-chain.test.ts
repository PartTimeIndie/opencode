import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Git } from "../src/git"
import { HeadlessAI } from "../src/headless-ai"

const { Effect, Layer } = await import("effect")
const { ModelV2 } = await import("@opencode-ai/core/model")
const { ProviderV2 } = await import("@opencode-ai/core/provider")
const { createOpenAI } = await import("@ai-sdk/openai")
const { Vcs } = await import("../src/project/vcs")
const { ProviderTest } = await import("./fake/provider")
const { testEffect } = await import("./lib/effect")

const chainSteps = [
  { providerID: "zhipuai-coding-plan", modelID: "glm-5.3" },
  { providerID: "openai", modelID: "gpt-5.6-sol" },
]

let openAIBaseURL = "http://127.0.0.1:1/v1"

const glm = ProviderTest.model({
  id: ModelV2.ID.make("glm-5.3"),
  providerID: ProviderV2.ID.make("zhipuai-coding-plan"),
  api: { id: ModelV2.ID.make("glm-5.3"), url: "https://zhipuai.example/v1", npm: "@ai-sdk/openai" },
})
const sol = ProviderTest.model({
  id: ModelV2.ID.make("gpt-5.6-sol"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: ModelV2.ID.make("gpt-5.6-sol"), url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
})
const chainModels = new Map([
  [`${glm.providerID}/${glm.id}`, glm],
  [`${sol.providerID}/${sol.id}`, sol],
])

const provider = ProviderTest.fake({
  model: glm,
  getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
    const mdl = chainModels.get(`${providerID}/${modelID}`)
    if (mdl) return Effect.succeed(mdl)
    return Effect.die(new Error(`Unknown test model: ${providerID}/${modelID}`))
  }),
  getLanguage: Effect.fn("TestProvider.getLanguage")((model) =>
    Effect.succeed(createOpenAI({ apiKey: "test-key", baseURL: openAIBaseURL }).responses(model.id)),
  ),
})

const it = testEffect(Layer.mergeAll(Git.defaultLayer, HeadlessAI.layer).pipe(Layer.provide(provider.layer)))

function sse(input: unknown) {
  return `event: ${(input as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(input)}\n\n`
}

// Local OpenAI-responses endpoint: the exhausted GLM step answers 429 with a
// resource_exhausted error body, every other model streams `successText`.
function quotaFallbackServer(successText: string) {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ url: string; requests: string[]; close: () => Promise<void> }>((resolve, reject) => {
          const requests: string[] = []
          const server = createServer((request, response) => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end()
              return
            }
            const chunks: Buffer[] = []
            request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
            request.on("end", () => {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { model?: string }
              requests.push(body.model ?? "")
              if (body.model === "glm-5.3") {
                response.writeHead(429, { "content-type": "application/json" })
                response.end(
                  JSON.stringify({
                    error: {
                      message: "resource_exhausted: quota exceeded for this billing period",
                      type: "quota_error",
                    },
                  }),
                )
                return
              }
              response.writeHead(200, { "content-type": "text/event-stream" })
              response.end(
                [
                  sse({
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "message", id: "msg_test" },
                  }),
                  sse({ type: "response.output_text.delta", item_id: "msg_test", delta: successText }),
                  sse({
                    type: "response.output_item.done",
                    output_index: 0,
                    item: { type: "message", id: "msg_test" },
                  }),
                  sse({
                    type: "response.completed",
                    response: {
                      id: "resp_test",
                      usage: {
                        input_tokens: 1,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens: 1,
                        output_tokens_details: { reasoning_tokens: 0 },
                      },
                    },
                  }),
                  "data: [DONE]\n\n",
                ].join(""),
              )
            })
          })
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (!address || typeof address === "string") {
              reject(new Error("quota fallback server did not bind to TCP"))
              return
            }
            resolve({
              url: `http://127.0.0.1:${address.port}/v1`,
              requests,
              close: () => new Promise((done) => server.close(() => done())),
            })
          })
        }),
    ),
    (server) => Effect.promise(() => server.close()).pipe(Effect.ignore),
  )
}

function gitOut(dir: string, args: string[]) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`)
  return proc.stdout.toString()
}

function gitMaybe(dir: string, args: string[]) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, stdout: "pipe", stderr: "pipe" })
  return proc.exitCode === 0 ? proc.stdout.toString().trim() || undefined : undefined
}

async function initRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-vcs-commit-chain-"))
  gitOut(dir, ["init", "-b", "main"])
  gitOut(dir, ["config", "user.email", "commit-chain@test.local"])
  gitOut(dir, ["config", "user.name", "Commit Chain Test"])
  await writeFile(path.join(dir, "feature.txt"), "staged change\n")
  return dir
}

// Mirrors Vcs's internal gitIdentity so commitAuto accepts the identity lock.
async function repoIdentity(dir: string) {
  const worktree = gitOut(dir, ["rev-parse", "--show-toplevel"]).trim()
  const commonDir = gitOut(dir, ["rev-parse", "--git-common-dir"]).trim()
  const [realWorktree, realCommonDir, commonStat] = await Promise.all([
    realpath(path.resolve(dir, worktree)),
    realpath(path.resolve(dir, commonDir)),
    stat(path.resolve(dir, commonDir)),
  ])
  return {
    worktree: path.resolve(dir, worktree),
    commonDir: path.resolve(dir, commonDir),
    realWorktree,
    realCommonDir,
    commonDirDevice: commonStat.dev,
    commonDirInode: commonStat.ino,
    head: gitMaybe(dir, ["rev-parse", "--verify", "HEAD"]),
  }
}

// Any property access means commitAuto touched git before validating the chain
// request; the tests below assert the access log stays empty.
function untouchedGit(accessed: string[]) {
  return new Proxy({} as Git.Interface, {
    get(_target, property) {
      accessed.push(String(property))
      throw new Error(`git.${String(property)} must not be used before the chain request is validated`)
    },
  })
}

const refusedHeadless = {
  text: () => Effect.die(new Error("headless ai must not be called")),
  object: () => Effect.die(new Error("headless ai must not be called")),
} as HeadlessAI.Interface

const testIdentity = () => ({
  worktree: "C:/unused/worktree",
  commonDir: "C:/unused/worktree/.git",
  realWorktree: "C:/unused/worktree",
  realCommonDir: "C:/unused/worktree/.git",
  commonDirDevice: 0,
  commonDirInode: 0,
})

describe("Vcs.commitAuto chain request validation", () => {
  test("fails before staging when useChain=true arrives without a snapshot", async () => {
    const accessed: string[] = []
    const result = await Effect.runPromise(
      Vcs.commitAuto(untouchedGit(accessed), refusedHeadless, testIdentity(), { action: "commitAuto", useChain: true }, undefined),
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain("no chain snapshot was provided")
    expect(accessed).toEqual([])
  })

  test("fails before staging when the attached snapshot is invalid", async () => {
    for (const input of [
      { action: "commitAuto", useChain: true, commitChain: { steps: [] } },
      { action: "commitAuto", useChain: true, commitChain: "not-a-chain" },
      { action: "commitAuto", useChain: true, commitChain: { steps: "nope" } },
      { action: "commitAuto", commitChain: { steps: [] } },
    ] as const) {
      const accessed: string[] = []
      const result = await Effect.runPromise(
        Vcs.commitAuto(untouchedGit(accessed), refusedHeadless, testIdentity(), input, undefined),
      )
      expect(result.ok).toBe(false)
      expect(result.message).toContain("AI commit model chain is invalid")
      expect(accessed).toEqual([])
    }
  })
})

describe("Vcs.commitAuto model chain execution", () => {
  it.live("commits on the next chain step after resource_exhausted on GLM", () =>
    Effect.gen(function* () {
      const server = yield* quotaFallbackServer("feat: commit message from the second chain step")
      openAIBaseURL = server.url
      const dir = yield* Effect.promise(initRepo)
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(dir, { recursive: true, force: true })))
      const git = yield* Git.Service
      const headless = yield* HeadlessAI.Service
      const identity = yield* Effect.promise(() => repoIdentity(dir))
      const result = yield* Vcs.commitAuto(
        git,
        headless,
        identity,
        { action: "commitAuto", useChain: true, commitChain: { steps: chainSteps } },
        undefined,
      )
      expect(result.ok).toBe(true)
      expect(result.commit).toBe("feat: commit message from the second chain step")
      expect(server.requests[0]).toBe("glm-5.3")
      expect(server.requests[server.requests.length - 1]).toBe("gpt-5.6-sol")
      expect(server.requests.filter((model) => model === "gpt-5.6-sol")).toHaveLength(1)
      const subject = yield* Effect.promise(async () => gitOut(dir, ["log", "-1", "--pretty=%s"]))
      expect(subject.trim()).toBe("feat: commit message from the second chain step")
    }))

  it.live("keeps the configured single commit model on explicit opt-out even with a snapshot attached", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(initRepo)
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(dir, { recursive: true, force: true })))
      const git = yield* Git.Service
      const captured: Array<{ model?: string; chain?: unknown }> = []
      const capturingHeadless = {
        text: (input: { model?: string; chain?: unknown }) => {
          captured.push({ model: input.model, chain: input.chain })
          return Effect.succeed({ text: "chore: single model opt out", model: input.model ?? "single" })
        },
        object: () => Effect.die(new Error("headless object generation must not be called")),
      } as unknown as HeadlessAI.Interface
      const identity = yield* Effect.promise(() => repoIdentity(dir))
      const result = yield* Vcs.commitAuto(
        git,
        capturingHeadless,
        identity,
        {
          action: "commitAuto",
          useChain: false,
          commitModel: "zhipuai-coding-plan/glm-5.3",
          commitChain: { steps: chainSteps },
        },
        undefined,
      )
      expect(result.ok).toBe(true)
      expect(captured).toHaveLength(1)
      expect(captured[0]?.model).toBe("zhipuai-coding-plan/glm-5.3")
      expect(captured[0]?.chain).toBeUndefined()
      const subject = yield* Effect.promise(async () => gitOut(dir, ["log", "-1", "--pretty=%s"]))
      expect(subject.trim()).toBe("chore: single model opt out")
    }))
})
