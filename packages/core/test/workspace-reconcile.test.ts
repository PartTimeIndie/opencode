import { describe, expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import childProcess from "node:child_process"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { WorkspaceReconcile } from "@opencode-ai/core/session/workspace/reconcile"
import { it } from "./lib/effect"

const file = (text: string, mode = 0o644): WorkspaceReconcile.File => ({ bytes: new TextEncoder().encode(text), mode })
const text = (value: WorkspaceReconcile.File | undefined) => value === undefined ? undefined : new TextDecoder().decode(value.bytes)
const entry = (basis: WorkspaceReconcile.File | undefined, child: WorkspaceReconcile.File | undefined, main: WorkspaceReconcile.File | undefined) => ({ path: "file.txt", basis, child, main })

describe("native workspace three-way preparation", () => {
  it.live("retains inherited dirty content and resolves one-sided additions, updates and deletions", () => Effect.gen(function* () {
    for (const [basis, child, main, expected] of [
      ["dirty", "dirty", "new Main", "new Main"],
      ["dirty", "child", "dirty", "child"],
      [undefined, "new child", undefined, "new child"],
      [undefined, undefined, "new Main", "new Main"],
      ["dirty", undefined, "dirty", undefined],
      ["dirty", "dirty", undefined, undefined],
      ["dirty", "same", "same", "same"],
    ]) {
      const convert = (value: string | undefined) => value === undefined ? undefined : file(value)
      const result = yield* WorkspaceReconcile.prepare([entry(convert(basis), convert(child), convert(main))])
      expect(result.status).toBe("ready")
      if (result.status !== "ready") return yield* Effect.die("Expected ready candidate")
      expect(text(result.files[0]?.file)).toBe(expected)
      expect(text(result.basis[0]?.file)).toBe(main)
    }
  }))
  it.live("interrupts only its merge process and observes real close before removing private inputs", () => Effect.gen(function* () {
    const exec = childProcess.execFile
    const started = Promise.withResolvers<{ directory: string; closed: Promise<boolean> }>()
    const spy = spyOn(childProcess, "execFile").mockImplementation(Object.assign((command: string, ...args: unknown[]) => {
      expect(command).toBe("git")
      const options = args[1]
      if (!options || typeof options !== "object" || !("cwd" in options) || typeof options.cwd !== "string")
        throw new Error("Missing private merge directory")
      const directory = options.cwd
      // Only replace the executable, not its lifecycle: this is a real owned
      // process whose close event must precede the production finalizer.
      const process = exec(globalThis.process.execPath, ["-e", "setInterval(() => {}, 60000)"], { cwd: directory, windowsHide: true })
      const closed = new Promise<boolean>((resolve) => process.once("close", () => resolve(existsSync(directory))))
      started.resolve({ directory, closed })
      return process
    }, { __promisify__: exec.__promisify__ }))
    yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()))
    const fiber = yield* WorkspaceReconcile.prepare([entry(file("base\n"), file("child\n"), file("Main\n"))]).pipe(Effect.forkChild)
    const merge = yield* Effect.promise(() => started.promise)
    expect(existsSync(merge.directory)).toBe(true)
    const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber))
    expect(yield* Effect.promise(() => merge.closed)).toBe(true)
    yield* Fiber.join(interrupted)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && exit.cause.reasons.every(Cause.isInterruptReason)).toBe(true)
    expect(yield* Effect.promise(() => fs.stat(merge.directory).then(() => true, () => false))).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
  }))
  it.live("merges separated text edits without overwriting either author", () => Effect.gen(function* () {
    const basis = "first\nsecond\nthird\nfourth\nfifth\nsixth\nlast\n"
    const result = yield* WorkspaceReconcile.prepare([entry(file(basis), file(basis.replace("first", "child first")), file(basis.replace("last", "Main last")))])
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return yield* Effect.die("Expected nonoverlapping text merge")
    expect(text(result.files[0]?.file)).toBe(basis.replace("first", "child first").replace("last", "Main last"))
  }))
  it.live("rejects text, binary, deletion, competing-addition and mode conflicts with no partial result", () => Effect.gen(function* () {
    const cases = [
      { item: entry(file("base\n"), file("child\n"), file("Main\n")), reason: "content" },
      { item: entry(file("base\0"), file("child\0"), file("Main\0")), reason: "binary" },
      { item: entry(file("base"), undefined, file("Main")), reason: "delete" },
      { item: entry(file("base"), file("child"), undefined), reason: "delete" },
      { item: entry(undefined, file("child"), file("Main")), reason: "delete" },
      { item: entry(file("base", 0o644), file("base", 0o755), file("base", 0o600)), reason: "mode" },
    ] as const
    for (const item of cases) {
      const result = yield* WorkspaceReconcile.prepare([item.item, { ...entry(file("a"), file("b"), file("a")), path: "clean.txt" }])
      expect(result).toEqual({ status: "conflicts", conflicts: [{ path: "file.txt", reason: item.reason }] })
      expect(result).not.toHaveProperty("files")
      expect(result).not.toHaveProperty("basis")
    }
  }))
  it.live("combines one-sided modes and bytes and preserves matching simultaneous modes", () => Effect.gen(function* () {
    for (const [basis, child, main] of [
      [file("base"), file("base", 0o755), file("Main")],
      [file("base"), file("child"), file("base", 0o755)],
      [file("base"), file("child", 0o755), file("base", 0o755)],
    ]) {
      const result = yield* WorkspaceReconcile.prepare([entry(basis, child, main)])
      if (result.status !== "ready") return yield* Effect.die("Expected independent mode merge")
      expect(result.files[0]?.file?.mode).toBe(0o755)
      expect(text(result.files[0]?.file)).toBe(text(child) === "base" ? "Main" : "child")
    }
  }))
  it.live("copies caller bytes before asynchronous merge preparation", () => Effect.gen(function* () {
    const source = entry(file("basis"), file("child"), file("basis"))
    const result = yield* WorkspaceReconcile.prepare([source])
    if (result.status !== "ready") return yield* Effect.die("Expected ready candidate")
    source.child?.bytes.fill(120)
    source.main?.bytes.fill(121)
    expect(text(result.files[0]?.file)).toBe("child")
    expect(text(result.basis[0]?.file)).toBe("basis")
  }))
  it.live("refuses unsafe and colliding paths and unsupported modes", () => Effect.gen(function* () {
    const value = entry(file("a"), file("b"), file("a"))
    for (const entries of [
      [{ ...value, path: "../escape" }],
      [{ ...value, path: ".git/config" }],
      [value, { ...value, path: value.path.toUpperCase() }],
      [{ ...value, child: file("b", 0o1000) }],
    ]) expect(Exit.isFailure(yield* Effect.exit(WorkspaceReconcile.prepare(entries)))).toBe(true)
  }))
  it.live("isolates candidate and basis bytes from each other and across paths", () => Effect.gen(function* () {
    for (const childMode of [0o644, 0o755]) {
      const main = file("Main")
      const items = ["first.txt", "second.txt"].map((path) => ({ ...entry(file("base"), file("base", childMode), main), path }))
      const result = yield* WorkspaceReconcile.prepare(items)
      if (result.status !== "ready") return yield* Effect.die("Expected ready candidate")
      result.files[0]?.file?.bytes.fill(120)
      expect(text(result.files[1]?.file)).toBe("Main")
      expect(result.basis.map((item) => text(item.file))).toEqual(["Main", "Main"])
      result.basis[1]?.file?.bytes.fill(121)
      expect(text(result.basis[0]?.file)).toBe("Main")
      expect(text(result.files[1]?.file)).toBe("Main")
    }
  }))
})
