import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

test("archive extraction is an explicit per-attachment choice in the real composer", async ({ page }, testInfo) => {
  const directory = "C:/OpenCode/ArchiveAttachments"
  const sessionID = "ses_archive_attachments"
  const prompts: { prompt?: { files?: { name?: string; mime?: string; unpack?: boolean }[] } }[] = []
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "proj_archive", worktree: directory, vcs: "git", name: "archive-test", sandboxes: [], time: { created: 1, updated: 1 } },
    provider: fixture.provider,
    agents: [{ name: "build", mode: "primary" }],
    sessions: [{ id: sessionID, slug: sessionID, projectID: "proj_archive", directory, title: "Archive Attachments", version: "dev", time: { created: 1, updated: 1 } }],
    pageMessages: () => ({ items: [] }),
    onSessionPrompt: ({ body }) => {
      prompts.push(body as typeof prompts[number])
      return { data: { sessionID, messageID: "msg_archive", admittedSeq: 1 } }
    },
  })
  await page.addInitScript(({ directory, dirBase64, sessionID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", server: "http://127.0.0.1:4096", dirBase64, sessionId: sessionID }]))
  }, { directory, dirBase64: base64Encode(directory), sessionID })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  await expectAppVisible(input)
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)], "save.7z", { type: "application/octet-stream" }))
    transfer.items.add(new File(["PK"], "keep.zip", { type: "application/zip" }))
    document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  const unpack = composer.getByRole("checkbox", { name: "Unpack before sending" })
  await expect(unpack).toHaveCount(2)
  await expect(unpack.first()).not.toBeChecked()
  await expect(unpack.last()).not.toBeChecked()
  await unpack.first().check()
  await expect(unpack.first()).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath("archive-opt-in.png") })
  await input.fill("Inspect the unpacked savegame")
  await expect(unpack.first()).toBeChecked()
  await composer.locator('[data-action="prompt-submit"]').last().click()
  await expect.poll(() => prompts.length).toBe(1)
  await testInfo.attach("archive-prompt", { body: JSON.stringify(prompts[0], null, 2), contentType: "application/json" })
  expect(prompts[0]?.prompt?.files?.find((file) => file.name === "save.7z")).toMatchObject({ mime: "application/x-7z-compressed", unpack: true })
  expect(prompts[0]?.prompt?.files?.find((file) => file.name === "keep.zip")?.unpack).toBeUndefined()
})
