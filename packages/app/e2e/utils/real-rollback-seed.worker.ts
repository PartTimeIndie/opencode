import { createHash } from "node:crypto"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { Database } from "bun:sqlite"
import { DateTime, Schema } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"

/**
 * Runs the REAL opencode server plus a complete rollback fixture for the
 * real-server visual QA spec:
 *
 * - spawns `opencode serve` with an isolated temp XDG/database environment,
 * - waits for the server's authoritative "listening" stdout line,
 * - seeds session, messages, SessionFileMutation journal rows, and content
 *   blobs directly into the server's SQLite database while it is idle,
 * - prints `READY <json>` for the spec, then stays alive holding the server.
 *
 * The worker exits (and stops the server) when its stdin closes, so the spec
 * teardown only has to end stdin.
 */

type Input = {
  opencodeDir: string
  bunExecutable: string
}

const input: Input = await Bun.file(process.argv[2]).json()
const root = await mkdtemp(path.join(tmpdir(), "opencode-rollback-visual-"))
const worktree = path.join(root, "worktree")
await mkdir(worktree, { recursive: true })
const dataHome = path.join(root, "xdg", "data")

// Only the model transport is deterministic. The real admission, runner,
// projection, HTTP and browser boundaries remain in use; no paid model is called.
const llmRequests: unknown[] = []
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    llmRequests.push(await request.json())
    await writeFile(path.join(root, "llm-requests.json"), JSON.stringify(llmRequests))
    const chunks = [
      { delta: { role: "assistant", content: "QA continuation from checkpoint" }, finish_reason: null },
      { delta: {}, finish_reason: "stop" },
    ].map(
      (choice) =>
        `data: ${JSON.stringify({ id: "chatcmpl-rollback-qa", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
    )
    return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  },
})
await writeFile(
  path.join(worktree, "opencode.json"),
  JSON.stringify({
    model: "rollback-qa/rollback-model",
    small_model: "rollback-qa/rollback-model",
    provider: {
      "rollback-qa": {
        name: "Rollback QA",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "local-test-only", baseURL: `${llm.url}v1` },
        models: {
          "rollback-model": { name: "Rollback Model", limit: { context: 100000, output: 1000 }, tool_call: true },
        },
      },
    },
  }),
)

const server = spawn(
  input.bunExecutable,
  ["--conditions=browser", "./src/index.ts", "--print-logs", "serve", "--port", "0", "--hostname", "127.0.0.1"],
  {
    cwd: input.opencodeDir,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
      XDG_STATE_HOME: path.join(root, "xdg", "state"),
      XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
      OPENCODE_DB: path.join(root, "opencode.sqlite"),
      OPENCODE_DISABLE_SHARE: "true",
      // The desktop harness environment leaks a server password; force this test
      // server unsecured so the browser can connect without credentials.
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "opencode",
    },
  },
)
process.on("exit", () => {
  server.kill()
  llm.stop(true)
})
server.stdout.setEncoding("utf8")
server.stderr.setEncoding("utf8")
server.stderr.on("data", (chunk: string) => {
  void appendFile(path.join(root, "server.log"), chunk)
})

const serverUrl = await new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("opencode server did not print a listening line")), 180_000)
  let buffer = ""
  server.stdout.on("data", (chunk: string) => {
    void appendFile(path.join(root, "server.log"), chunk)
    buffer = `${buffer}${chunk}`.slice(-32_768)
    const match = /opencode server listening on (http:\/\/\S+)/.exec(buffer)
    if (match) {
      clearTimeout(timeout)
      resolve(match[1]!)
    }
  })
  server.once("exit", (code) => {
    clearTimeout(timeout)
    reject(new Error(`opencode server exited early with ${code}`))
  })
})

// Give the listener a moment to accept connections, then seed while idle.
await new Promise((resolve) => setTimeout(resolve, 1_000))

const databasePath = path.join(root, "opencode.sqlite")
const sqlite = new Database(databasePath)

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const trackedBefore = "base"
const trackedAfter = "ours"
const createdContent = "created"
await writeFile(path.join(worktree, "tracked.txt"), trackedAfter)
await writeFile(path.join(worktree, "created.txt"), createdContent)

const sessionID = `ses_rollback_visual_${Date.now().toString(36)}`
// Real creation resolves a project shared by the V1/V2 routes. An invented
// project ID would fail the legacy update route's foreign-key constraint.
const creation = await fetch(`${serverUrl}/api/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    id: sessionID,
    location: { directory: worktree },
    model: { id: "rollback-model", providerID: "rollback-qa" },
  }),
})
if (!creation.ok) throw new Error(`Session fixture creation failed: ${creation.status} ${await creation.text()}`)
sqlite.query("UPDATE session SET title = 'Rollback Visual QA' WHERE id = ?").run(sessionID)

for (const content of [trackedBefore, trackedAfter, createdContent]) {
  const hash = sha(content)
  const relative = `content/${hash.slice(0, 2)}/${hash}`
  const target = path.join(dataHome, "opencode", relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  sqlite
    .query(
      "INSERT OR IGNORE INTO content_blob (sha256, size_bytes, mime, storage_path, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(hash, Buffer.byteLength(content), "application/octet-stream", relative, Date.now())
}

const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const created = DateTime.makeUnsafe(Date.now())
const createdMillis = DateTime.toEpochMillis(created)
const model = { id: ModelV2.ID.make("rollback-model"), providerID: ProviderV2.ID.make("rollback-qa") }

function messageData(message: SessionMessage.Message) {
  const { id, type, ...data } = encodeMessage(message)
  void id
  void type
  return JSON.stringify(data)
}

const userMessage = (id: string, text: string) =>
  messageData(
    new SessionMessage.User({
      id: SessionMessage.ID.make(id),
      type: "user",
      text,
      files: [],
      agents: [],
      time: { created },
    }),
  )

const assistantMessage = (id: string) =>
  messageData(
    new SessionMessage.Assistant({
      id: SessionMessage.ID.make(id),
      type: "assistant",
      agent: "build",
      model,
      content: [],
      time: { created },
    }),
  )

const rows: Array<[string, "user" | "assistant", number, string]> = [
  ["msg_visual_user_1", "user", 1, userMessage("msg_visual_user_1", "Keep this turn")],
  ["msg_visual_assistant_1", "assistant", 2, assistantMessage("msg_visual_assistant_1")],
  ["msg_visual_user_2", "user", 3, userMessage("msg_visual_user_2", "Please edit tracked.txt")],
  ["msg_visual_assistant_2", "assistant", 4, assistantMessage("msg_visual_assistant_2")],
]
for (const [id, type, seq, data] of rows) {
  sqlite
    .query(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, sessionID, type, seq, createdMillis, createdMillis, data)
}

const mutation = (callID: string, file: string, beforeExists: boolean, after: string) =>
  sqlite
    .query(
      "INSERT INTO session_file_mutation (id, session_id, assistant_message_id, call_id, target, resource, before_exists, before_bytes, before_sha256, after_exists, after_bytes, after_sha256, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `sfm_visual_${callID}`,
      sessionID,
      "msg_visual_assistant_2",
      callID,
      path.join(worktree, file),
      file,
      beforeExists ? 1 : 0,
      beforeExists ? Buffer.byteLength(trackedBefore) : null,
      beforeExists ? sha(trackedBefore) : null,
      1,
      Buffer.byteLength(after),
      sha(after),
      createdMillis,
    )
mutation("call_visual_write", "tracked.txt", true, trackedAfter)
mutation("call_visual_create", "created.txt", false, createdContent)
sqlite.close()

process.stdout.write(
  `__OPENCODE_ROLLBACK_READY__${JSON.stringify({ root, worktree, dataHome, serverUrl, sessionID })}\n`,
)

// Hold the server for the spec; end stdin to stop it.
await new Promise<void>((resolve) => {
  process.stdin.resume()
  process.stdin.on("end", () => resolve())
  process.stdin.on("close", () => resolve())
})
server.kill()
llm.stop(true)
await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => undefined)
