import { expect, test } from "@playwright/test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Opt-in source-runtime acceptance: no mocked application routes, installed app,
// user database, credentials, project plugins or external provider requests.
const enabled = process.env.OPENCODE_NATIVE_CONTEXT_QA === "1"
const port = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? 42117)
const backend = `http://127.0.0.1:${port}`
const captures: Record<string, unknown>[] = []
const evidenceDirectory = process.env.OPENCODE_NATIVE_CONTEXT_QA_OUTPUT ?? "e2e/test-results/native-context"
let root = ""
let directory = ""
let startup = ""
let processHandle: ReturnType<typeof spawn> | undefined
let provider: ReturnType<typeof createServer> | undefined
let releaseObsoleteDispatch: (() => void) | undefined
let releaseCorrectedDispatch: (() => void) | undefined
const pendingDispatches = { obsolete: 0, corrected: 0 }

async function api(route: string, body?: unknown) {
  const response = await fetch(backend + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-opencode-directory": directory },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  expect(response.ok, `${route}: ${response.status} ${text}`).toBe(true)
  return text ? JSON.parse(text) : undefined
}

test.use({ video: { mode: "on", size: { width: 1280, height: 720 } } })

test.describe("native task context through the source Dev browser", () => {
  test.skip(!enabled, "Opt in with OPENCODE_NATIVE_CONTEXT_QA=1 and a dedicated PLAYWRIGHT_SERVER_PORT")
  test.beforeAll(async () => {
    test.setTimeout(100000)
    root = await mkdtemp(path.join(os.tmpdir(), "opencode-context-browser-"))
    directory = path.join(root, "project")
    await mkdir(directory, { recursive: true })
    provider = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      captures.push(body)
      const messages = body.messages as { role: string; content: unknown }[]
      const last = messages.at(-1)
      const user = messages.findLast((message) => message.role === "user")
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content)
      const mode = text.includes("fresh") ? "fresh" : "fork"
      const child = text.includes("QA child assignment")
      const canDispatch = (body.tools as { function?: { name?: string } }[] | undefined)?.some((tool) => tool.function?.name === "task")
      // Title/helper requests share the prompt text but have no Task schema.
      const obsolete = canDispatch && text.includes("Dispatch pending fork") && !child && last?.role !== "tool"
      const corrected = canDispatch && text.includes("Apply corrected assignment and fork") && !child && last?.role !== "tool"
      if (obsolete || corrected) {
        const name = obsolete ? "obsolete" : "corrected"
        pendingDispatches[name]++
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.write(`data: ${JSON.stringify({ id: `qa_pending_${name}`, choices: [{ index: 0, delta: {
          tool_calls: [{ index: 0, id: `qa_task_pending_${name}`, type: "function", function: {
            name: "task", arguments: JSON.stringify({ description: `Inspect ${name} assignment`,
              prompt: `QA child assignment ${name}: report completion without tools.`,
              subagent_type: "explore", workspace: "readonly", context: "fork" }),
          } }],
        }, finish_reason: null }] })}\n\n`)
        // This is a provider-stream barrier, not injected Session state. The
        // browser admits the correction through the real composer before drain.
        const release = () => response.end(`data: ${JSON.stringify({ id: `qa_pending_${name}`,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
        if (obsolete) releaseObsoleteDispatch = release
        else releaseCorrectedDispatch = release
        return
      }
      const dispatch = canDispatch && text.includes("Dispatch native") && !child && last?.role !== "tool"
      const delta = dispatch
        ? { tool_calls: [{ index: 0, id: `qa_task_${mode}`, type: "function", function: { name: "task", arguments: JSON.stringify({
          description: `Inspect ${mode} context`, prompt: `QA child assignment ${mode}: report completion without tools.`,
          subagent_type: "explore", workspace: "readonly", context: mode,
        }) } }] }
        : { content: child ? text.includes("corrected") ? "Child corrected assignment completed" : `Child ${mode} completed`
          : text.includes("Apply corrected assignment and fork") ? "Corrected native fork completed"
          : last?.role === "tool" ? `Native ${mode} task completed` : "Parent baseline answer" }
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(`data: ${JSON.stringify({ id: "qa", choices: [{ index: 0, delta, finish_reason: dispatch ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve))
    const address = provider.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture provider port")
    const config = {
      formatter: false, lsp: false, plugin: [], mcp: {}, model: "test/test-model",
      permission: { "*": "deny", task: "allow", read: "allow", grep: "allow", glob: "allow" },
      agent: { build: { model: "test/test-model" }, explore: { model: "test/test-model" } },
      provider: { test: { name: "Native QA", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
        models: { "test-model": { id: "test-model", name: "Native QA model", attachment: false, reasoning: false,
          temperature: false, tool_call: true, release_date: "2025-01-01", limit: { context: 100000, output: 1000 },
          cost: { input: 0, output: 0 }, options: {} } },
        options: { apiKey: "local-fixture-not-a-credential", baseURL: `http://127.0.0.1:${address.port}/v1` } } },
    }
    const cli = fileURLToPath(new URL("../../../opencode/src/index.ts", import.meta.url))
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_SESSION_RECOVERY: "1", OPENCODE_PURE: "1",
      XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    }
    // Fixture loopback has no credentials and must not inherit installed auth.
    delete env.OPENCODE_SERVER_PASSWORD
    delete env.OPENCODE_SERVER_USERNAME
    processHandle = spawn("bun", ["run", "--conditions=browser", cli, "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: directory, env, stdio: ["ignore", "pipe", "pipe"],
    })
    processHandle.stdout?.on("data", (chunk) => { startup += chunk.toString() })
    processHandle.stderr?.on("data", (chunk) => { startup += chunk.toString() })
    await expect.poll(() => startup, { timeout: 90000 }).toContain(`listening on http://127.0.0.1:${port}`)
  })

  test.afterAll(async () => {
    if (!enabled) return
    releaseObsoleteDispatch?.()
    releaseCorrectedDispatch?.()
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(path.join(evidenceDirectory, "provider-captures.json"), JSON.stringify(captures, null, 2))
    await writeFile(path.join(evidenceDirectory, "backend.log"), startup)
    if (processHandle && processHandle.exitCode === null) {
      const exited = new Promise<void>((resolve) => processHandle?.once("exit", () => resolve()))
      processHandle.kill()
      await exited
    }
    await new Promise<void>((resolve) => provider ? provider.close(() => resolve()) : resolve())
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  for (const mode of ["fork", "fresh"] as const) {
    test(`executes ${mode}, opens child and survives reload`, async ({ page }) => {
      test.setTimeout(90000)
      const errors: string[] = []
      const failed: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
      page.on("requestfailed", (request) => { if (!request.failure()?.errorText.includes("ERR_ABORTED")) failed.push(`${request.failure()?.errorText} ${request.url()}`) })
      const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
      const sessionID = created.data.id
      await api(`/api/session/${sessionID}/prompt`, { prompt: { text: "Parent evidence marker attachment://att_foreign_quoted_link" } })
      await api(`/api/session/${sessionID}/wait`, {})
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.goto(`/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`)
      const draft = page.locator('[data-component="session-composer"] [contenteditable="true"]').first()
      await expect(draft).toBeVisible()
      const from = captures.length
      await draft.fill(`Dispatch native ${mode}`)
      await draft.press("Enter")
      await expect(page.getByText(`Native ${mode} task completed`, { exact: false }).first()).toBeVisible({ timeout: 30000 })
      await api(`/api/session/${sessionID}/wait`, {})
      const children = await api(`/session/${sessionID}/children`)
      expect(children).toHaveLength(1)
      const child = children[0]
      const request = captures.slice(from).find((capture) => {
        const messages = capture.messages as { role: string; content: unknown }[]
        return messages.at(-1)?.role === "user" && JSON.stringify(messages.at(-1)?.content).includes("QA child assignment")
      })
      expect(request).toBeDefined()
      expect(JSON.stringify(request?.messages).includes("Parent evidence marker")).toBe(mode === "fork")
      const childMessages = await api(`/api/session/${child.id}/message`)
      const serialized = JSON.stringify(childMessages)
      expect(serialized).toContain(`QA child assignment ${mode}`)
      if (mode === "fork") expect(serialized).toContain("Parent evidence marker")
      else expect(serialized).not.toContain("Parent evidence marker")
      const task = page.locator(`[data-timeline-part-id="qa_task_${mode}"]`).first()
      await expect(task).toBeVisible()
      await mkdir(evidenceDirectory, { recursive: true })
      await writeFile(path.join(evidenceDirectory, `${mode}-messages.json`), JSON.stringify({
        parent: await api(`/api/session/${sessionID}/message`), child: childMessages,
        legacy: await api(`/session/${sessionID}/message`), task: await task.evaluate((node) => node.outerHTML),
      }, null, 2))
      await page.screenshot({ path: path.join(evidenceDirectory, `${mode}-desktop.png`) })
      await task.locator('[data-component="task-tool-card"]').click()
      await expect(page.getByText(`Child ${mode} completed`, { exact: false }).first()).toBeVisible()
      await page.reload()
      await expect(page.getByText(`Child ${mode} completed`, { exact: false }).first()).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: path.join(evidenceDirectory, `${mode}-mobile-child.png`) })
      await writeFile(path.join(evidenceDirectory, `${mode}-diagnostics.json`), JSON.stringify({ backend, sessionID, childID: child.id,
        context: mode, parentHistoryInChild: serialized.includes("Parent evidence marker"), errors, failed }, null, 2))
      expect(errors).toEqual([])
      expect(failed).toEqual([])
    })
  }

  test.describe("pending input recovery", () => {
    test("refuses the obsolete fork, promotes a real correction and admits a newly assigned fork", async ({ page }) => {
      test.setTimeout(90000)
      const errors: string[] = []
      const failed: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
      page.on("requestfailed", (request) => { if (!request.failure()?.errorText.includes("ERR_ABORTED")) failed.push(`${request.failure()?.errorText} ${request.url()}`) })
      const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
      const sessionID = created.data.id
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.goto(`/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`)
      const draft = page.locator('[data-component="session-composer"] [contenteditable="true"]').first()
      await expect(draft).toBeVisible()
      const from = captures.length
      await draft.fill("Dispatch pending fork")
      await draft.press("Enter")
      await expect.poll(() => pendingDispatches.obsolete).toBe(1)
      const obsoleteTask = page.locator('[data-timeline-part-id="qa_task_pending_obsolete"]').first()
      await expect(obsoleteTask).toBeVisible()

      const correction = "Apply corrected assignment and fork"
      const admitted = page.waitForResponse((response) => response.url().endsWith(`/api/session/${sessionID}/prompt`) && response.request().method() === "POST")
      await draft.fill(correction)
      await draft.press("Enter")
      const correctionResponse = await admitted
      expect(correctionResponse.ok()).toBe(true)
      expect(correctionResponse.request().postDataJSON()).toMatchObject({ prompt: { text: correction } })
      expect(correctionResponse.request().postDataJSON().delivery ?? "steer").toBe("steer")
      const receipt = (await correctionResponse.json()).data
      expect(receipt.delivery).toBe("steer")
      expect(receipt.promotedSeq).toBeUndefined()
      expect(JSON.stringify(await api(`/api/session/${sessionID}/message`))).not.toContain(receipt.id)
      expect(await api(`/session/${sessionID}/children`)).toEqual([])
      await page.screenshot({ path: test.info().outputPath("pending-before-capture.png") })

      releaseObsoleteDispatch?.()
      await expect.poll(() => pendingDispatches.corrected).toBe(1)
      // Holding the new provider stream proves that the old rejected attempt
      // created no child before the new, promoted assignment can be captured.
      expect(await api(`/session/${sessionID}/children`)).toEqual([])
      const promoted = await api(`/api/session/${sessionID}/message`)
      expect(promoted.data).toContainEqual(expect.objectContaining({ id: receipt.id, type: "user", text: correction }))
      // Task cards deliberately hide details; verify the durable diagnostic and
      // the actual model-facing tool result, not text absent from that card.
      const diagnostic = JSON.stringify(promoted)
      expect(diagnostic).toContain("task_pending_input")
      expect(diagnostic).toContain("Process that input through the normal session flow first")
      expect(diagnostic).toContain("do not retry this rejected assignment")
      expect(JSON.stringify(captures.slice(from))).toContain("task_pending_input")
      await expect(obsoleteTask).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("pending-refused-correction-promoted.png") })

      releaseCorrectedDispatch?.()
      await expect(page.getByText("Corrected native fork completed", { exact: false }).first()).toBeVisible({ timeout: 30000 })
      await api(`/api/session/${sessionID}/wait`, {})
      const children = await api(`/session/${sessionID}/children`)
      expect(children).toHaveLength(1)
      expect(pendingDispatches).toEqual({ obsolete: 1, corrected: 1 })
      const childMessages = await api(`/api/session/${children[0].id}/message`)
      expect(JSON.stringify(childMessages)).toContain("QA child assignment corrected")
      expect(JSON.stringify(childMessages)).toContain(correction)
      const childRequests = captures.slice(from).filter((capture) => {
        const messages = capture.messages as { role: string; content: unknown }[]
        return messages.at(-1)?.role === "user" && JSON.stringify(messages.at(-1)?.content).includes("QA child assignment")
      })
      expect(childRequests).toHaveLength(1)
      expect(JSON.stringify(childRequests[0])).toContain("QA child assignment corrected")
      await page.screenshot({ path: test.info().outputPath("pending-recovery-parent.png") })
      await page.locator('[data-timeline-part-id="qa_task_pending_corrected"] [data-component="task-tool-card"]').first().click()
      await expect(page.getByText("Child corrected assignment completed", { exact: false }).first()).toBeVisible()
      await page.reload()
      await expect(page.getByText("Child corrected assignment completed", { exact: false }).first()).toBeVisible()
      await page.screenshot({ path: test.info().outputPath("pending-recovery-child.png") })
      await writeFile(test.info().outputPath("pending-recovery-evidence.json"), JSON.stringify({ backend, sessionID, childID: children[0].id,
        fixture: "local provider through real source admission, no application-route mocks", receipt,
        parent: await api(`/api/session/${sessionID}/message`), child: childMessages, childRequests,
        pendingDispatches, errors, failed }, null, 2))
      expect(errors).toEqual([])
      expect(failed).toEqual([])
    })
  })
})
