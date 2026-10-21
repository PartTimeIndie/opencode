import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

// Only model transport is scripted. Admission, native tools, DB, HTTP, events
// and the browser use the production source. No cloud model or installed app.
const root = await mkdtemp(path.join(tmpdir(), "opencode-file-knowledge-visual-"))
const worktree = path.join(root, "worktree")
await mkdir(worktree)
await writeFile(path.join(worktree, "a.txt"), "original")
const requests: unknown[] = []
const stages = { normal: 0, conflict: 0 }
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: unknown }>
      tools?: Array<{ function?: { name: string } }>
    }
    requests.push(body)
    await writeFile(path.join(root, "requests.json"), JSON.stringify(requests))
    const main = body.tools?.some((tool) => tool.function?.name === "read")
    const conflict = JSON.stringify(
      body.messages.filter((message) => message.role === "user").at(-1)?.content,
    ).includes("qa-file-conflict")
    const stage = main ? stages[conflict ? "conflict" : "normal"]++ : -1
    const call = !conflict
      ? [
          { name: "read", input: { path: "a.txt" } },
          { name: "edit", input: { path: "a.txt", oldString: "original", newString: "first guarded edit" } },
          { name: "write", input: { path: "a.txt", content: "own confirmed follow-up" } },
        ][stage]
      : [
          { name: "read", input: { path: "a.txt" } },
          { name: "write", input: { path: "a.txt", content: "must never replace human" } },
        ][stage]
    if (main && conflict && stage === 1) await writeFile(path.join(worktree, "a.txt"), "human concurrent change")
    const delta = call
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${conflict ? "conflict" : "normal"}_${stage}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            },
          ],
        }
      : {
          role: "assistant",
          content: !main
            ? "File protection QA"
            : conflict
              ? "Conflict preserved. No automatic retry."
              : "Protected read-edit-own-write flow complete.",
        }
    const choices = [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: call ? "tool_calls" : "stop" },
    ]
    return new Response(
      choices
        .map(
          (choice) =>
            `data: ${JSON.stringify({ id: "chatcmpl-file-protection", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
await writeFile(
  path.join(worktree, "opencode.json"),
  JSON.stringify({
    model: "file-qa/local-model",
    small_model: "file-qa/local-model",
    permission: { "*": "allow" },
    provider: {
      "file-qa": {
        name: "Local file protection QA",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "local-fixture-only", baseURL: `${llm.url}v1` },
        models: {
          "local-model": { name: "Scripted local model", limit: { context: 100000, output: 2000 }, tool_call: true },
        },
      },
    },
  }),
)
const server = spawn(
  process.execPath,
  ["--conditions=browser", "./src/index.ts", "--print-logs", "serve", "--port", "0", "--hostname", "127.0.0.1"],
  {
    cwd: path.resolve(import.meta.dir, "../../../opencode"),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: path.join(root, "xdg/data"),
      XDG_CONFIG_HOME: path.join(root, "xdg/config"),
      XDG_STATE_HOME: path.join(root, "xdg/state"),
      XDG_CACHE_HOME: path.join(root, "xdg/cache"),
      OPENCODE_DB: path.join(root, "opencode.sqlite"),
      OPENCODE_DISABLE_SHARE: "true",
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
try {
  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`isolated server startup timed out; inspect ${root}/server.log`)),
      120000,
    )
    let buffer = ""
    server.stdout.on("data", (chunk: string) => {
      void appendFile(path.join(root, "server.log"), chunk)
      buffer = `${buffer}${chunk}`.slice(-32768)
      const match = /opencode server listening on (http:\/\/\S+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    })
    server.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`isolated server exited ${code}`))
    })
  })
  const sessionID = `ses_file_knowledge_qa_${Date.now().toString(36)}`
  const created = await fetch(`${serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: sessionID,
      location: { directory: worktree },
      model: { id: "local-model", providerID: "file-qa" },
    }),
  })
  if (!created.ok) throw new Error(`Session creation failed: ${created.status} ${await created.text()}`)
  process.stdout.write(`__FILE_KNOWLEDGE_READY__${JSON.stringify({ root, worktree, serverUrl, sessionID })}\n`)
  await Bun.stdin.text()
} finally {
  server.kill()
  await new Promise<void>((resolve) => (server.exitCode !== null ? resolve() : server.once("exit", () => resolve())))
  llm.stop(true)
  // The spec exports compact requests/logs before closing stdin.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
