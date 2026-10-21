import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseLocalFileLinkQAArgs, sessionOpenAction } from "./verify-local-file-links.mjs"

const args = [
  "--session",
  "ses_example",
  "--directory",
  process.cwd(),
  "--label",
  "Open PDF",
  "--href",
  "file:///C:/My%20Documents/report.pdf",
  "--screenshot",
  "qa.png",
]

describe("installed document-link QA input contract", () => {
  test("takes all targets from explicit input and never clicks by default", () => {
    expect(parseLocalFileLinkQAArgs(args)).toEqual({
      sessionID: "ses_example",
      directory: process.cwd(),
      label: "Open PDF",
      href: "file:///C:/My%20Documents/report.pdf",
      screenshot: resolve("qa.png"),
      click: false,
    })
    expect(parseLocalFileLinkQAArgs([...args, "--click"]).click).toBe(true)
  })

  test("rejects incomplete or unsafe arguments before opening a bridge", () => {
    expect(() => parseLocalFileLinkQAArgs([])).toThrow("Usage:")
    expect(() => parseLocalFileLinkQAArgs(args.slice(0, -2))).toThrow("Usage:")
    expect(() => parseLocalFileLinkQAArgs(args.map((value) => (value === "qa.png" ? "document.md" : value)))).toThrow(
      "PNG",
    )
    for (const href of ["https://example.com/report.pdf", "file://server/share/report.pdf"]) {
      expect(() => parseLocalFileLinkQAArgs(args.map((value) => (value.startsWith("file:") ? href : value)))).toThrow(
        "local file URL",
      )
    }
  })

  test("translates the observed bridge route keys into typed navigation and restoration", () => {
    expect(sessionOpenAction({ type: "session", sessionId: "ses_original", dir: "C:/Original" })).toEqual({
      type: "session.open",
      sessionID: "ses_original",
      directory: "C:/Original",
    })
    expect(sessionOpenAction({ type: "home" })).toBeUndefined()
    expect(sessionOpenAction({ type: "session", sessionID: "wrong-shape", directory: "C:/Original" })).toBeUndefined()
    expect(sessionOpenAction(undefined)).toBeUndefined()
  })

  test("the real Node CLI fails with usage rather than touching the app when arguments are missing", async () => {
    const child = Bun.spawn(["node", resolve(import.meta.dir, "verify-local-file-links.mjs")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const error = await new Response(child.stderr).text()
    expect(await child.exited).toBe(1)
    expect(error).toContain("Usage: node scripts/verify-local-file-links.mjs")
    expect(error).not.toContain("desktop-testing.json")
  })
})
