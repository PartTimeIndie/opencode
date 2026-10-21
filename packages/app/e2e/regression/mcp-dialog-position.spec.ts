import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/McpDialogPosition"
const projectID = "proj_mcp_dialog_position"
const sessionID = "ses_mcp_dialog_position"

test("opens the slash mcp dialog around the viewport center", async ({ page }) => {
  const errors = trackPageErrors(page)

  await page.setViewportSize({ width: 1280, height: 720 })
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "mcp-dialog-position",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "gpt-5.5" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "mcp-dialog-position",
        projectID,
        directory,
        title: "MCP dialog position",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    mcpStatus: () => ({
      "computer-use": { status: "disabled" },
      context7: { status: "connected" },
      serpapi: { status: "connected" },
      unityMCP: { status: "connected" },
    }),
  })

  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  await composer.locator('[data-component="prompt-input"]').click()
  await page.keyboard.type("/mcp")
  await expectAppVisible(page.locator('[data-slash-id="mcp.toggle"]'))
  await page.keyboard.press("Enter")

  const dialog = page.locator('[data-component="dialog"] [data-slot="dialog-content"]')
  await expectAppVisible(dialog)
  await expectAppVisible(dialog.getByText("context7"))

  const offset = await dialog.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2)
  })
  expect(offset).toBeLessThan(40)
  expectNoSmokeErrors(errors, [], [])
})
