#!/usr/bin/env bun
import { spawn } from "node:child_process"
import path from "node:path"
import { createServer } from "vite"
import solid from "../vite"
import { fileURLToPath } from "node:url"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const host = process.env.PLAYWRIGHT_HOST ?? "127.0.0.1"
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://${host}:${port}`
const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
const debugBar = process.env.VITE_DISABLE_DEBUG_BAR ?? "1"
const playwrightArgs = process.argv.slice(2).filter((arg, index) => arg !== "--" || index !== 0)

const server = await createServer({
  plugins: [solid],
  server: {
    host,
    port,
    strictPort: true,
  },
  define: {
    "import.meta.env.VITE_OPENCODE_SERVER_HOST": JSON.stringify(serverHost),
    "import.meta.env.VITE_OPENCODE_SERVER_PORT": JSON.stringify(serverPort),
    "import.meta.env.VITE_DISABLE_DEBUG_BAR": JSON.stringify(debugBar),
  },
})

await server.listen()
server.printUrls()

const env: Record<string, string | undefined> = {
  ...process.env,
  PLAYWRIGHT_BASE_URL: baseURL,
  PLAYWRIGHT_NO_WEB_SERVER: "1",
  VITE_OPENCODE_SERVER_HOST: serverHost,
  VITE_OPENCODE_SERVER_PORT: serverPort,
  VITE_DISABLE_DEBUG_BAR: debugBar,
}
// `bun run` injects FORCE_COLOR=1 into every child process it spawns for a
// package script. Together with a machine-wide NO_COLOR that makes Node's
// lazy color resolution warn on every assert inside the Playwright child.
// Node prefers FORCE_COLOR, so drop NO_COLOR for the child: effective colors
// stay exactly as before, only the conflicting-env warning disappears.
delete env.NO_COLOR

const child = spawn("node", [fileURLToPath(import.meta.resolve("@playwright/test/cli")), "test", ...playwrightArgs], {
  cwd: path.dirname(import.meta.dir),
  stdio: "inherit",
  shell: false,
  env,
})

const exitCode = await new Promise<number>((resolve) => {
  child.on("exit", (code) => resolve(code ?? 1))
  child.on("error", () => resolve(1))
})

const closed = await Promise.race([
  server.close().then(() => true),
  new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
])
if (!closed) console.warn("Vite server cleanup exceeded 5 seconds; forcing wrapper exit")
process.exit(exitCode)
