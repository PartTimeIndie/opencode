import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const directory = fileURLToPath(new URL(".", import.meta.url))
const packages = []
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const root = path.join(directory, entry.name)
  const file = Bun.file(path.join(root, "package.json"))
  if (!(await file.exists())) continue
  const manifest = await file.json()
  const build = Bun.spawn([process.execPath, "run", "build"], { cwd: root, stdout: "inherit", stderr: "inherit" })
  if ((await build.exited) !== 0) throw new Error(`Failed to build ${manifest.name}`)
  const artifact = manifest.exports["./tui"]
  packages.push({
    directory: entry.name,
    name: manifest.name,
    version: manifest.version,
    api: manifest.opencode.api,
    artifact,
    sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(root, artifact)).bytes()).digest("hex"),
    peerDependencies: manifest.peerDependencies,
  })
}
await Bun.write(
  path.join(directory, "release-manifest.json"),
  JSON.stringify({ status: "prepared-only", packages }, null, 2) + "\n",
)
