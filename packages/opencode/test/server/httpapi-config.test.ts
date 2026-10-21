import { afterEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { registerDisposer } from "../../src/effect/instance-registry"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { Global } from "@opencode-ai/core/global"

function app() {
  return Server.Default().app
}

function v2Agents(directory: string) {
  return Effect.promise(() =>
    Promise.resolve(
      app().request(`/api/agent?${new URLSearchParams({ "location[directory]": directory })}`),
    ),
  )
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const reasons: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((directory, reason) => {
            if (directory === tmp.path) reasons.push(reason)
            return Promise.resolve()
          }),
        ),
        (off) => Effect.sync(off),
      ).pipe(Effect.asVoid)
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(reasons).toContain("reload")
      expect(reasons).not.toContain("dispose")
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".opencode", "opencode.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
    15_000,
  )

  it.live(
    "refreshes only the updated project's V2 agent policy after a normal config patch",
    Effect.gen(function* () {
      const project = yield* tmpdirEffect({
        git: true,
        config: { formatter: false, lsp: false },
        init: async (directory) => {
          await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
          await Bun.write(path.join(directory, ".opencode", "opencode.json"), "{}")
        },
      })
      const other = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const before = yield* v2Agents(project.path)
      const otherBefore = yield* v2Agents(other.path)
      expect(before.status).toBe(200)
      expect(otherBefore.status).toBe(200)

      const beforeBody = (yield* Effect.promise(() => before.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, unknown> } }>
      }
      const otherBeforeBody = (yield* Effect.promise(() => otherBefore.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, unknown> } }>
      }
      expect(beforeBody.data.find((agent) => agent.id === "build")?.tools?.entries).not.toHaveProperty(
        "computer-use_computer",
      )
      expect(otherBeforeBody.data.find((agent) => agent.id === "build")?.tools?.entries).not.toHaveProperty(
        "computer-use_computer",
      )

      const update = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            "x-opencode-directory": project.path,
          },
          body: JSON.stringify({
            agent: {
              build: {
                tools: {
                  mode: "explicit",
                  entries: {
                    read: { visible: true, permission: "allow" },
                    "computer-use_computer": {
                      visible: true,
                      delegable: false,
                      permission: "allow",
                      scope: { mode: "projects", projects: [project.path] },
                    },
                  },
                },
              },
            },
          }),
        }),
      )
      )
      expect(update.status).toBe(200)

      const after = yield* v2Agents(project.path)
      const otherAfter = yield* v2Agents(other.path)
      expect(after.status).toBe(200)
      expect(otherAfter.status).toBe(200)
      const afterBody = (yield* Effect.promise(() => after.json())) as {
        data: Array<{
          id: string
          tools?: {
            mode: string
            entries?: Record<string, { visible?: boolean; permission?: string; delegable?: boolean; scope?: unknown }>
          }
        }>
      }
      const otherAfterBody = (yield* Effect.promise(() => otherAfter.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, unknown> } }>
      }
      expect(afterBody.data.find((agent) => agent.id === "build")?.tools).toMatchObject({
        mode: "explicit",
        entries: {
          "computer-use_computer": {
            visible: true,
            delegable: false,
            permission: "allow",
            scope: { mode: "projects", projects: [project.path] },
          },
        },
      })
      expect(otherAfterBody.data.find((agent) => agent.id === "build")?.tools?.entries).not.toHaveProperty(
        "computer-use_computer",
      )

      const repeatedUpdate = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": project.path,
            },
            body: JSON.stringify({
              agent: {
                build: {
                  tools: {
                    mode: "explicit",
                    entries: {
                      read: { visible: true, permission: "allow" },
                      "computer-use_computer": {
                        visible: true,
                        delegable: false,
                        permission: "deny",
                        scope: { mode: "projects", projects: [project.path] },
                      },
                    },
                  },
                },
              },
            }),
          }),
        ),
      )
      expect(repeatedUpdate.status).toBe(200)
      const repeated = yield* v2Agents(project.path)
      const repeatedOther = yield* v2Agents(other.path)
      const repeatedBody = (yield* Effect.promise(() => repeated.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, { permission?: string }> } }>
      }
      const repeatedOtherBody = (yield* Effect.promise(() => repeatedOther.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, unknown> } }>
      }
      expect(repeatedBody.data.find((agent) => agent.id === "build")?.tools?.entries).toMatchObject({
        "computer-use_computer": { permission: "deny" },
      })
      expect(repeatedOtherBody.data.find((agent) => agent.id === "build")?.tools?.entries).not.toHaveProperty(
        "computer-use_computer",
      )
    }),
    30_000,
  )

  it.live(
    "refreshes an agent policy without reloading the active instance or another project",
    Effect.gen(function* () {
      const project = yield* tmpdirEffect({
        git: true,
        config: { formatter: false, lsp: false },
        init: async (directory) => {
          await fs.mkdir(path.join(directory, ".opencode"), { recursive: true })
          await Bun.write(path.join(directory, ".opencode", "opencode.json"), "{}")
        },
      })
      const other = yield* tmpdirEffect({ git: true, config: { formatter: false, lsp: false } })
      const reasons: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((directory, reason) => {
            if (directory === project.path || directory === other.path) reasons.push(`${directory}:${reason}`)
            return Promise.resolve()
          }),
        ),
        (off) => Effect.sync(off),
      ).pipe(Effect.asVoid)

      const otherBefore = yield* v2Agents(other.path)
      expect(otherBefore.status).toBe(200)

      const update = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": project.path,
            },
            body: JSON.stringify({
              agent: {
                build: {
                  tools: {
                    mode: "explicit",
                    entries: {
                      read: { visible: true, permission: "allow" },
                      "computer-use_computer": {
                        visible: true,
                        permission: "allow",
                        scope: { mode: "projects", projects: [project.path] },
                      },
                    },
                  },
                },
              },
            }),
          }),
        ),
      )
      expect(update.status).toBe(200)

      const after = yield* v2Agents(project.path)
      const otherAfter = yield* v2Agents(other.path)
      expect(after.status).toBe(200)
      expect(otherAfter.status).toBe(200)
      const afterBody = (yield* Effect.promise(() => after.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, unknown> } }>
      }
      const otherAfterBody = (yield* Effect.promise(() => otherAfter.json())) as {
        data: Array<{ id: string; tools?: { entries?: Record<string, unknown> } }>
      }
      expect(afterBody.data.find((agent) => agent.id === "build")?.tools?.entries).toHaveProperty(
        "computer-use_computer",
      )
      expect(otherAfterBody.data.find((agent) => agent.id === "build")?.tools?.entries).not.toHaveProperty(
        "computer-use_computer",
      )
      expect(reasons).toEqual([])
    }),
    30_000,
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )

  it.live(
    "does not reload instances for access-control project config updates",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const reasons: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((directory, reason) => {
            if (directory === tmp.path) reasons.push(reason)
            return Promise.resolve()
          }),
        ),
        (off) => Effect.sync(off),
      ).pipe(Effect.asVoid)

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ access_control: { mode: "full_access" } }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        access_control: { mode: "full_access" },
      })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(reasons).toEqual([])
    }),
  )

  it.live(
    "clears omitted fields from complete global settings sections",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({
            access_control: {
              mode: "ask",
              safety_review: { model: "test/reviewer", prompt: "custom prompt" },
            },
            vision: {
              enabled: true,
              primary: { model: "test/vision" },
              prompt_template: "custom template",
            },
          }),
        ),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              access_control: { safety_review: {} },
              vision: { enabled: true },
            }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      const config = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
      expect(config).toMatchObject({
        access_control: { mode: "ask", safety_review: {} },
        vision: { enabled: true },
      })
      expect(config).not.toHaveProperty("access_control.safety_review.model")
      expect(config).not.toHaveProperty("access_control.safety_review.prompt")
      expect(config).not.toHaveProperty("vision.primary")
      expect(config).not.toHaveProperty("vision.prompt_template")
    }),
  )

  it.live(
    "does not dispose instances for runtime-safe global config updates",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const global = yield* tmpdirEffect({})
      const reasons: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((directory, reason) => {
            if (directory === tmp.path) reasons.push(reason)
            return Promise.resolve()
          }),
        ),
        (off) => Effect.sync(off),
      ).pipe(Effect.asVoid)

      const load = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )
      expect(load.status).toBe(200)

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ optimization: { profile: "off" }, access_control: { mode: "full_access" } }),
          }),
        ),
      )
      expect(response.status).toBe(200)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(reasons).toEqual([])
    }),
  )

  it.live(
    "serves a global config update that clears the default model chain through null",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      const config = {
        model_chains: [{ id: "chain-a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }],
        default_model_chain: "chain-a",
      }
      yield* Effect.promise(() =>
        Bun.write(path.join(global.path, "opencode.json"), JSON.stringify(config)),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ default_model_chain: null }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body.default_model_chain).toBeUndefined()
      expect(body.model_chains).toHaveLength(1)
      const written = yield* Effect.promise(() => Bun.file(path.join(global.path, "opencode.json")).json())
      expect(written).not.toHaveProperty("default_model_chain")
      expect(written.model_chains).toHaveLength(1)
    }),
  )

  it.live(
    "persists a default model chain set on a stored config that lacks the key",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      // The lost-default state: chains are stored, the default key is gone.
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({
            model_chains: [{ id: "chain-a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }],
          }),
        ),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ default_model_chain: "chain-a" }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body.default_model_chain).toBe("chain-a")
      expect(body.model_chains).toHaveLength(1)
      const written = yield* Effect.promise(() => Bun.file(path.join(global.path, "opencode.json")).json())
      expect(written.default_model_chain).toBe("chain-a")
      expect(written.model_chains).toHaveLength(1)
    }),
  )

  it.live(
    "keeps the stored default model chain when an unrelated patch omits it",
    Effect.gen(function* () {
      const global = yield* tmpdirEffect({})
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(
          path.join(global.path, "opencode.json"),
          JSON.stringify({
            model_chains: [{ id: "chain-a", name: "A", steps: [{ providerID: "p", modelID: "m" }] }],
            default_model_chain: "chain-a",
          }),
        ),
      )

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ small_model: "p/other" }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      const body = yield* Effect.promise(() => response.json())
      expect(body.default_model_chain).toBe("chain-a")
      const written = yield* Effect.promise(() => Bun.file(path.join(global.path, "opencode.json")).json())
      expect(written.default_model_chain).toBe("chain-a")
      expect(written.model_chains).toHaveLength(1)
    }),
  )

  it.live(
    "finishes required global instance disposal before returning the config update",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const global = yield* tmpdirEffect({})
      const gate = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const reasons: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          registerDisposer((directory, reason) => {
            if (directory !== tmp.path) return Promise.resolve()
            reasons.push(reason)
            started.resolve()
            return gate.promise
          }),
        ),
        (off) => Effect.sync(off),
      ).pipe(Effect.asVoid)

      const load = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-opencode-directory": tmp.path },
          }),
        ),
      )
      expect(load.status).toBe(200)

      const update = Promise.resolve(
        app().request("/global/config", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "reload-after-write" }),
        }),
      )
      yield* Effect.promise(() => started.promise)
      const settled = { value: false }
      update.finally(() => {
        settled.value = true
      })
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      expect(settled.value).toBe(false)

      gate.resolve()
      const response = yield* Effect.promise(() => update)
      expect(response.status).toBe(200)
      expect(reasons).toContain("all")
    }),
    15_000,
  )

  it.live(
    "returns the config update when a wedged instance disposer misses the reload deadline",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const global = yield* tmpdirEffect({})
      const reasons: string[] = []
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.OPENCODE_CONFIG_RELOAD_DISPOSE_DEADLINE_MS
          process.env.OPENCODE_CONFIG_RELOAD_DISPOSE_DEADLINE_MS = "500"
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_CONFIG_RELOAD_DISPOSE_DEADLINE_MS
            else process.env.OPENCODE_CONFIG_RELOAD_DISPOSE_DEADLINE_MS = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(path.join(global.path, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" })),
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          // A disposer that never settles mirrors wedged plugin shutdowns: the
          // per-instance timeout frees the server, but nothing frees the
          // config-update response unless the deadline bounds the wait.
          registerDisposer((directory, reason) => {
            if (directory !== tmp.path) return Promise.resolve()
            reasons.push(reason)
            return new Promise<void>(() => {})
          }),
        ),
        (off) => Effect.sync(off),
      ).pipe(Effect.asVoid)

      const load = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )
      expect(load.status).toBe(200)

      // Subscribe before the update: the disposed event may fire while the
      // response is in flight, and the bus listener only sees future events.
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))
      const startedAt = Date.now()
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ agent: { build: { description: "chain save" } } }),
          }),
        ),
      )
      const waitedMs = Date.now() - startedAt

      // The write is committed and answered even though disposal is still stuck.
      // Waiting past the wedged disposer's own per-instance timeout means the
      // response is again blocked on instance disposal.
      expect(waitedMs).toBeLessThan(4_000)
      expect(response.status).toBe(200)
      const written = yield* Effect.promise(() => Bun.file(path.join(global.path, "opencode.json")).json())
      expect(written).toMatchObject({ agent: { build: { description: "chain save" } } })

      // The reload disposal still runs to its own per-instance timeout.
      yield* Fiber.join(disposed)
      expect(reasons).toContain("all")
    }),
    20_000,
  )

  // Additive: two directories share one global generation; a reload-required
  // global PATCH retires both entries and both fresh reads serve the new
  // generation. Narrow claim — this loads finished entries before the PATCH
  // (no active dependency wait asserted) and uses a reload-required agent
  // field. It does NOT prove an in-flight dependency join survived.
  it.live(
    "both directories serve the new generation after a reload-required global update",
    Effect.gen(function* () {
      const first = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const second = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const global = yield* tmpdirEffect({})
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = Global.Path.config
          ;(Global.Path as { config: string }).config = global.path
          return previous
        }),
        (previous) =>
          Effect.sync(() => {
            ;(Global.Path as { config: string }).config = previous
          }),
      ).pipe(Effect.asVoid)
      yield* Effect.promise(() =>
        Bun.write(path.join(global.path, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" })),
      )

      for (const tmp of [first, second]) {
        const load = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/config", {
              headers: { "x-opencode-directory": tmp.path },
            }),
          ),
        )
        expect(load.status).toBe(200)
      }

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/global/config", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agent: { build: { description: "two-directory-reload" } } }),
          }),
        ),
      )
      expect(response.status).toBe(200)

      for (const tmp of [first, second]) {
        const reread = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/config", {
              headers: { "x-opencode-directory": tmp.path },
            }),
          ),
        )
        expect(reread.status).toBe(200)
        expect(yield* Effect.promise(() => reread.json())).toMatchObject({
          agent: { build: { description: "two-directory-reload" } },
        })
      }
    }),
    20_000,
  )
})
