import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("GMX CLI previews an account without exposing its secret and refuses unapproved delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gmx-cli-"))
  const script = join(import.meta.dir, "../../script/gmx-email.ts")
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", script, ...args, "--config", dir], { stdout: "pipe", stderr: "pipe" })
    const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { out, err, exit }
  }
  try {
    const registered = await invoke("register", "--account", "gmx-personal", "--name", "GMX", "--email", "person@gmx.de", "--secret-id", "12345678-1234-1234-1234-123456789abc")
    expect(registered.exit).toBe(0)
    expect(registered.out).not.toContain("12345678-1234")
    const file = join(dir, "mail.json")
    await writeFile(file, JSON.stringify({ from: "person@gmx.de", to: ["recipient@example.com"], subject: "Hello", text: "Text" }))
    const preview = await invoke("preview", "--account", "gmx-personal", "--input", file)
    expect(preview.exit).toBe(0)
    expect(JSON.parse(preview.out)).toHaveProperty("hash")
    const send = await invoke("send", "--account", "gmx-personal", "--input", file,
      "--request-id", crypto.randomUUID(), "--approval-hash", JSON.parse(preview.out).hash)
    expect(send.exit).toBe(1)
    expect(send.err).toContain("Explicit final-message approval required")
    expect(send.out).toBe("")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
