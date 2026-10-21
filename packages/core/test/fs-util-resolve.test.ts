import { expect, test } from "bun:test"
import path from "node:path"
import { FSUtil } from "@opencode-ai/core/fs-util"

test("asynchronous resolution yields while a filesystem lookup is pending", async () => {
  let release!: (value: string) => void
  const lookup = new Promise<string>((resolve) => {
    release = resolve
  })
  const pending = FSUtil.resolveAsync("C:\\GitRepros\\opencode", () => lookup)
  let ticked = false
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise<void>((resolve) => setTimeout(() => {
    ticked = true
    resolve()
  }, 0))
  expect(ticked).toBeTrue()
  expect(settled).toBeFalse()
  release(path.resolve("C:\\GitRepros\\opencode"))
  expect(await pending).toBe(path.resolve("C:\\GitRepros\\opencode"))
})
