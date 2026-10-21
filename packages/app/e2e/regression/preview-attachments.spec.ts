import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

// Feature 2 — AttachmentRenderer proof. The agent attaches image/video/file
// deliverables (via the `attach` tool) and they render inline with a fullscreen
// overlay for images/videos and a download card for other files.
test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/PreviewAttachments"

test("renders image, video and file attachments and opens a fullscreen overlay", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_preview",
      worktree: directory,
      vcs: "git",
      name: "preview",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [],
    pageMessages: () => ({ items: [] }),
  })

  await page.goto("/preview/attachments")

  const renderer = page.locator('[data-component="attachment-renderer"]')
  await expect(renderer).toBeVisible()
  await expect(page.locator('[data-attachment-kind="image"]')).toBeVisible()
  await expect(page.locator('[data-attachment-kind="video"]')).toBeVisible()
  await expect(page.locator('[data-attachment-kind="file"]')).toHaveCount(1)
  await expect(page.locator('[data-attachment-id="att_file_1"]')).toContainText("report.txt")
  await page.waitForTimeout(400)

  // Click the image -> fullscreen overlay with an <img>.
  await page.locator('[data-attachment-kind="image"]').click()
  const overlay = page.locator('[data-component="attachment-fullscreen-overlay"]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator("img")).toBeVisible()
  const closeBox = await overlay.locator('[data-component="attachment-preview-close"]').boundingBox()
  expect(closeBox?.y).toBeGreaterThanOrEqual(48)
  await page.waitForTimeout(500)
  await overlay.locator('button[aria-label="Close"]').click()
  await expect(overlay).toHaveCount(0)

  // Click the video -> overlay with a <video> element (the player).
  await page.locator('[data-attachment-kind="video"]').click()
  await expect(page.locator('[data-component="attachment-fullscreen-overlay"] video')).toBeVisible()
  await page.waitForTimeout(500)
})
