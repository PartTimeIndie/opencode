import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { FileLockRecovery } from "@opencode-ai/core/file-lock-recovery"
import { Hash } from "@opencode-ai/core/util/hash"
import { tmpdir } from "./fixture/tmpdir"

const fixture = async (pid: number) => {
  const tmp = await tmpdir()
  const target = path.join(tmp.path, "target.txt")
  const directory = path.join(tmp.path, `${Hash.fast(`file-mutation:${target}`)}.lock`)
  const token = randomUUID()
  await fs.mkdir(directory)
  await fs.writeFile(
    path.join(directory, `owner-${token}.json`),
    JSON.stringify({ token, pid, hostname: os.hostname(), createdAt: new Date().toISOString() }),
  )
  return { tmp, input: { target, lockRoot: tmp.path }, directory }
}

const exitedPID = async () => {
  const child = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

test("manual recovery refuses a live owner and preserves all lock evidence", async () => {
  const { tmp, input } = await fixture(process.pid)
  await using cleanup = tmp
  const observed = await FileLockRecovery.inspect(input)
  await expect(
    FileLockRecovery.recover({ ...input, ownerToken: observed.token, ownerSha256: observed.ownerSha256 }),
  ).rejects.toThrow("live or cannot be checked")
  expect(await FileLockRecovery.inspect(input)).toEqual(observed)
})

test("manual recovery requires unchanged token/hash and removes only an exited owner generation", async () => {
  const { tmp, input, directory } = await fixture(await exitedPID())
  await using cleanup = tmp
  const observed = await FileLockRecovery.inspect(input)
  await expect(
    FileLockRecovery.recover({ ...input, ownerToken: "wrong", ownerSha256: observed.ownerSha256 }),
  ).rejects.toThrow("changed")
  await expect(
    FileLockRecovery.recover({ ...input, ownerToken: observed.token, ownerSha256: "wrong" }),
  ).rejects.toThrow("changed")
  expect(await fs.readdir(directory)).toHaveLength(1)
  expect(
    await FileLockRecovery.recover({ ...input, ownerToken: observed.token, ownerSha256: observed.ownerSha256 }),
  ).toEqual({ target: input.target, releasedToken: observed.token })
  expect(
    await fs.access(directory).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("manual recovery preserves unknown/foreign evidence rather than recursively deleting", async () => {
  const { tmp, input, directory } = await fixture(await exitedPID())
  await using cleanup = tmp
  const observed = await FileLockRecovery.inspect(input)
  await fs.writeFile(path.join(directory, "foreign-generation"), "preserve")
  await expect(
    FileLockRecovery.recover({ ...input, ownerToken: observed.token, ownerSha256: observed.ownerSha256 }),
  ).rejects.toThrow("extra lock evidence")
  expect(await fs.readFile(path.join(directory, "foreign-generation"), "utf8")).toBe("preserve")
  expect(await fs.readdir(directory)).toHaveLength(2)
})
