import { describe, expect, test } from "bun:test"
import { Worktree } from "./worktree"
import { ServerScope } from "./server-scope"

const dir = (name: string) => `/tmp/opencode-worktree-${name}-${crypto.randomUUID()}`

describe("Worktree", () => {
  const scope = ServerScope.local
  test("normalizes trailing slashes", () => {
    const key = dir("normalize")
    Worktree.ready(scope, `${key}/`)

    expect(Worktree.get(scope, key)).toEqual({ status: "ready" })
  })

  test("pending does not overwrite a terminal state", () => {
    const key = dir("pending")
    Worktree.failed(scope, key, "boom")
    Worktree.pending(scope, key)

    expect(Worktree.get(scope, key)).toEqual({ status: "failed", message: "boom" })
  })

  test("wait resolves shared pending waiter when ready", async () => {
    const key = dir("wait-ready")
    Worktree.pending(scope, key)

    const a = Worktree.wait(scope, key)
    const b = Worktree.wait(scope, `${key}/`)

    expect(a).toBe(b)

    Worktree.ready(scope, key)

    expect(await a).toEqual({ status: "ready" })
    expect(await b).toEqual({ status: "ready" })
  })

  test("wait resolves with failure message", async () => {
    const key = dir("wait-failed")
    const waiting = Worktree.wait(scope, key)

    Worktree.failed(scope, key, "permission denied")

    expect(await waiting).toEqual({ status: "failed", message: "permission denied" })
    expect(await Worktree.wait(scope, key)).toEqual({ status: "failed", message: "permission denied" })
  })

  test("isolates identical directories by server scope", () => {
    const key = dir("scope")
    const remote = "https://debian.example" as ServerScope
    Worktree.ready(scope, key)
    Worktree.failed(remote, key, "remote failed")

    expect(Worktree.get(scope, key)).toEqual({ status: "ready" })
    expect(Worktree.get(remote, key)).toEqual({ status: "failed", message: "remote failed" })
  })

  test("resolves Windows waiters across path casing and separators", async () => {
    const pending = "C:\\Repo-A\\Worktree-Mixed-Case"
    const ready = "c:/repo-a/worktree-mixed-case/"

    Worktree.pending(scope, pending)
    const waiting = Worktree.wait(scope, pending)
    Worktree.ready(scope, ready)

    await expect(waiting).resolves.toEqual({ status: "ready" })
    expect(Worktree.get(scope, pending)).toEqual({ status: "ready" })
  })

  test("resolves UNC waiters after slash normalization", async () => {
    const pending = "\\\\Server\\Share\\Worktree-UNC"
    const failed = "//server/share/worktree-unc/"

    Worktree.pending(scope, pending)
    const waiting = Worktree.wait(scope, pending)
    Worktree.failed(scope, failed, "failed")

    await expect(waiting).resolves.toEqual({ status: "failed", message: "failed" })
  })
})
