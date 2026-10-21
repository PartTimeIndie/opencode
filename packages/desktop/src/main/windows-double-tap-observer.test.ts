import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createWindowsDoubleTapObserver } from "./windows-double-tap-observer"

function helper() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false,
    kill() { this.killed = true; return true },
  })
  return child
}

test("waits for readiness, parses fragmented events, and stops stale callbacks", async () => {
  const child = helper()
  let invoked = 0
  const observer = createWindowsDoubleTapObserver({ key: 67, modifiers: 1, onInvoke: () => invoked++, onFailure: () => {}, spawn: () => child as unknown as ChildProcessWithoutNullStreams })
  child.stdout.write('{"type":"ready"}\n{"type":"tap","time":1,')
  expect(await observer.ready).toEqual({ ok: true })
  child.stdout.write('"window":"10"}\n{"type":"tap","time":20,"window":"10"}\n')
  expect(invoked).toBe(1)
  observer.stop()
  child.stdout.write('{"type":"tap","time":30,"window":"10"}\n{"type":"tap","time":40,"window":"10"}\n')
  expect(invoked).toBe(1)
  expect(child.killed).toBe(true)
})

test("fails closed on malformed output and reports unexpected exit once", async () => {
  for (const output of ['garbage\n', 'x'.repeat(8193), '{"type":"tap","time":-1,"window":"10"}\n']) {
    const child = helper()
    let failures = 0
    const observer = createWindowsDoubleTapObserver({ key: 67, modifiers: 1, onInvoke() {}, onFailure: () => failures++, spawn: () => child as unknown as ChildProcessWithoutNullStreams })
    child.stdout.write(output)
    expect((await observer.ready).ok).toBe(false)
    child.emit("exit", 1)
    expect(child.killed).toBe(true)
    expect(failures).toBe(1)
  }
})

test("handles spawn/stdin errors and explicit cancellation during startup", async () => {
  for (const event of ["error", "stdin", "stop", "exit"]) {
    const child = helper()
    const observer = createWindowsDoubleTapObserver({ key: 67, modifiers: 1, onInvoke() {}, onFailure() {}, spawn: () => child as unknown as ChildProcessWithoutNullStreams })
    if (event === "error") child.emit("error", new Error("spawn failed"))
    if (event === "stdin") child.stdin.emit("error", new Error("broken pipe"))
    if (event === "stop") observer.stop()
    if (event === "exit") child.emit("exit", 1)
    expect((await observer.ready).ok).toBe(false)
    expect(child.killed).toBe(true)
  }
})
