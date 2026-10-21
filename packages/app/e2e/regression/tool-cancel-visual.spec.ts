import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ToolCancelVisual"
const projectID = "proj_tool_cancel_visual"
const sessionID = "ses_tool_cancel_visual"
const userMessageID = "msg_tool_cancel_user"
const assistantMessageID = "msg_tool_cancel_assistant"
const pendingPartID = "prt_tool_cancel_pending"
const runningPartID = "prt_tool_cancel_running"
const title = "Tool cancel visual QA"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

test.describe("regression: tool cancel affordance", () => {
  for (const viewport of [
    { name: "desktop", width: 1280, height: 720 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`shows cancel only for running tools on ${viewport.name}`, async ({ page }) => {
      const cancels: { sessionID: string; callID: string }[] = []
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await mockServer(page, cancels)

      await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
      await expectSessionTitle(page, title)
      await settle(page)

      const running = page.locator(`[data-timeline-part-id="${runningPartID}"]`).first()
      const pending = page.locator(`[data-timeline-part-ids*="${pendingPartID}"]`).first()
      await expectAppVisible(running)
      await expectAppVisible(pending)
      await expect(running.getByRole("button", { name: "Cancel tool call", exact: true })).toBeVisible()
      await expect(pending.getByRole("button", { name: "Cancel tool call", exact: true })).toHaveCount(0)

      await running.getByRole("button", { name: "Cancel tool call", exact: true }).click()
      expect(cancels).toEqual([{ sessionID, callID: runningPartID }])

      await page.screenshot({ path: `test-results/tool-cancel-${viewport.name}.png`, fullPage: false })
    })
  }
})

async function mockServer(page: Page, cancels: { sessionID: string; callID: string }[]) {
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    pageMessages: () => ({ items: messages() }),
    onSessionToolCancel: (input) => {
      cancels.push(input)
      return { data: { cancelled: true } }
    },
  })
}

function messages() {
  return [
    {
      info: {
        id: userMessageID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model,
      },
      parts: [
        {
          id: "prt_tool_cancel_user_text",
          sessionID,
          messageID: userMessageID,
          type: "text",
          text: "Show a pending and a running tool.",
        },
      ],
    },
    {
      info: {
        id: assistantMessageID,
        sessionID,
        role: "assistant",
        time: { created: 1700000001000 },
        parentID: userMessageID,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.01,
        tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        variant: "max",
      },
      parts: [
        {
          id: pendingPartID,
          sessionID,
          messageID: assistantMessageID,
          type: "tool",
          callID: "call_tool_cancel_pending",
          tool: "read",
          state: {
            status: "pending",
            input: {},
            raw: '{"filePath":"src/pending.ts"}',
            time: { start: 1700000001000 },
          },
        },
        {
          id: runningPartID,
          sessionID,
          messageID: assistantMessageID,
          type: "tool",
          callID: "call_tool_cancel_running",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "bun test", description: "Long running verification" },
            structured: {},
            content: [],
            time: { start: 1700000002000 },
          },
        },
      ],
    },
  ]
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "tool-cancel-visual",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "tool-cancel-visual",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
