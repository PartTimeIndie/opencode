import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export async function supportsSymlinks() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-symlink-capability-"))
  return fs
    .writeFile(path.join(directory, "target"), "target")
    .then(() => fs.symlink(path.join(directory, "target"), path.join(directory, "link"), "file"))
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS") return false
      throw error
    })
    .finally(() => fs.rm(directory, { recursive: true, force: true }).catch(() => undefined))
}
