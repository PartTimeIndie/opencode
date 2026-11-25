import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const require = createRequire(import.meta.url)
const electron: unknown = require("electron")
if (typeof electron !== "string") throw new Error("Electron dependency is unavailable")
const version: string = require("electron/package.json").version
const root = await mkdtemp(join(tmpdir(), "opencode-electron-runtime-"))
try {
  const main = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/electron-runtime/main.ts")],
    outdir: root, target: "node", format: "esm", external: ["electron"],
  })
  const preload = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/preload/index.ts")],
    outdir: root, naming: "preload.cjs", target: "node", format: "cjs", external: ["electron"],
  })
  if (!main.success || !preload.success) throw new Error([...main.logs, ...preload.logs].join("\n"))
  const child = Bun.spawn([electron, join(root, "main.js")], {
    cwd: root,
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: undefined,
      OPENCODE_RUNTIME_TEST_ROOT: root, OPENCODE_RUNTIME_TEST_VERSION: version,
      OPENCODE_RUNTIME_TEST_CORE: resolve(import.meta.dir, "../../core/package.json"),
      OPENCODE_RUNTIME_TEST_ICON: resolve(import.meta.dir, "../resources/icons/StoreLogo.png"),
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 30_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  if (code !== 0) throw new Error(`Isolated runtime fixture failed (${code}):\n${(stdout + stderr).slice(-8000)}`)
  console.log(stdout.trim())
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
