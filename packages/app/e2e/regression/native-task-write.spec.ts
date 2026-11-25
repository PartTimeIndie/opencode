import { expect, test } from "@playwright/test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Opt-in source-runtime acceptance for WRITING native task children. No mocked
// application routes, installed app, user database, credentials, project
// plugins or external provider requests. The gate fails loudly instead of
// skipping: a silently skipped acceptance run must never be reportable as
// green. This intentionally makes an un-opted `playwright test` run fail when
// this file is selected; e2e runs are explicit developer actions.
const enabled = process.env.OPENCODE_TASK_WRITE_QA === "1"
const port = Number(process.env.PLAYWRIGHT_SERVER_PORT ?? 42118)
const backend = `http://127.0.0.1:${port}`
const captures: Record<string, unknown>[] = []
const providerRequests: string[] = []
const evidenceDirectory = process.env.OPENCODE_TASK_WRITE_QA_OUTPUT ?? "e2e/test-results/native-task-write"
let root = ""
let directory = ""
let startup = ""
let processHandle: ReturnType<typeof spawn> | undefined
let provider: ReturnType<typeof createServer> | undefined
const barriers = new Map<string, () => void>()
let dispatchSeq = 0

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

function sse(response: import("node:http").ServerResponse, id: string, delta: unknown, finish: string) {
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(`data: ${JSON.stringify({ id, choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
}

const hold = (key: string, release: () => void) => new Promise<void>((resolve) => {
  barriers.set(key, () => { barriers.delete(key); release(); resolve() })
})

test.use({ video: { mode: "on", size: { width: 1280, height: 720 } } })

test.describe("native writing task children through the source Dev browser", () => {
  // One worker only: every worker would spawn its own backend on the same
  // pinned fixture port and cross-talk would poison the acceptance evidence.
  test.describe.configure({ mode: "serial" })

  test.beforeAll(() => {
    if (!enabled)
      throw new Error(
        "This acceptance spec must not run silently: opt in with OPENCODE_TASK_WRITE_QA=1 and a dedicated PLAYWRIGHT_SERVER_PORT.",
      )
  })

  test.beforeAll(async () => {
    test.setTimeout(100000)
    root = await mkdtemp(path.join(os.tmpdir(), "opencode-task-write-browser-"))
    directory = path.join(root, "project")
    await mkdir(directory, { recursive: true })
    // Mirror children snapshot a real Git repository: the source directory must
    // be the repository toplevel with at least one commit.
    const { execFileSync } = await import("node:child_process")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" }).toString()
    git("init")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "user.name", "Write QA Fixture")
    await writeFile(path.join(directory, "README.md"), "# write qa fixture\n")
    git("add", ".")
    git("commit", "-m", "fixture baseline")
    provider = createServer(async (request, response) => {
      providerRequests.push(`${new Date().toISOString()} ${request.method} ${request.url}`)
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      captures.push(body)
      const messages = body.messages as { role: string; content: unknown }[]
      const last = messages.at(-1)
      const user = messages.findLast((message) => message.role === "user")
      const userTexts = messages.filter((message) => message.role === "user")
        .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      // The child's own assignment is the newest message carrying the marker;
      // forked parent history can contain an older sibling assignment too.
      const assignment = userTexts.findLast((candidate) => candidate.includes("QA write assignment"))
      const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content)
      const tools = (body.tools as { function?: { name?: string } }[] | undefined)?.map((tool) => tool.function?.name) ?? []
      const canDispatch = tools.includes("task")
      const canWrite = tools.includes("apply_patch")

      // Child runner request: it materializes the apply_patch tool. Title/helper
      // requests sharing the prompt text do not and fall through to content.
      // The assignment marker may sit behind an already promoted steer, so the
      // search covers every user message instead of only the newest one.
      const child = canWrite && assignment
      if (child) {
        const variant = assignment!.includes("steer") ? "steer" : assignment!.includes("long") ? "long"
          : assignment!.includes("outside") ? "outside" : assignment!.includes("readonly") ? "readonly" : assignment!.includes("main") ? "main" : "mirror"
        // A promoted steer can sit after the tool result, so completion is
        // detected by OUR write tool result in the child history ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â forked
        // parent history also contains tool results with other call ids.
        if (messages.some((message) => String((message as { tool_call_id?: unknown }).tool_call_id ?? "").startsWith("qa_write_"))) {
          sse(response, "qa-write", { content: `Child ${variant} write completed` }, "stop")
          return
        }
        if (variant === "outside") {
          sse(response, "qa-write", { tool_calls: [{ index: 0, id: "qa_write_outside", type: "function", function: {
            name: "apply_patch", arguments: JSON.stringify({ patchText: `*** Begin Patch\n*** Add File: ${path.join(root, "outside-escape.md")}\n+escape attempt\n*** End Patch` }) } }] },
          "tool_calls")
          return
        }
        const call = { index: 0, id: `qa_write_${variant}`, type: "function", function: {
          name: "apply_patch", arguments: JSON.stringify({ patchText: `*** Begin Patch\n*** Add File: written-by-child.md\n+${variant === "steer" ? "steered child write" : `hello from ${variant} child`}\n*** End Patch` }) } }
        if (variant === "steer") {
          // Provider-stream barrier before the guarded mutation: the steer is
          // admitted through the real API while this stream is still open.
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(`data: ${JSON.stringify({ id: "qa-write-steer", choices: [{ index: 0, delta: {
            tool_calls: [call] }, finish_reason: null }] })}\n\n`)
          await hold("steer", () => response.end(`data: ${JSON.stringify({ id: "qa-write-steer",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`))
          return
        }
        if (variant === "long") {
          // Healthy long-running child: the heartbeat fiber must keep the lease
          // alive for more than one full lease duration before the write runs.
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write(`data: ${JSON.stringify({ id: "qa-write-long", choices: [{ index: 0, delta: {
            tool_calls: [call] }, finish_reason: null }] })}\n\n`)
          setTimeout(() => barriers.get("long")?.(), 35000)
          await hold("long", () => response.end(`data: ${JSON.stringify({ id: "qa-write-long",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`))
          return
        }
        sse(response, `qa-write-${variant}`, { tool_calls: [call] }, "tool_calls")
        return
      }

      const dispatch = canDispatch && last?.role !== "tool" && text.startsWith("Dispatch ")
      const variantOf = (marker: string) => marker.includes("steered write") ? "steer" : marker.includes("long write") ? "long"
        : marker.includes("outside write") ? "outside" : marker.includes("readonly write") ? "readonly"
        : marker.includes("main write") ? "main" : "mirror"
      const dispatchMarker = userTexts.findLast((candidate) => candidate.startsWith("Dispatch "))
      if (dispatch) {
        const variant = variantOf(dispatchMarker ?? text)
        const childPrompt = `QA write assignment ${variant}: create the file, then report completion.`
        // Unique tool-call ids per dispatch: repeated ids would reuse one child
        // session across separate dispatches in the same parent.
        sse(response, "qa-dispatch", { tool_calls: [{ index: 0, id: `qa_task_${variant}_${dispatchSeq++}`, type: "function", function: {
          name: "task", arguments: JSON.stringify({
            description: `Write ${variant} assignment`,
            prompt: childPrompt,
            subagent_type: "explore",
            context: "fork",
            ...(variant === "main" || variant === "readonly" ? { workspace: variant } : {}),
          }) } }] }, "tool_calls")
        return
      }
      const childDone = canWrite && last?.role === "tool" && assignment
      const readonlyAttempt = !canWrite && last?.role !== "tool" && assignment?.includes("readonly")
      const readonlyDone = !canWrite && last?.role === "tool" && assignment?.includes("readonly")
      if (childDone || readonlyAttempt) {
        const variant = variantOf(assignment ?? text)
        if (readonlyAttempt) {
          // Readonly children do not materialize the apply_patch tool;
          // attempting it must fail closed with a durable refusal, never
          // write a file.
          sse(response, `qa-write-${variant}`, { tool_calls: [{ index: 0, id: `qa_write_${variant}`, type: "function", function: {
            name: "apply_patch", arguments: JSON.stringify({ patchText: "*** Begin Patch\n*** Add File: written-by-child.md\n+readonly must not write\n*** End Patch" }) } }] }, "tool_calls")
          return
        }
        sse(response, "qa-write", { content: `Child ${variant} write completed` }, "stop")
        return
      }
      if (readonlyDone) {
        sse(response, "qa-write", { content: "Child readonly write completed" }, "stop")
        return
      }
      const content = last?.role === "tool"
        ? `Parent ${dispatchMarker ? variantOf(dispatchMarker) : "task"} completed`
        : "Parent baseline answer"
      sse(response, "qa", { content }, "stop")
    })
    await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve))
    const address = provider.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture provider port")
    const config = {
      formatter: false, lsp: false, plugin: [], mcp: {}, model: "test/test-model",
      permission: { "*": "deny", task: "allow", read: "allow", grep: "allow", glob: "allow",
        edit: "allow",
        // Main-write children need the real single-use consent round trip: an
        // allow shortcut is not evidence of a host answer, so the fixture asks.
        task_main_write: "ask" },
      agent: { build: { model: "test/test-model" }, explore: { model: "test/test-model" } },
      provider: { test: { name: "Write QA", id: "test", env: [], npm: "@ai-sdk/openai-compatible",
        models: { "test-model": { id: "test-model", name: "Write QA model", attachment: false, reasoning: false,
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
    if (!root) return
    for (const release of barriers.values()) release()
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(path.join(evidenceDirectory, "provider-captures.json"), JSON.stringify(captures, null, 2))
    await writeFile(path.join(evidenceDirectory, "provider-requests.log"), providerRequests.join("\n"))
    await writeFile(path.join(evidenceDirectory, "backend.log"), startup)
    if (processHandle && processHandle.exitCode === null) {
      const exited = new Promise<void>((resolve) => processHandle?.once("exit", () => resolve()))
      processHandle.kill()
      await exited
    }
    await new Promise<void>((resolve) => provider ? provider.close(() => resolve()) : resolve())
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  let captureDump = 0
  async function dumpCaptures() {
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(path.join(evidenceDirectory, `captures-${++captureDump}.json`), JSON.stringify(captures, null, 2))
  }

  // Evidence must survive failing assertions: dump after every test, pass or fail.
  test.afterEach(async () => {
    if (!enabled) return
    await dumpCaptures()
  })

  async function pollDefined<T>(fn: () => Promise<T | undefined | null>, timeout = 60000): Promise<T> {
    const start = Date.now()
    for (;;) {
      const value = await fn()
      if (value !== undefined && value !== null) return value
      if (Date.now() - start > timeout) throw new Error(`pollDefined timed out after ${timeout}ms`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  async function openSession(page: import("@playwright/test").Page, sessionID: string) {
    const errors: string[] = []
    const failed: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    page.on("response", (response) => { if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`) })
    page.on("requestfailed", (request) => { if (!request.failure()?.errorText.includes("ERR_ABORTED")) failed.push(`${request.failure()?.errorText} ${request.url()}`) })
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`)
    const draft = page.locator('[data-component="session-composer"] [contenteditable="true"]').first()
    await expect(draft).toBeVisible()
    return { errors, failed, draft }
  }

  async function runParentDispatch(page: import("@playwright/test").Page,
    draft: import("@playwright/test").Locator, marker: string, done: string, timeout = 60000) {
    const started = Date.now()
    await draft.fill(marker)
    await draft.press("Enter")
    await expect(page.getByText(done, { exact: false }).first()).toBeVisible({ timeout })
    return Date.now() - started
  }

  async function waitForCapture(predicate: (capture: Record<string, unknown>) => boolean, timeout = 60000) {
    await expect.poll(() => captures.some(predicate), { timeout, intervals: [250] }).toBe(true)
    return captures.filter(predicate)
  }

  // (a) Default mirror child writes inside its own private checkout while the
  // physical Main checkout stays untouched.
  test("mirror child writes in its own checkout and survives reload", async ({ page }) => {
    test.setTimeout(90000)
    const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
    const sessionID = created.data.id
    const { errors, failed, draft } = await openSession(page, sessionID)
    const from = captures.length
    await runParentDispatch(page, draft, "Dispatch mirror write task", "Parent mirror completed")

    const children = await api(`/session/${sessionID}/children`)
    expect(children).toHaveLength(1)
    const child = children[0]
    expect(child.directory).not.toBe(directory)
    const written = path.join(child.directory, "written-by-child.md")
    const content = await import("node:fs/promises").then((fs) => fs.readFile(written, "utf8"))
    expect(content).toBe("hello from mirror child\n")
    expect(await import("node:fs/promises").then((fs) => fs.readdir(directory))).not.toContain("written-by-child.md")

    // The child request materialized the apply_patch tool (fixture realism).
    const childRequest = captures.slice(from).find((capture) => {
      const messages = capture.messages as { role: string; content: unknown }[]
      const tools = (capture.tools as { function?: { name?: string } }[] | undefined) ?? []
      return messages.at(-1)?.role === "user" &&
        JSON.stringify(messages.at(-1)?.content).includes("QA write assignment mirror") &&
        tools.some((tool) => tool.function?.name === "apply_patch")
    })
    expect(childRequest, "child runner request with apply_patch tool").toBeDefined()

    const childMessages = await api(`/api/session/${child.id}/message`)
    const serialized = JSON.stringify(childMessages)
    expect(serialized).toContain("QA write assignment mirror")
    expect(serialized).toContain("hello from mirror child")

    // Child navigation and reload keep the completed write visible.
    await page.goto(`/${Buffer.from(directory).toString("base64url")}/session/${child.id}`)
    await expect(page.getByText("Child mirror write completed", { exact: false }).first()).toBeVisible({ timeout: 30000 })
    await page.reload()
    await expect(page.getByText("Child mirror write completed", { exact: false }).first()).toBeVisible()
    await mkdir(evidenceDirectory, { recursive: true })
    await page.screenshot({ path: path.join(evidenceDirectory, "mirror-child-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(evidenceDirectory, "mirror-child-mobile.png") })
    await writeFile(path.join(evidenceDirectory, "mirror-child-evidence.json"), JSON.stringify({
      backend, sessionID, childID: child.id, childDirectory: child.directory, written, content, errors, failed }, null, 2))
    await dumpCaptures()
    expect(errors).toEqual([])
    expect(failed).toEqual([])
  })

  // (b) A live steer admitted to the running child must not block the child's
  // guarded write; the same activity keeps its assignment ceiling.
  test("live steer on a running child does not block its write", async ({ page }) => {
    test.setTimeout(90000)
    const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
    const sessionID = created.data.id
    const { errors, failed, draft } = await openSession(page, sessionID)
    await draft.fill("Dispatch steered write task")
    await draft.press("Enter")
    await waitForCapture((capture) => {
      const messages = capture.messages as { role: string; content: unknown }[]
      const tools = (capture.tools as { function?: { name?: string } }[] | undefined) ?? []
      return tools.some((tool) => tool.function?.name === "apply_patch") &&
        messages.at(-1)?.role === "user" && JSON.stringify(messages.at(-1)?.content).includes("QA write assignment steer")
    })
    const child = await pollDefined(async () => (await api(`/session/${sessionID}/children`))[0])

    // Admit the steer through the real API while the child provider stream is
    // held open (before the guarded mutation).
    const admitted = await api(`/api/session/${child.id}/prompt`, { prompt: { text: "Steer note: keep the QA marker in the file." } })
    expect(admitted.data.delivery ?? "steer").toBe("steer")

    barriers.get("steer")?.()
    await expect(page.getByText("Parent steer completed", { exact: false }).first()).toBeVisible({ timeout: 45000 })
    await api(`/api/session/${sessionID}/wait`, {})
    const written = path.join(child.directory, "written-by-child.md")
    const content = await import("node:fs/promises").then((fs) => fs.readFile(written, "utf8"))
    expect(content).toBe("steered child write\n")
    const childMessages = await api(`/api/session/${child.id}/message`)
    const serialized = JSON.stringify(childMessages)
    expect(serialized).toContain("Steer note: keep the QA marker in the file.")
    expect(serialized).toContain("Child steer write completed")
    await page.screenshot({ path: path.join(evidenceDirectory, "steer-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(evidenceDirectory, "steer-mobile.png") })
    await writeFile(path.join(evidenceDirectory, "steer-evidence.json"), JSON.stringify({
      backend, sessionID, childID: child.id, written, content, admitted, errors, failed }, null, 2))
    await dumpCaptures()
    expect(errors).toEqual([])
    expect(failed).toEqual([])
  })

  // (c) A healthy child that idles longer than one lease duration still owns
  // its activity when the write runs: the heartbeat renews the lease.
  test("healthy child keeps ownership across a full lease duration", async ({ page }) => {
    test.setTimeout(120000)
    const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
    const sessionID = created.data.id
    const { errors, failed, draft } = await openSession(page, sessionID)
    const children = await api(`/session/${sessionID}/children`)
    expect(children).toHaveLength(0)
    const elapsed = await runParentDispatch(page, draft, "Dispatch long write task", "Parent long completed", 90000)
    expect(elapsed).toBeGreaterThan(30000)
    const child = (await api(`/session/${sessionID}/children`))[0]
    const written = path.join(child.directory, "written-by-child.md")
    const content = await import("node:fs/promises").then((fs) => fs.readFile(written, "utf8"))
    expect(content).toBe("hello from long child\n")
    const childMessages = await api(`/api/session/${child.id}/message`)
    expect(JSON.stringify(childMessages)).toContain("Child long write completed")
    await page.screenshot({ path: path.join(evidenceDirectory, "long-child-desktop.png") })
    await writeFile(path.join(evidenceDirectory, "long-child-evidence.json"), JSON.stringify({
      backend, sessionID, childID: child.id, elapsedMs: elapsed, errors, failed }, null, 2))
    await dumpCaptures()
    expect(errors).toEqual([])
    expect(failed).toEqual([])
  })

  // (d) Expected security refusals stay blocked before and after any fix.
  test("writes outside the checkout and readonly children stay blocked", async ({ page }) => {
    test.setTimeout(90000)
    const fs = await import("node:fs/promises")
    const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
    const sessionID = created.data.id
    const { errors, failed, draft } = await openSession(page, sessionID)

    await runParentDispatch(page, draft, "Dispatch outside write task", "Parent outside completed", 90000)
    await expect.poll(async () => fs.access(path.join(root, "outside-escape.md")).then(() => true, () => false), { timeout: 15000 })
      .toBe(false)
    const outside = await pollDefined(async () => (await api(`/session/${sessionID}/children`))[0])
    const outsideMessages = await api(`/api/session/${outside.id}/message`)
    const outsideSerialized = JSON.stringify(outsideMessages)
    expect(outsideSerialized).toContain("QA write assignment outside")
    // The write must fail with a block message. Accept the legacy generic
    // placement message (pre-typed-reasons baseline) or the typed refusal;
    // exact per-reason messages are pinned by core unit tests.
    expect(outsideSerialized).toMatch(/physical execution placement|outside the task checkout|outside_checkout/)

    await runParentDispatch(page, draft, "Dispatch readonly write task", "Parent readonly completed", 90000)
    const readonlyChild = await pollDefined(async () => (await api(`/session/${sessionID}/children`))[1])
    const readonlyMessages = await api(`/api/session/${readonlyChild.id}/message`)
    const readonlySerialized = JSON.stringify(readonlyMessages)
    expect(readonlySerialized).toContain("QA write assignment readonly")
    expect(readonlySerialized).not.toContain("Applied patch:")
    const childDirListing = await fs.readdir(readonlyChild.directory)
    expect(childDirListing).not.toContain("written-by-child.md")

    await page.screenshot({ path: path.join(evidenceDirectory, "blocked-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(evidenceDirectory, "blocked-mobile.png") })
    await writeFile(path.join(evidenceDirectory, "blocked-evidence.json"), JSON.stringify({
      backend, sessionID, outsideID: outside.id, readonlyID: readonlyChild.id,
      outsideSerialized: outsideSerialized.slice(0, 4000), readonlySerialized: readonlySerialized.slice(0, 4000), errors, failed }, null, 2))
    await dumpCaptures()
    expect(errors).toEqual([])
    expect(failed).toEqual([])
  })

  // Main-workspace children require the real single-use task_main_write
  // consent round trip: rejection admits nothing, approval binds exactly one.
  test("main workspace write requires task_main_write consent", async ({ page }) => {
    test.setTimeout(90000)
    const fs = await import("node:fs/promises")
    const created = await api("/api/session", { agent: "build", location: { directory }, model: { providerID: "test", id: "test-model" } })
    const sessionID = created.data.id
    const { errors, failed, draft } = await openSession(page, sessionID)

    // Rejection: the pending consent is declined and no child is created.
    await draft.fill("Dispatch main write task")
    await draft.press("Enter")
    await expect.poll(async () => {
      const list = await api(`/api/session/${sessionID}/permission`)
      return (list.data as { action?: string }[]).some((request) => request.action === "task_main_write")
    }, { timeout: 30000 }).toBe(true)
    const rejected = (await api(`/api/session/${sessionID}/permission`)).data[0]
    expect(rejected.metadata?.childSessionID).toBeDefined()
    await api(`/api/session/${sessionID}/permission/${rejected.id}/reply`, { reply: "reject" })
    await expect.poll(async () => (await api(`/session/${sessionID}/children`)).length, { timeout: 30000 }).toBe(0)
    await expect(fs.access(path.join(directory, "written-by-child.md")).then(() => true, () => false)).resolves.toBe(false)
    await page.screenshot({ path: path.join(evidenceDirectory, "main-consent-rejected.png") })

    // Approval: the bound single-use consent admits exactly this task and the
    // child writes inside the physical Main checkout.
    const approvedMarker = "Dispatch main write task approved"
    await draft.fill(approvedMarker)
    await draft.press("Enter")
    await expect.poll(async () => {
      const list = await api(`/api/session/${sessionID}/permission`)
      return (list.data as { action?: string }[]).some((request) => request.action === "task_main_write")
    }, { timeout: 30000 }).toBe(true)
    const pending = (await api(`/api/session/${sessionID}/permission`)).data.find(
      (request: { action?: string }) => request.action === "task_main_write")
    await api(`/api/session/${sessionID}/permission/${pending.id}/reply`, { reply: "once" })
    await expect(page.getByText("Parent main completed", { exact: false }).first()).toBeVisible({ timeout: 60000 })
    await api(`/api/session/${sessionID}/wait`, {})
    const children = await api(`/session/${sessionID}/children`)
    expect(children).toHaveLength(1)
    const child = children[0]
    expect(child.directory).toBe(directory)
    const content = await fs.readFile(path.join(directory, "written-by-child.md"), "utf8")
    expect(content).toBe("hello from main child\n")
    const childMessages = await api(`/api/session/${child.id}/message`)
    const serialized = JSON.stringify(childMessages)
    expect(serialized).toContain("QA write assignment main")
    expect(serialized).toContain("Child main write completed")
    await page.screenshot({ path: path.join(evidenceDirectory, "main-consent-approved-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: path.join(evidenceDirectory, "main-consent-approved-mobile.png") })
    await writeFile(path.join(evidenceDirectory, "main-consent-evidence.json"), JSON.stringify({
      backend, sessionID, childID: child.id, rejected: rejected.id, approved: pending.id, content, errors, failed }, null, 2))
    await dumpCaptures()
    expect(errors).toEqual([])
    expect(failed).toEqual([])
  })
})
