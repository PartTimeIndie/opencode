import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Context, Effect, Layer, Semaphore } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import fs from "fs/promises"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { rasterIcon, rasterSize } from "../lib/icon"

// The routes share the process-wide database; reset it around the suite so the
// directory icons stored here never leak into another test file.
const suiteLock = Semaphore.makeUnsafe(1)
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* suiteLock.take(1)
    yield* Effect.addFinalizer(() => suiteLock.release(1))
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, CrossSpawnSpawner.defaultLayer))
const handlerContext = Context.empty() as Context.Context<unknown>

function call(directory: string, method: "GET" | "PUT" | "POST", pathname: string, body?: unknown) {
  return Effect.promise(() =>
    HttpApiApp.webHandler().handler(
      new Request(`http://localhost${pathname}`, {
        method,
        headers: { "x-opencode-directory": directory, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }),
      handlerContext,
    ),
  )
}

describe("project directory icon HttpApi", () => {
  it.live("sets, lists and clears a directory icon through the canonical routes", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const folder = "e:\\gitrepros\\skills\\./"

      const empty = yield* call(directory, "GET", "/project/directory-icons")
      expect(empty.status).toBe(200)
      expect(yield* Effect.promise(() => empty.json())).toEqual([])

      const stored = yield* call(directory, "PUT", "/project/directory-icon", { directory: folder, url: rasterIcon(1024) })
      expect(stored.status).toBe(200)
      const storedBody = (yield* Effect.promise(() => stored.json())) as {
        directory: string
        icon: { override: string }
      }
      expect(storedBody.directory).toBe("e:/gitrepros/skills")
      expect(rasterSize(storedBody.icon.override)).toEqual({ width: 128, height: 128 })

      const listed = yield* call(directory, "GET", "/project/directory-icons")
      expect(yield* Effect.promise(() => listed.json())).toEqual([storedBody])

      const cleared = yield* call(directory, "PUT", "/project/directory-icon", { directory: "E:/GITREPROS/SKILLS" })
      expect(yield* Effect.promise(() => cleared.json())).toEqual({ directory: "e:/gitrepros/skills" })
      const again = yield* call(directory, "GET", "/project/directory-icons")
      expect(yield* Effect.promise(() => again.json())).toEqual([])
    }),
  )

  it.live("answers an undecodable icon with a typed 400", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const rejected = yield* call(directory, "PUT", "/project/directory-icon", {
        directory: "E:/GitRepros/Skills",
        url: "data:image/png;base64,abc123",
      })
      expect(rejected.status).toBe(400)
      expect(yield* Effect.promise(() => rejected.json())).toEqual({
        _tag: "Project.InvalidIconError",
        message: "The image could not be decoded or resized. Use a PNG, JPEG, WebP or GIF file.",
      })
      const listed = yield* call(directory, "GET", "/project/directory-icons")
      expect(yield* Effect.promise(() => listed.json())).toEqual([])
    }),
  )

  it.live("resolves a junction alias to the physical directory and reports missing folders", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const root = yield* tmpdirScoped()
      const real = path.join(root, "real", "project")
      yield* Effect.promise(() => fs.mkdir(real, { recursive: true }))
      const link = path.join(root, "link")
      yield* Effect.promise(() =>
        fs.symlink(path.join(root, "real"), link, process.platform === "win32" ? "junction" : "dir"),
      )
      const missing = path.join(root, "missing")

      const response = yield* call(directory, "POST", "/project/resolve", {
        directories: [path.join(link, "project"), missing, "global"],
      })
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual([
        { directory: path.join(link, "project"), real, exists: true },
        { directory: missing, real: missing, exists: false },
        { directory: "global", real: "global", exists: true },
      ])
    }),
  )
})
