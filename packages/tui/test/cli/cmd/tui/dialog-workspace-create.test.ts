import { describe, expect, test } from "bun:test"
import {
  recentConnectedWorkspaces,
  warpReminderText,
  warpWorkspaceSession,
} from "../../../../src/component/dialog-workspace-create"
import { sendMoveReminder } from "../../../../src/component/prompt/move"

describe("recentConnectedWorkspaces", () => {
  test("returns connected workspaces sorted by time used", () => {
    const workspaces = [
      { id: "wrk_a", name: "alpha", timeUsed: 700 },
      { id: "wrk_b", name: "beta", timeUsed: 800 },
      { id: "wrk_c", name: "gamma", timeUsed: 400 },
      { id: "wrk_d", name: "delta", timeUsed: 300 },
      { id: "wrk_e", name: "epsilon", timeUsed: 200 },
    ]
    const status = {
      wrk_a: "connected",
      wrk_b: "disconnected",
      wrk_c: "error",
      wrk_d: "connected",
      wrk_e: "connected",
    } as const

    const { recent } = recentConnectedWorkspaces({
      workspaces,
      status: (workspaceID) => status[workspaceID as keyof typeof status],
    })

    expect(recent.map((workspace) => workspace.id)).toEqual(["wrk_a", "wrk_d", "wrk_e"])
  })
})

describe("synthetic workspace reminders", () => {
  test("warps sessions with a v2 synthetic reminder", async () => {
    const syntheticCalls: { sessionID: string; text: string }[] = []
    const cleared: string[] = []
    const directory = "C:\\repo\\workspace"

    const result = await warpWorkspaceSession({
      dialog: {
        clear: () => {
          cleared.push("clear")
        },
      },
      sdk: {
        client: {
          experimental: {
            workspace: {
              warp: async () => ({ data: { ok: true } }),
            },
          },
          v2: {
            session: {
              synthetic: async (input: { sessionID: string; text?: string }) => {
                if (!input.text) throw new Error("missing synthetic text")
                syntheticCalls.push({ sessionID: input.sessionID, text: input.text })
              },
            },
          },
        },
      },
      sync: {
        path: { directory: "" },
        bootstrap: async () => undefined,
        session: { refresh: async () => undefined },
      },
      project: {
        instance: { directory: () => directory },
        workspace: {
          set: () => undefined,
          sync: async () => undefined,
        },
      },
      toast: { show: () => undefined },
      workspaceID: "wrk_target",
      sessionID: "ses_warp",
      copyChanges: true,
    } as unknown as Parameters<typeof warpWorkspaceSession>[0])

    expect(result).toBe(true)
    expect(syntheticCalls).toEqual([{ sessionID: "ses_warp", text: warpReminderText(directory) }])
    expect(cleared).toEqual(["clear"])
  })

  test("moves sessions with a v2 synthetic reminder", async () => {
    const syntheticCalls: { sessionID: string; text: string }[] = []
    const directory = "C:\\repo\\moved"

    await sendMoveReminder({
      sdk: {
        client: {
          v2: {
            session: {
              synthetic: async (input) => {
                syntheticCalls.push(input)
              },
            },
          },
        },
      },
      sessionID: "ses_move",
      directory,
    })

    expect(syntheticCalls).toEqual([{ sessionID: "ses_move", text: warpReminderText(directory) }])
  })
})
