import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Duration, Effect, Layer, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger, rotateLogFile } from "../../src/observability/logging"
import { resource } from "../../src/observability/otlp"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const opencodeClient = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (opencodeClient === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = opencodeClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=anomalyco,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["opencode.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.OPENCODE_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "opencode.client=web,service.instance.id=override,service.namespace=anomalyco"

    expect(resource().attributes).toMatchObject({
      "opencode.client": "cli",
      "service.namespace": "anomalyco",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
    expect(resource().attributes["opencode.run"]).toMatch(/^[0-9a-f]{8}$/)
  })
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("file logger rotates during a running logger and retains only recent generations", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-rotation-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  await Effect.gen(function* () {
    yield* Effect.logInfo("first-runtime-batch")
    yield* Effect.sleep(Duration.millis(200))
    yield* Effect.logInfo("second-runtime-batch")
    yield* Effect.sleep(Duration.millis(200))
    yield* Effect.logInfo("third-runtime-batch")
    yield* Effect.sleep(Duration.millis(200))
  }).pipe(
    Effect.provide(
      Logger.layer([
        fileLogger(file, "runtime", { maxBytes: 150, generations: 2, batchWindow: Duration.millis(20) }),
      ]),
    ),
    Effect.scoped,
    Effect.runPromise,
  )

  expect(await Bun.file(`${file}.2`).text()).toContain("first-runtime-batch")
  expect(await Bun.file(`${file}.1`).text()).toContain("second-runtime-batch")
  expect(await Bun.file(file).text()).toContain("third-runtime-batch")
  expect(await Bun.file(`${file}.3`).exists()).toBe(false)
})

test("parallel loggers serialize writes and rotation without losing entries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-rotation-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const write = (id: string) =>
    Effect.forEach(
      Array.from({ length: 20 }, (_, index) => index),
      (index) => Effect.logInfo(`${id}-${index}`),
    ).pipe(
      Effect.provide(
        Logger.layer([
          fileLogger(file, id, { maxBytes: 1_500, generations: 8, batchWindow: Duration.millis(2) }),
        ]),
      ),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("writer-a"), write("writer-b")], { concurrency: "unbounded" }))

  const logs = (
    await Promise.all(
      (await Array.fromAsync(fs.glob("opencode.log{,.[0-9]*}", { cwd: dir }))).map((name) => Bun.file(path.join(dir, name)).text()),
    )
  ).join("")
  expect(Array.from({ length: 20 }, (_, index) => `message=writer-a-${index}`).every((entry) => logs.includes(entry))).toBe(true)
  expect(Array.from({ length: 20 }, (_, index) => `message=writer-b-${index}`).every((entry) => logs.includes(entry))).toBe(true)
  expect(await Bun.file(`${file}.lock`).exists()).toBe(false)
})

test("file logger recovers a stale lock left by a dead process", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-rotation-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  await fs.mkdir(`${file}.lock`)
  await fs.writeFile(path.join(`${file}.lock`, "owner"), "2147483647\n0\n")
  await fs.utimes(`${file}.lock`, new Date(0), new Date(0))

  await Effect.logInfo("after-stale-lock").pipe(
    Effect.provide(
      Logger.layer([
        fileLogger(file, "recovery", {
          batchWindow: Duration.millis(1),
          lockStaleMilliseconds: 1,
          lockWaitMilliseconds: 1_000,
        }),
      ]),
    ),
    Effect.scoped,
    Effect.runPromise,
  )

  expect(await Bun.file(file).text()).toContain("after-stale-lock")
  expect(await Bun.file(`${file}.lock`).exists()).toBe(false)
})

test("rotation keeps the active pathname and truncates it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-rotation-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  await fs.writeFile(file, "current-log")

  await rotateLogFile(file, 4, 3)

  expect(await Bun.file(file).text()).toBe("")
  expect(await Bun.file(`${file}.1`).text()).toBe("current-log")
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})
