import path from "node:path"
import { readdir, realpath, rm } from "node:fs/promises"
import { createHash } from "node:crypto"

const root = import.meta.dir
const artifacts = []
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const directory = path.join(root, entry.name)
  if (!(await Bun.file(path.join(directory, "package.json")).exists())) continue
  const manifest = await Bun.file(path.join(directory, "package.json")).json()
  const output = path.resolve(directory, "dist")
  const resolved = await realpath(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return output
  })
  if (!resolved.startsWith((await realpath(root)) + path.sep) || path.basename(resolved) !== "dist")
    throw new Error(`Unsafe provider build output: ${output}`)
  await rm(output, { recursive: true, force: true })
  const result = Bun.spawnSync(["bun", "run", "build"], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode) throw new Error(`${entry.name}: ${result.stderr.toString()}`)
  const exportPath = manifest.exports["./provider"] ?? manifest.exports["./server"]
  const artifact = path.join(directory, exportPath)
  const files = []
  for await (const file of new Bun.Glob("dist/**/*").scan({ cwd: directory, onlyFiles: true }))
    files.push({
      path: file.replaceAll("\\", "/"),
      sha256: createHash("sha256")
        .update(new Uint8Array(await Bun.file(path.join(directory, file)).arrayBuffer()))
        .digest("hex"),
    })
  artifacts.push({
    name: manifest.name,
    version: manifest.version,
    api: manifest.opencode.api,
    directory: entry.name,
    exports: manifest.exports,
    artifact: exportPath.replace(/^\.\//, ""),
    files,
    sha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(artifact).arrayBuffer()))
      .digest("hex"),
  })
}
await Bun.write(
  path.join(root, "release-manifest.json"),
  JSON.stringify({ status: "prepared-only", artifacts }, null, 2) + "\n",
)
console.log(`Built ${artifacts.length} independent provider packages`)
