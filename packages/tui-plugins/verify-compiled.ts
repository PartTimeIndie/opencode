import { mkdtemp, mkdir, readdir, copyFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL(".", import.meta.url))
const output = await mkdtemp(path.join(os.tmpdir(), "opencode-tui-packages-"))
const executable = path.join(output, "tui-plugin-smoke.exe")
const result = await Bun.build({
  entrypoints: [path.join(directory, "../opencode/test/fixture/tui-compiled-smoke.ts")],
  conditions: ["bun", "node"],
  compile: { outfile: executable, autoloadBunfig: false, autoloadDotenv: false, autoloadPackageJson: false, autoloadTsconfig: false },
})
if (!result.success) throw new AggregateError(result.logs, "Compiled TUI smoke build failed")
await Bun.write(path.join(output, "peer-probe.js"), 'export { RGBA } from "@opentui/core"; export { createSignal } from "solid-js"; export { useBindings } from "@opentui/keymap/solid";')
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const root = path.join(directory, entry.name)
  if (!(await Bun.file(path.join(root, "package.json")).exists())) continue
  await mkdir(path.join(output, entry.name, "dist"), { recursive: true })
  await copyFile(path.join(root, "package.json"), path.join(output, entry.name, "package.json"))
  await copyFile(path.join(root, "dist/index.js"), path.join(output, entry.name, "dist/index.js"))
}
const child = Bun.spawn([executable, output], { cwd: output, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_PATH: "" } })
const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
await Bun.write(path.join(output, "receipt.json"), JSON.stringify({ exitCode, stdout, stderr, output }, null, 2))
console.log(JSON.stringify({ exitCode, stdout, stderr, output }))
if (exitCode !== 0) process.exit(exitCode)
