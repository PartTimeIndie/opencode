import { describe, expect, test } from "bun:test"

const target = await import(
  new URL("../../../../.opencode/plugin-sources/git-workbench-app/commit-target.js", import.meta.url).href
)

describe("git workbench commit target", () => {
  test("uses the deterministic priority and never returns multiple commit targets", () => {
    expect(
      target.resolveCommitTarget({
        directWorktree: "C:\\repos\\direct",
        rememberedWorktree: "C:\\repos\\remembered",
        candidates: [{ worktree: "C:\\repos\\dirty", changeCount: 2 }],
      }),
    ).toEqual({ kind: "selected", directory: "C:\\repos\\direct", source: "direct" })
    expect(
      target.resolveCommitTarget({
        rememberedWorktree: "C:\\repos\\remembered",
        candidates: [{ worktree: "C:\\repos\\dirty", changeCount: 2 }],
      }),
    ).toEqual({ kind: "selected", directory: "C:\\repos\\remembered", source: "session" })
    expect(target.resolveCommitTarget({ candidates: [{ worktree: "C:\\repos\\dirty", changeCount: 2 }] })).toEqual({
      kind: "selected",
      directory: "C:\\repos\\dirty",
      source: "single-dirty",
    })

    const ambiguous = target.resolveCommitTarget({
      candidates: [
        { worktree: "C:\\repos\\two", name: "two", changeCount: 2 },
        { worktree: "C:\\repos\\one", name: "one", changeCount: 1 },
      ],
    })
    expect(ambiguous.kind).toBe("choose")
    expect(ambiguous.candidates.map((item: { name: string }) => item.name)).toEqual(["one", "two"])
  })

  test("treats truncated discovery as ambiguous instead of auto-selecting", () => {
    const result = target.resolveCommitTarget({
      candidates: [{ worktree: "C:\\repos\\one", name: "one", changeCount: 1 }],
      discoveryTruncated: true,
    })
    expect(result.kind).toBe("choose")
  })

  test("normalizes Windows paths and bounds persisted session targets", () => {
    let store = target.normalizeCommitTargetStore(undefined)
    for (let index = 0; index < 205; index++) {
      store = target.rememberCommitTarget(store, {
        sessionID: `session-${index}`,
        container: "C:\\GitRepros\\Skills",
        worktree: `c:/gitrepros/skills/repo-${index}`,
        updatedAt: index,
      })
    }
    expect(store.entries).toHaveLength(200)
    expect(store.entries[0].sessionID).toBe("session-204")
    expect(target.commitTargetForSession(store, "session-204", "C:/GITREPROS/SKILLS")?.worktree).toBe(
      "c:/gitrepros/skills/repo-204",
    )
    expect(target.commitTargetForSession(store, "session-204", "C:/somewhere-else")).toBeUndefined()
  })

  test("forgets stale targets without changing other sessions", () => {
    const store = target.normalizeCommitTargetStore({
      version: 1,
      entries: [
        { sessionID: "one", container: "/workspace", worktree: "/workspace/one", updatedAt: 1 },
        { sessionID: "two", container: "/workspace", worktree: "/workspace/two", updatedAt: 2 },
      ],
    })
    expect(
      target.forgetCommitTarget(store, "one").entries.map((entry: { sessionID: string }) => entry.sessionID),
    ).toEqual(["two"])
  })

  test("falls back to the requested directory for legacy Git snapshots", () => {
    expect(
      target.snapshotWorktree(
        {
          info: { branch: "dev", default_branch: "dev" },
          status: [{ file: "packages/app/src/plugin/app-runtime.tsx", code: " M" }],
        },
        "C:\\GitRepros\\opencode",
      ),
    ).toBe("C:\\GitRepros\\opencode")
    expect(
      target.snapshotWorktree(
        { info: { worktree: "C:\\Canonical\\opencode", branch: "dev" }, status: [] },
        "C:\\Requested\\opencode",
      ),
    ).toBe("C:\\Canonical\\opencode")
    expect(target.snapshotWorktree({ info: {}, status: [] }, "C:\\GitRepros\\opencode")).toBeUndefined()
  })
})
