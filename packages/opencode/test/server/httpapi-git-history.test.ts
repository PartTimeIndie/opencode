import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapGraph } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Session } from "../../src/session/session"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Focused HTTP contract for the branch-filtered history endpoints: real
// routing, payload schemas, structured error codes and cursor continuation
// against a temporary Git repository.

const instanceStoreLayer = InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrapGraph.defaultLayer))
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrapGraph.defaultLayer),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})

const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
    CrossSpawnSpawner.defaultLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

const fastImport = (cwd: string, stream: string) => {
  const result = spawnSync("git", ["fast-import", "--quiet"], { cwd, input: stream })
  if (result.status !== 0) throw new Error(`git fast-import failed: ${result.stderr.toString()}`)
}

const gitSpawn = (cwd: string, args: string[]) => {
  const result = spawnSync("git", args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const commitBlock = (mark: number, message: string, options: { from?: number; fromRef?: string } = {}) => {
  const data = Buffer.from(message, "utf8")
  return [
    "commit refs/heads/main",
    `mark :${mark}`,
    "committer Test User <test@example.com> 1700000000 +0000",
    `data ${data.length}`,
    message,
    ...(options.from ? [`from :${options.from}`] : options.fromRef ? [`from ${options.fromRef}`] : []),
    "",
  ].join("\n")
}

function post(path: string, directory: string, body: unknown) {
  return HttpClientRequest.post(`${path}?directory=${encodeURIComponent(directory)}`).pipe(
    HttpClientRequest.setHeaders({ "content-type": "application/json" }),
    HttpClientRequest.bodyJson(body as Record<string, unknown>),
    Effect.flatMap((request) => HttpClient.execute(request)),
    Effect.flatMap((response) =>
      Effect.map(response.text, (text) => ({
        status: response.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      })),
    ),
  )
}

describe("httpapi git history", () => {
  it.effect(
    "returns 413 for a page whose git walk exceeds the output budget",
    () => Effect.gen(function* () {
      const cwd = yield* tmpdirScoped({ git: true })
      const branch = gitSpawn(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
      const largeAuthor = "X".repeat(2_100_000)
      const stream = commitBlock(1, "oversized walk", { fromRef: "HEAD" })
        .replace("refs/heads/main", `refs/heads/${branch}`)
        .replace("committer Test User", `author ${largeAuthor} <test@example.com> 1700000000 +0000\ncommitter Test User`)
      fastImport(cwd, stream)
      const response = yield* post("/vcs/git/history", cwd, { selector: "head", limit: 1 })
      expect(response.status).toBe(413)
      expect((response.body.data as Record<string, unknown>).code).toBe("output_limit")
    }),
    45_000,
  )

  it.effect(
    "serves anchored pages, structured errors and commit message chunks",
    () =>
      Effect.gen(function* () {
        const cwd = yield* tmpdirScoped({ git: true })
        const branch = gitSpawn(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
        const blocks = [
          commitBlock(1, "first", { fromRef: "HEAD" }),
          commitBlock(2, "second", { from: 1 }),
          commitBlock(3, `third\n\n${"x".repeat(16_376)}€-tail`, { from: 2 }),
        ]
          .join("\n")
          .replaceAll("refs/heads/main", `refs/heads/${branch}`)
        fastImport(cwd, blocks)

        const headOid = gitSpawn(cwd, ["rev-parse", "HEAD"])

        const firstPageResponse = yield* post("/vcs/git/history", cwd, { selector: "head", limit: 2 })
        expect(firstPageResponse.status).toBe(200)
        const firstPage = firstPageResponse.body as unknown as {
          commits: { hash: string; subject: string; bodyTruncated: boolean; boundary: string }[]
          hasMore: boolean
          nextCursor?: string
          selector: string
          firstParent: boolean
        }
        expect(firstPage.commits.map((commit) => commit.subject)).toEqual(["third", "second"])
        expect(firstPage.hasMore).toBe(true)
        expect(firstPage.nextCursor).toBeDefined()
        expect(firstPage.selector).toBe("head")
        expect(firstPage.firstParent).toBe(false)

        const cursor = firstPage.nextCursor
        const continuation = yield* post("/vcs/git/history", cwd, { cursor })
        expect(continuation.status).toBe(200)
        const continuationPage = continuation.body as unknown as { commits: { subject: string }[]; hasMore: boolean }
        expect(continuationPage.commits.map((commit) => commit.subject)).toEqual([
          "first",
          expect.stringMatching(/^root commit/),
        ])
        expect(continuationPage.hasMore).toBe(false)

        const invalidRef = yield* post("/vcs/git/history", cwd, { selector: "branch", ref: "refs/heads/nope", limit: 10 })
        expect(invalidRef.status).toBe(400)
        expect(invalidRef.body.name).toBe("VcsGitHistoryError")
        expect((invalidRef.body.data as Record<string, unknown>).code).toBe("invalid_ref")
        expect((invalidRef.body.data as Record<string, unknown>).recovery).toBe("change-selection")

        const badCursor = yield* post("/vcs/git/history", cwd, { cursor: "not-a-cursor" })
        expect(badCursor.status).toBe(400)
        expect((badCursor.body.data as Record<string, unknown>).code).toBe("invalid_cursor")

        const allFirstParent = yield* post("/vcs/git/history", cwd, { selector: "all", firstParent: true, limit: 10 })
        expect(allFirstParent.status).toBe(400)
        expect((allFirstParent.body.data as Record<string, unknown>).code).toBe("invalid_ref")

        const conflicting = yield* post("/vcs/git/history", cwd, { cursor, limit: 5 })
        expect(conflicting.status).toBe(400)
        expect((conflicting.body.data as Record<string, unknown>).code).toBe("invalid_cursor")

        // A changed shallow boundary must surface as 409 with a refresh hint
        // (distinct error schema identity, not the 400 class).
        const gitDir = gitSpawn(cwd, ["rev-parse", "--git-dir"])
        const shallowPath = path.isAbsolute(gitDir) ? path.join(gitDir, "shallow") : path.join(cwd, gitDir, "shallow")
        const boundary = gitSpawn(cwd, ["rev-parse", "HEAD"])
        yield* Effect.promise(() => Bun.write(shallowPath, `${boundary}\n`))
        const stale = yield* post("/vcs/git/history", cwd, { cursor })
        expect(stale.status).toBe(409)
        expect(stale.body.name).toBe("VcsGitHistoryError")
        expect((stale.body.data as Record<string, unknown>).code).toBe("shallow_changed")
        expect((stale.body.data as Record<string, unknown>).recovery).toBe("refresh")
        yield* Effect.promise(() => Bun.write(shallowPath, "").catch(() => undefined))
        const message = yield* post("/vcs/git/commit-message", cwd, { hash: headOid })
        expect(message.status).toBe(200)
        const messagePage = message.body as unknown as { text: string; truncated: boolean; nextCursor?: string }
        expect(messagePage.truncated).toBe(true)
        expect(messagePage.text).not.toContain("�")
        const rest = yield* post("/vcs/git/commit-message", cwd, { cursor: messagePage.nextCursor })
        expect(rest.status).toBe(200)
        const restPage = rest.body as unknown as { text: string; truncated: boolean }
        expect(restPage.truncated).toBe(false)
        expect(messagePage.text + restPage.text).toBe(`third\n\n${"x".repeat(16_376)}€-tail`)

        const missingObject = yield* post("/vcs/git/commit-message", cwd, { hash: "a".repeat(40) })
        expect(missingObject.status).toBe(502)
        expect((missingObject.body.data as Record<string, unknown>).code).toBe("process_failed")
      }),
    30_000,
  )
})
