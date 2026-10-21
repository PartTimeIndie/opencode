import fs from "fs/promises"
import { tmpdir as osTmpdir } from "os"
import path from "path"
import { afterEach } from "bun:test"

const pending = new Set<string>()

afterEach(async () => {
  for (const dir of [...pending]) {
    await remove(dir)
    pending.delete(dir)
  }
})

export const tmpdir = async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(osTmpdir(), "opencode-core-test-")))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      try {
        await remove(dir, 0)
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY") throw error
        pending.add(dir)
      }
    },
  }
}

async function remove(dir: string, retries = 30): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch (error) {
    if (retries === 0 || !error || typeof error !== "object" || !("code" in error) || error.code !== "EBUSY")
      throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
