import { describe, expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { mkdir } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { Config } from "../../src/config/config"
import { AppPluginAssets } from "../../src/plugin/app/assets"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer } from "./httpapi-layer"

const stateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
        AppPluginAssets.resetForTesting()
      }),
    )
  }),
)
const it = testEffect(Layer.mergeAll(stateLayer, httpApiLayer, Config.defaultLayer))

describe("external plugin services over HTTP", () => {
  it.live("serializes optional service fields and rejects outputs without a JSON representation", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ capabilities: ["services:neutral-server:json"] })
      const response = yield* call(fixture, "json", "optional")
      expect({ status: response.status, body: yield* response.json }).toEqual({
        status: 200, body: { ok: true, data: { nested: { keep: 1 }, values: [null, "present"] } },
      })
      const invalid = yield* call(fixture, "json", "bigint")
      expect(invalid.status).toBe(503)
      expect(yield* invalid.json).toMatchObject({ message: "Plugin service output is not JSON serializable" })
    }), 30_000)
  for (const pluginID of ["opencode-runtime-services", "opencode-scheduler"]) {
    it.live(`loads the actual ${pluginID} package through its directory entry and lists over HTTP`, () =>
      Effect.gen(function* () {
        const fixture = yield* setup({
          serverPackage: pluginID,
          capabilities: [`services:${pluginID}:${pluginID === "opencode-scheduler" ? "jobs" : "list"}`],
        })
        const result = yield* call(fixture, pluginID === "opencode-scheduler" ? "jobs" : "list",
          pluginID === "opencode-scheduler" ? { method: "GET", path: "/scheduler/jobs" } : {}, { pluginID })
        const body = yield* result.json
        expect({ status: result.status, body }).toMatchObject({ status: 200, body: { ok: true } })
        expect(body).toMatchObject(pluginID === "opencode-scheduler"
          ? { data: { status: 200, body: { success: true, data: { jobs: [{ slug: "read-only-fixture" }] } } } }
          : { data: { ok: true } })
      }), 30_000)
  }

  it.live("provides the real Session service to external plugin callbacks", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const response = yield* HttpClientRequest.post("/api/session").pipe(
        HttpClientRequest.bodyJson({ location: { directory: fixture.directory } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(200)
      const target = (yield* response.json) as { data: { id: string } }
      const opened = yield* call(fixture, "sessions", target.data.id)
      const body = yield* opened.json
      expect(body).toMatchObject({ ok: true, data: { exists: true, link: { targetSessionID: target.data.id } } })
      expect(opened.status).toBe(200)
      const result = body as { data: { link: { sourceSessionID: string } } }
      const source = yield* HttpClientRequest.get(`/api/session/${result.data.link.sourceSessionID}`).pipe(HttpClient.execute)
      expect(source.status).toBe(200)
      expect(yield* source.json).toMatchObject({ data: { id: result.data.link.sourceSessionID, title: "Neutral plugin conversation" } })
    }), 30_000)
  it.live("authorizes session policy access and rejects foreign sessions and forged callers", () =>
    Effect.gen(function* () {
      const fixture = yield* setup({ capabilities: ["host:session-policy"] })
      const create = yield* HttpClientRequest.post("/api/session").pipe(
        HttpClientRequest.bodyJson({ location: { directory: fixture.directory } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(create.status).toBe(200)
      const created = (yield* create.json) as { data: { id: string } }
      const seeded = yield* HttpClientRequest.patch(`/session/${created.data.id}?directory=${encodeURIComponent(fixture.directory)}`).pipe(
        HttpClientRequest.bodyJson({ metadata: { retained: "value", access_control: { mode: "full_access", extra: "preserved", safety_review: { model: "test/reviewer" } } } }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(seeded.status).toBe(200)
      expect(yield* seeded.json).toMatchObject({ metadata: { retained: "value" } })
      const request = (action: "read" | "write", extra: Record<string, unknown> = {}, hash = fixture.hash, directory = fixture.directory) =>
        HttpClientRequest.post(`/app/host/session-policy?directory=${encodeURIComponent(directory)}`).pipe(
          HttpClientRequest.bodyJson({ caller: { id: "service-caller", version: fixture.version, hash }, action, ...extra }),
          Effect.flatMap(HttpClient.execute),
        )
      expect((yield* request("read", {}, "forged")).status).toBe(403)
      expect(yield* (yield* request("read")).json).toEqual({ ok: true, mode: "approve_for_me" })
      expect((yield* request("read", { sessionID: "ses_missing" })).status).toBe(400)
      expect((yield* request("write", { mode: "full_access" })).status).toBe(400)
      const write = yield* request("write", { sessionID: created.data.id, mode: "ask" })
      expect(write.status).toBe(200)
      expect(yield* write.json).toEqual({ ok: true, mode: "ask" })
      const read = yield* request("read", { sessionID: created.data.id })
      expect(yield* read.json).toEqual({ ok: true, mode: "ask" })
      const after = yield* HttpClientRequest.get(`/api/session/${created.data.id}`).pipe(HttpClient.execute)
      expect((yield* after.json) as unknown).toMatchObject({ data: { metadata: { retained: "value", access_control: { mode: "ask", extra: "preserved", safety_review: { model: "test/reviewer" } } } } })
      const foreign = yield* tmpdirScoped({ git: true })
      expect((yield* request("write", { sessionID: created.data.id, mode: "full_access" }, fixture.hash, foreign)).status).toBe(403)
    }), 30_000)

  it.live("requires the explicit policy capability even for a valid plugin identity", () =>
    Effect.gen(function* () {
      const fixture = yield* setup()
      const response = yield* HttpClientRequest.post(`/app/host/session-policy?directory=${encodeURIComponent(fixture.directory)}`).pipe(
        HttpClientRequest.bodyJson({ caller: { id: "service-caller", version: fixture.version, hash: fixture.hash }, action: "read" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(response.status).toBe(403)
    }), 30_000)

  it.live(
    "routes encoded scoped plugin identities without granting unrelated targets",
    () =>
      Effect.gen(function* () {
        const pluginID = "@neutral/server"
        const fixture = yield* setup({ serverID: pluginID })
        const response = yield* call(fixture, "double", 7, { pluginID })
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ ok: true, data: 14 })
        expect((yield* call(fixture, "double", 7)).status).toBe(403)
      }),
    30_000,
  )
  it.live(
    "loads a neutral external plugin and injects its owner and project context",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const response = yield* call(fixture, "echo", { text: "Hallo", pluginID: "spoof", directory: "foreign" })
        expect(response.status).toBe(200)
        const result = (yield* response.json) as { ok: boolean; data: Record<string, unknown> }
        expect(result.ok).toBe(true)
        expect(result.data.text).toBe("Hallo")
        expect(result.data.pluginID).toBe("neutral-server")
        expect(result.data.callerPluginID).toBe("service-caller")
        expect(String(result.data.directory).toLowerCase()).toBe(fixture.directory.toLowerCase())
        expect(result.data.projectID).toBeString()
        const doubled = yield* call(fixture, "double", 6)
        expect(doubled.status).toBe(200)
        expect(yield* doubled.json).toEqual({ ok: true, data: 12 })
      }),
    30_000,
  )

  it.live(
    "requires the exact manifest capability and a verified caller hash",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ capabilities: ["services:neutral-server:echo"] })
        const wrongService = yield* call(fixture, "double", 6)
        expect(wrongService.status).toBe(403)
        const wrongHash = yield* call({ ...fixture, hash: "forged" }, "echo", { text: "x" })
        expect(wrongHash.status).toBe(403)
        const wrongTarget = yield* call(fixture, "echo", { text: "x" }, { pluginID: "other-server" })
        expect(wrongTarget.status).toBe(403)
        const spoofed = yield* call(fixture, "double", { value: 6, capabilities: ["services:neutral-server:double"] })
        expect(spoofed.status).toBe(403)
      }),
    30_000,
  )

  it.live(
    "rejects incompatible versions, invalid input and invalid plugin output",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        const version = yield* call(fixture, "echo", { text: "x" }, { version: 2 })
        expect(version.status).toBe(400)
        expect(yield* version.json).toMatchObject({ message: "Service requires version 1; requested 2" })
        const input = yield* call(fixture, "double", "not a number")
        expect(input.status).toBe(400)
        const output = yield* call(fixture, "broken", 1)
        expect(output.status).toBe(503)
        expect(yield* output.json).toMatchObject({ service: "broken" })
      }),
    30_000,
  )

  it.live(
    "unloads registered services with the server instance and reloads cleanly",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup()
        expect((yield* call(fixture, "double", 2)).status).toBe(200)
        const disposed = yield* HttpClientRequest.post(
          `/instance/dispose?directory=${encodeURIComponent(fixture.directory)}`,
        ).pipe(HttpClient.execute)
        expect(disposed.status).toBe(200)
        expect(yield* disposed.json).toBe(true)
        // The HTTP response is intentionally sent before instance teardown.
        yield* pollWithTimeout(
          Effect.promise(async () =>
            (await Bun.file(path.join(fixture.directory, "hook-disposed.txt")).exists()) ? true : undefined,
          ),
          "plugin cleanup never completed",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "service-disposed.txt")).text())).toBe(
          "disposed",
        )
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "hook-disposed.txt")).text())).toBe(
          "after-services",
        )
        const replacement = yield* call(fixture, "double", 3)
        expect(replacement.status).toBe(200)
        expect(yield* replacement.json).toEqual({ ok: true, data: 6 })
      }),
    30_000,
  )

  it.live(
    "cleans registrations when external plugin initialization fails",
    () =>
      Effect.gen(function* () {
        const fixture = yield* setup({ failInitialization: true })
        const response = yield* call(fixture, "echo", { text: "x" })
        expect(response.status).toBe(503)
        expect(yield* Effect.promise(() => Bun.file(path.join(fixture.directory, "service-disposed.txt")).text())).toBe(
          "disposed",
        )
      }),
    30_000,
  )
})

function call(
  fixture: { directory: string; version: string; hash: string },
  serviceID: string,
  input: unknown,
  options: { version?: number; pluginID?: string } = {},
) {
  return HttpClientRequest.post(
    `/plugins/${encodeURIComponent(options.pluginID ?? "neutral-server")}/services/${serviceID}?directory=${encodeURIComponent(fixture.directory)}`,
  ).pipe(
    HttpClientRequest.bodyJson({
      caller: { id: "service-caller", version: fixture.version, hash: fixture.hash },
      version: options.version ?? 1,
      input,
    }),
    Effect.flatMap(HttpClient.execute),
  )
}

function setup(options: { capabilities?: string[]; failInitialization?: boolean; serverID?: string; serverPackage?: string } = {}) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped({ git: true })
    const config = yield* Config.Service
    const previous = Global.Path.config
    const previousXdg = process.env.XDG_CONFIG_HOME
    if (options.serverPackage) process.env.XDG_CONFIG_HOME = path.join(directory, "isolated-plugin-config")
    ;(Global.Path as { config: string }).config = directory
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        if (options.serverPackage) {
          if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
          else process.env.XDG_CONFIG_HOME = previousXdg
        }
        yield* config.invalidate()
      }),
    )
    yield* Effect.promise(async () => {
      const appDirectory = path.join(directory, ".opencode/plugins/service-caller")
      await mkdir(appDirectory, { recursive: true })
      await Bun.write(
        path.join(directory, ".opencode/app.jsonc"),
        JSON.stringify({ plugin: ["./plugins/service-caller"] }),
      )
      await Bun.write(
        path.join(appDirectory, "package.json"),
        JSON.stringify({
          name: "service-caller",
          version: "1.0.0",
          type: "module",
          exports: { "./app": "./index.js" },
          opencode: {
            app: {
              capabilities:
                options.capabilities ??
                ["echo", "double", "broken", "sessions"].map((id) => `services:${options.serverID ?? "neutral-server"}:${id}`),
            },
          },
        }),
      )
      await Bun.write(path.join(appDirectory, "index.js"), "export default { id: 'service-caller', app() {} }")
      const file = path.join(directory, "neutral-server.ts")
      await Bun.write(
        file,
        `
        import { z } from ${JSON.stringify(import.meta.resolve("zod"))}
        export default {
          id: ${JSON.stringify(options.serverID ?? "neutral-server")},
          async server(input) {
            input.services.register({
              id: "echo", version: 1, input: z.object({ text: z.string() }),
              output: z.object({ text: z.string(), pluginID: z.string(), callerPluginID: z.string(), directory: z.string(), projectID: z.string() }),
              execute(value, context) { return { text: value.text, pluginID: context.pluginID, callerPluginID: context.callerPluginID, directory: context.directory, projectID: context.projectID } },
              async dispose() { await Bun.write(input.directory + "/service-disposed.txt", "disposed") },
            })
            input.services.register({ id: "double", version: 1, input: z.number(), output: z.number(), execute(value) { return value * 2 } })
            input.services.register({ id: "broken", version: 1, input: z.number(), output: z.number(), execute() { return "invalid output" } })
            input.services.register({ id: "json", version: 1, input: z.string(), output: z.unknown(), execute(value) {
              return value === "bigint" ? 1n : { omitted: undefined, nested: { missing: undefined, keep: 1 }, values: [undefined, "present"] }
            } })
            input.services.register({ id: "sessions", version: 1, input: z.string(), output: z.unknown(), async execute(targetSessionID) {
              const exists = await input.host.sessions.exists(targetSessionID)
              const execution = await input.host.sessions.execution.read({sessionID: targetSessionID, messageID: "msg_not_admitted"})
              const link = await input.host.sessions.links.start({ sourceSessionID: "ses_neutral_" + crypto.randomUUID().replaceAll("-", ""), targetSessionID, agent: "build", title: "Neutral plugin conversation", permissionPolicy: "single-use" })
              return { exists, execution, link }
            } })
            ${
              options.failInitialization
                ? 'throw new Error("Deliberate initialization failure")'
                : `return {
              async dispose() {
                const stopped = await Bun.file(input.directory + "/service-disposed.txt").exists()
                await Bun.write(input.directory + "/hook-disposed.txt", stopped ? "after-services" : "before-services")
              }
            }`
            }
          }
        }
      `,
      )
      const packageDirectory = path.join(directory, "server-package")
      if (options.serverPackage) {
        // Use the durable package source and its real manifest, then detach the generated bundle.
        const source = path.resolve(import.meta.dirname, "../../../../..", options.serverPackage)
        const manifest = await Bun.file(path.join(source, "package.json")).json()
        const result = await Bun.build({ entrypoints: [path.join(source, "src/index.ts")], outdir: path.join(packageDirectory, "dist"), target: "node" })
        if (!result.success) throw new AggregateError(result.logs, "Server package build failed")
        await Bun.write(path.join(packageDirectory, "package.json"), JSON.stringify(manifest))
        if (options.serverPackage === "opencode-scheduler") {
          await Bun.write(path.join(directory, "isolated-plugin-config/opencode/scheduler/scopes/test/jobs/read-only-fixture.json"), JSON.stringify({
            scopeId: "test", slug: "read-only-fixture", name: "Read-only fixture", schedule: "0 9 * * *", prompt: "Never executed",
          }))
        }
      }
      await Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(options.serverPackage ? packageDirectory + path.sep : file).href] }))
      await Promise.all([markPluginDependenciesReady(directory), markPluginDependenciesReady(path.join(directory, ".opencode"))])
    })
    yield* config.invalidate()
    AppPluginAssets.resetForTesting()
    const caller = (yield* Effect.promise(() => AppPluginAssets.clientManifest(directory))).plugins[0]!
    return { directory, version: caller.version, hash: caller.hash }
  })
}
