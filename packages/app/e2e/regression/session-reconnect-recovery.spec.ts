import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionReconnectRecovery"
const projectID = "proj_session_reconnect_recovery"
const sessionID = "ses_session_reconnect_recovery"
const server = "http://127.0.0.1:4096"
const assistantText = "Persisted completion recovered without switching tabs."

test("refreshes the active timeline after the global event stream reconnects", async ({ page }) => {
  const mobile = process.env.VISUAL_QA_VIEWPORT === "mobile"
  const errors = trackPageErrors(page)
  const reads: { sessionID: string; settled: boolean }[] = []
  let connections = 0
  let settled = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "Session reconnect recovery",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", limit: { context: 200_000 } } },
        },
      ],
      connected: ["openai"],
      default: { providerID: "openai", modelID: "gpt-5.6-sol" },
    },
    agents: [{ name: "build", mode: "primary" }],
    sessions: [session()],
    pageMessages: () => ({ items: settled ? completedMessages() : [userMessage()] }),
    onMessages: (input) => {
      if (input.phase === "start") reads.push({ sessionID: input.sessionID, settled })
    },
    sessionStatus: () => ({ [sessionID]: { type: settled ? "idle" : "busy" } }),
    eventDelay: 1_500,
    eventRetry: 25,
    globalEvents: () => {
      connections++
      if (connections === 2) settled = true
      if (connections > 2) return []
      const connected = [
        {
          payload: {
            id: `evt_server_connected_${connections}`,
            type: "server.connected",
            properties: {},
          },
        },
      ]
      if (connections !== 2) return connected
      return [
        ...connected,
        {
          directory,
          payload: {
            type: "sync",
            syncEvent: {
              id: "evt_reconnect_interrupted",
              type: "session.next.activity.interrupted.1",
              seq: 1,
              aggregateID: sessionID,
              data: { sessionID, activityID: "activity_reconnect", timestamp: Date.now() },
            },
          },
        },
        {
          directory,
          payload: {
            type: "sync",
            syncEvent: {
              id: "evt_reconnect_turn_completed",
              type: "session.turn.completed.1",
              seq: 2,
              aggregateID: sessionID,
              data: { sessionID, status: "incomplete", timestamp: Date.now() },
            },
          },
        },
      ]
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, server, sessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", server, dirBase64, sessionId: sessionID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionID },
  )

  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 })
  await page.goto("/")

  const sessionTab = page.locator(`[data-dock-tab][data-session-id="${sessionID}"]`).getByRole("tab")
  await expectAppVisible(mobile ? page.getByRole("heading", { name: "Reconnect recovery" }) : sessionTab)
  await expect.poll(() => connections).toBeGreaterThanOrEqual(2)
  await expect.poll(() => reads.filter((read) => read.sessionID === sessionID && read.settled).length).toBeGreaterThan(0)
  await expectAppVisible(page.getByText(assistantText, { exact: true }))
  if (!mobile) {
    await expect(sessionTab).toHaveAttribute("aria-selected", "true")
    await expectAppVisible(
      page.locator(
        `[data-dock-tab][data-session-id="${sessionID}"] [data-slot="project-avatar-unread-dot"][data-status="incomplete"]`,
      ),
    )
  }
  expectNoSmokeErrors(errors, [], [])

  if (process.env.VISUAL_QA_SCREENSHOT) {
    await page.screenshot({ path: process.env.VISUAL_QA_SCREENSHOT, fullPage: true })
  }
})

function completedMessages() {
  return [
    userMessage(),
    {
      info: {
        id: "msg_reconnect_assistant",
        sessionID,
        role: "assistant",
        time: { created: 1_700_000_000_002, completed: 1_700_000_000_003 },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "gpt-5.6-sol",
        providerID: "openai",
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_reconnect_assistant_text",
          sessionID,
          messageID: "msg_reconnect_assistant",
          type: "text",
          text: assistantText,
        },
      ],
    },
  ]
}

function userMessage() {
  return {
    info: {
      id: "msg_reconnect_user",
      sessionID,
      role: "user",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      time: { created: 1_700_000_000_001 },
    },
    parts: [
      {
        id: "prt_reconnect_user_text",
        sessionID,
        messageID: "msg_reconnect_user",
        type: "text",
        text: "Finish while the event stream is disconnected.",
      },
    ],
  }
}

function session() {
  return {
    id: sessionID,
    slug: sessionID,
    projectID,
    directory,
    title: "Reconnect recovery",
    version: "dev",
    time: { created: 1_700_000_000_000, updated: 1_700_000_000_003 },
  }
}
