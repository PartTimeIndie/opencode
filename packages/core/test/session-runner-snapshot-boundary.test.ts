import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  SNAPSHOT_BOUNDARY_TIMEOUT_MS,
  snapshotBoundaryTimeoutMs,
  withSnapshotBoundary,
} from "@opencode-ai/core/session/runner/llm"

const withBoundaryOverride = async <A>(value: string | undefined, run: () => Promise<A>) => {
  const previous = process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS
  if (value === undefined) delete process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS
  else process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS = value
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS
    else process.env.OPENCODE_SNAPSHOT_BOUNDARY_TIMEOUT_MS = previous
  }
}

test("hanging snapshot waits fail open after the boundary timeout", async () => {
  const result = await withBoundaryOverride("10", () =>
    Effect.runPromise(withSnapshotBoundary("test-end", Effect.never)),
  )
  expect(result).toBeUndefined()
})

test("snapshot results pass through the boundary untouched", async () => {
  const result = await withBoundaryOverride("10", () =>
    Effect.runPromise(withSnapshotBoundary("test-end", Effect.succeed("abc123"))),
  )
  expect(result).toBe("abc123")
})

test("the boundary default is bounded regardless of override misuse", async () => {
  expect(snapshotBoundaryTimeoutMs()).toBe(SNAPSHOT_BOUNDARY_TIMEOUT_MS)
  expect(await withBoundaryOverride("0", () => Promise.resolve(snapshotBoundaryTimeoutMs()))).toBe(
    SNAPSHOT_BOUNDARY_TIMEOUT_MS,
  )
  expect(await withBoundaryOverride("-5", () => Promise.resolve(snapshotBoundaryTimeoutMs()))).toBe(
    SNAPSHOT_BOUNDARY_TIMEOUT_MS,
  )
})

test("operators may tighten the boundary but never lift the hard cap", async () => {
  expect(await withBoundaryOverride("10", () => Promise.resolve(snapshotBoundaryTimeoutMs()))).toBe(10)
  expect(await withBoundaryOverride("999999999", () => Promise.resolve(snapshotBoundaryTimeoutMs()))).toBe(
    SNAPSHOT_BOUNDARY_TIMEOUT_MS,
  )
})
