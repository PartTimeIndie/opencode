import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

// Script only provider transport; admission, projection, permission and skill loading are real.
const root = await mkdtemp(path.join(tmpdir(), "opencode-skill-selection-"))
const worktree = path.join(root, "worktree")
await mkdir(worktree)
const names = ["manual-flow", "ask-flow", "denied-flow"]
for (const name of names) {
  const directory = path.join(worktree, ".opencode", "skills", name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Isolated skill selection fixture\ndisable-model-invocation: true\n---\n\nLOADED_${name}\n`)
}
const requests: unknown[] = []
const llm = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json() as {
      messages: Array<{ role: string; content: unknown }>
      tools?: Array<{ function?: { name: string } }>
    }
    requests.push({ messages: body.messages.filter((message) => message.role === "user" || message.role === "tool") })
    await writeFile(path.join(root, "requests.json"), JSON.stringify(requests))
    const last = body.messages.findLastIndex((message) => message.role === "user")
    const text = JSON.stringify(body.messages[last]?.content)
    const name = names.find((name) => text.includes(name)) ?? "manual-flow"
    const main = body.tools?.some((tool) => tool.function?.name === "skill")
    const called = body.messages.slice(last + 1).some((message) => message.role === "tool")
    const call = main && !called
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "skill", arguments: JSON.stringify({ name }) } }] }
      : { role: "assistant", content: main ? `QA_DONE_${name}` : "Skill selection QA" }
    return new Response(
      [{ delta, finish_reason: null }, { delta: {}, finish_reason: call ? "tool_calls" : "stop" }]
        .map((choice) => `data: ${JSON.stringify({ id: "chatcmpl-skill", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
// Invocation policy is global-only; a project document must not widen or replace it.
const configDirectory = path.join(root, "xdg/config/opencode")
await mkdir(configDirectory, { recursive: true })
await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({
  model: "skill-qa/local-model", small_model: "skill-qa/local-model",
  permission: { "*": "allow" },
  skill_invocation: { entries: {
    "manual-flow": { visible: false, invocation: "manual" },
    "ask-flow": { visible: false, invocation: "ask" },
    "denied-flow": { visible: false, invocation: "deny" },
  } },
  provider: { "skill-qa": {
    name: "Local skill QA", npm: "@ai-sdk/openai-compatible", env: [],
    options: { apiKey: "local-fixture-only", baseURL: `${llm.url}v1` },
    models: { "local-model": { name: "Scripted local model", limit: { context: 100000, output: 2000 }, tool_call: true } },
  } },
}))
const server = spawn(process.execPath,
  ["--conditions=browser", "./src/index.ts", "--print-logs", "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: path.resolve(import.meta.dir, "../../../opencode"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env,
      HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: configDirectory,
      XDG_DATA_HOME: path.join(root, "xdg/data"), XDG_CONFIG_HOME: path.join(root, "xdg/config"),
      XDG_STATE_HOME: path.join(root, "xdg/state"), XDG_CACHE_HOME: path.join(root, "xdg/cache"),
      OPENCODE_DB: path.join(root, "opencode.sqlite"), OPENCODE_DISABLE_SHARE: "true",
      OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "opencode",
    },
  })
process.on("exit", () => { server.kill(); llm.stop(true) })
server.stdout.setEncoding("utf8")
server.stderr.setEncoding("utf8")
server.stderr.on("data", (chunk: string) => { void appendFile(path.join(root, "server.log"), chunk) })
try {
  const serverUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${root}/server.log`)), 120000)
    let output = ""
    server.stdout.on("data", (chunk: string) => {
      void appendFile(path.join(root, "server.log"), chunk)
      output = `${output}${chunk}`.slice(-32768)
      const match = /opencode server listening on (http:\/\/\S+)/.exec(output)
      if (match) { clearTimeout(timer); resolve(match[1]!) }
    })
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)) })
  })
  const sessionID = `ses_skill_qa_${Date.now().toString(36)}`
  const response = await fetch(`${serverUrl}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: sessionID, location: { directory: worktree }, model: { id: "local-model", providerID: "skill-qa" } }),
  })
  if (!response.ok) throw new Error(`Session creation: ${response.status} ${await response.text()}`)
  process.stdout.write(`__SKILL_READY__${JSON.stringify({ root, worktree, serverUrl, sessionID })}\n`)
  await Bun.stdin.text()
} finally {
  server.kill()
  await new Promise<void>((resolve) => server.exitCode !== null ? resolve() : server.once("exit", () => resolve()))
  llm.stop(true)
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
