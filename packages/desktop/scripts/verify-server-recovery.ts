import { mkdtemp, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// Build only isolated fixtures from current source. Never load the installed app's data or executable.
const electron: unknown = createRequire(import.meta.url)("electron")
if (typeof electron !== "string") throw new Error("Electron dependency is unavailable")
const root = await mkdtemp(join(tmpdir(), "opencode-server-recovery-"))
try {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/server-recovery/main.ts"), resolve(import.meta.dir, "fixtures/server-recovery/sidecar.ts")],
    outdir: root, target: "node", format: "esm", external: ["electron"],
  })
  if (!build.success) throw new Error(build.logs.join("\n"))
  const child = Bun.spawn([electron, join(root, "main.js")], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, OPENCODE_RECOVERY_TEST_ROOT: root,
      OPENCODE_RECOVERY_TEST_ICON: resolve(import.meta.dir, "../resources/icons/icon.ico"),
      XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 35_000)
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .finally(() => clearTimeout(timer))
  if (code !== 0) throw new Error(`Isolated recovery fixture failed (${code}):\n${(stdout + stderr).slice(-8000)}`)
  console.log(stdout.trim())
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
