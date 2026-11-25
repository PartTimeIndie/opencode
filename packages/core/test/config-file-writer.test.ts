import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { ConfigFileWriter } from "@opencode-ai/core/config/file-writer"
import { DelegationPreferences } from "@opencode-ai/core/session/delegation-preferences"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const fixture = <R>(body: (writer: ConfigFileWriter.Interface, directory: string) => Effect.Effect<void, unknown, R>) =>
  Effect.acquireUseRelease(Effect.promise(() => tmpdir()), (tmp) => Effect.gen(function* () {
    const writer = yield* ConfigFileWriter.Service
    yield* body(writer, tmp.path)
  }).pipe(Effect.provide(ConfigFileWriter.layer.pipe(Layer.provide(EffectFlock.layer.pipe(
    Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ state: path.join(tmp.path, "state") })),
  ))))), (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()))

describe("shared configuration file writer", () => {
  it.live("saves scoped delegation values with the same versioned writer while preserving JSONC and unknown keys", () => fixture((writer, directory) => Effect.gen(function* () {
    const target = { scope: "project" as const, file: path.join(directory, "opencode.jsonc") }
    yield* Effect.promise(() => fs.writeFile(target.file,
      '// user comment\n{ "future": { "keep": true }, "delegation": { "future_option": 42, "ordinaryQuestions": true } }\n'))
    const before = yield* DelegationPreferences.readDocument(writer, target)
    expect(before.value).toEqual({ ordinaryQuestions: true })
    const saved = yield* DelegationPreferences.patchDocument(writer, { ...target, expectedVersion: before.version,
      patch: { ordinaryQuestions: false, rules: [{ allowed: [{ agent: "builder" }] }] } })
    expect(saved.scope).toBe("project")
    expect(saved.value.ordinaryQuestions).toBe(false)
    const text = (yield* writer.read(target.file)).text
    expect(text).toContain("// user comment")
    expect(text).toContain('"future_option": 42')
    expect(text).toContain('"keep": true')
    expect((yield* DelegationPreferences.readDocument(writer, target)).value).toEqual(saved.value)
    const stale = yield* DelegationPreferences.patchDocument(writer, { ...target, expectedVersion: before.version,
      patch: { ordinaryQuestions: true } }).pipe(Effect.as("unexpected"),
      Effect.catchTag("ConfigFileWriter.Conflict", (error) => Effect.succeed(error.reason)))
    expect(stale).toBe("version")
    expect((yield* writer.read(target.file)).text).toBe(text)
    const cleared = yield* DelegationPreferences.patchDocument(writer, { ...target, expectedVersion: saved.version,
      patch: { ordinaryQuestions: null } })
    expect(cleared.value).toEqual({ rules: [{ allowed: [{ agent: "builder" }] }] })
    expect((yield* writer.read(target.file)).text).toContain('"future_option": 42')
  })))
  it.live("refuses malformed delegation documents without rewriting them or touching another scope", () => fixture((writer, directory) => Effect.gen(function* () {
    const project = path.join(directory, "project.jsonc")
    const global = { scope: "global" as const, file: path.join(directory, "global.jsonc") }
    const invalid = '{ "delegation": { "ordinaryQuestions": "off" } }'
    yield* Effect.promise(() => fs.writeFile(project, invalid))
    const before = yield* writer.read(project)
    const reason = yield* DelegationPreferences.patchDocument(writer, { scope: "project", file: project,
      expectedVersion: before.version, patch: { ordinaryQuestions: false } }).pipe(Effect.as("unexpected"),
      Effect.catchTag("DelegationPreferences.Invalid", (error) => Effect.succeed(error.reason)))
    expect(reason).toBe("state")
    expect((yield* writer.read(project)).text).toBe(invalid)
    const empty = yield* DelegationPreferences.readDocument(writer, global)
    const saved = yield* DelegationPreferences.patchDocument(writer, { ...global, expectedVersion: empty.version,
      patch: { ordinaryQuestions: false } })
    expect(saved.scope).toBe("global")
    expect((yield* writer.read(project)).text).toBe(invalid)
  })))
  it.live("compares versions under the lock and preserves the winning value", () => fixture((writer, directory) => Effect.gen(function* () {
    const file = path.join(directory, "settings.jsonc")
    const before = yield* writer.read(file)
    const saved = yield* writer.update({ file, expectedVersion: before.version }, () => Effect.succeed({ text: "// comment\n{\"theme\":\"dark\"}", value: "saved" }))
    expect(saved.value).toBe("saved")
    expect(saved.changed).toBe(true)
    const stale = yield* writer.update({ file, expectedVersion: before.version }, () => Effect.die("Stale prepare must not run"))
      .pipe(Effect.as("unexpected"), Effect.catchTag("ConfigFileWriter.Conflict", (error) => Effect.succeed(error.reason)))
    expect(stale).toBe("version")
    expect((yield* writer.read(file)).text).toBe(saved.snapshot.text)
    expect(saved.snapshot.mode).toBeDefined()
    const unchanged = yield* writer.update({ file, expectedVersion: saved.snapshot.version }, () => Effect.succeed({ text: saved.snapshot.text ?? "", value: 2 }))
    expect(unchanged.changed).toBe(false)
    expect(unchanged.snapshot.version).toBe(saved.snapshot.version)
  })))
  it.live("refuses outside edits during awaited preparation without replacing them", () => fixture((writer, directory) => Effect.gen(function* () {
    const file = path.join(directory, "config.json")
    yield* writer.update({ file }, () => Effect.succeed({ text: "initial", value: undefined }))
    const result = yield* Effect.exit(writer.update({ file }, () => Effect.gen(function* () {
      yield* Effect.promise(() => fs.writeFile(file, "external"))
      return { text: "stale replacement", value: undefined }
    })))
    expect(Exit.isFailure(result)).toBe(true)
    expect((yield* writer.read(file)).text).toBe("external")
  })))
  it.live("shares canonical locks across directory aliases and refuses retargeting", () => fixture((writer, directory) => Effect.gen(function* () {
    const first = path.join(directory, "first")
    const second = path.join(directory, "second")
    const alias = path.join(directory, "alias")
    yield* Effect.promise(async () => {
      await fs.mkdir(first)
      await fs.mkdir(second)
      await fs.symlink(first, alias, process.platform === "win32" ? "junction" : "dir")
    })
    const file = path.join(alias, "config.json")
    expect((yield* writer.read(file)).file).toBe((yield* writer.read(path.join(first, "config.json"))).file)
    const reason = yield* writer.update({ file }, () => Effect.promise(async () => {
      await fs.unlink(alias)
      await fs.symlink(second, alias, process.platform === "win32" ? "junction" : "dir")
      return { text: "not authorized for second", value: undefined }
    })).pipe(Effect.as("unexpected"), Effect.catchTag("ConfigFileWriter.Conflict", (error) => Effect.succeed(error.reason)))
    expect(reason).toBe("placement")
    expect((yield* writer.read(path.join(first, "config.json"))).text).toBeUndefined()
    expect((yield* writer.read(path.join(second, "config.json"))).text).toBeUndefined()
  })))
  it.live("serializes real separate writer processes without losing either update", () => fixture((_writer, directory) => Effect.gen(function* () {
    const file = path.join(directory, "shared.json")
    const workers = ["first", "second"].map((key) => Bun.spawn([process.execPath,
      path.join(import.meta.dir, "fixture", "config-file-writer.ts"), directory, file, key], { stdout: "pipe", stderr: "pipe" }))
    yield* Effect.addFinalizer(() => Effect.sync(() => { for (const worker of workers) if (worker.exitCode === null) worker.kill() }))
    const results = yield* Effect.promise(() => Promise.all(workers.map(async (worker) => ({ code: await worker.exited, error: await new Response(worker.stderr).text() }))))
    expect(results).toEqual([{ code: 0, error: "" }, { code: 0, error: "" }])
    const result = yield* Effect.promise(() => fs.readFile(file, "utf8"))
    expect(JSON.parse(result)).toEqual({ first: 5, second: 5 })
  })))
})
