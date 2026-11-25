import { expect, test } from "bun:test"
import { createSidecarStop, forceSidecarStop } from "./sidecar-stop"
import { createShutdownCoordinator } from "./shutdown"

test("shares a graceful stop and completes only on observed exit", async () => {
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { resolveExit = resolve })
  let requests = 0
  const stop = createSidecarStop({ requestStop: () => { requests++ }, exited, isExited: () => false })
  const first = stop()
  expect(stop()).toBe(first)
  expect(requests).toBe(1)
  resolveExit(0)
  await first
})

test("a deadline neither kills a real child nor exits the parent; a later confirmed exit permits retry", async () => {
  const child = Bun.spawn([process.execPath, "-e", 'console.log("ready"); process.stdin.once("data", () => setTimeout(() => process.exit(0), 250)); setInterval(() => {}, 1000)'], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  })
  const reader = child.stdout.getReader()
  try {
    await reader.read()
    let requests = 0
    const stop = createSidecarStop({ requestStop: () => { requests++; if (requests === 1) child.stdin.write("stop\n") },
      exited: child.exited, isExited: () => child.exitCode !== null, timeoutMs: 20 })
    const errors: unknown[] = []
    let parentExits = 0
    const shutdown = createShutdownCoordinator({ cleanup: stop, onCleanupError: (error) => errors.push(error) })
    await shutdown.request(() => { parentExits++ })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("exit unconfirmed")
    expect(parentExits).toBe(0)
    expect(child.exitCode).toBeNull()
    expect(await child.exited).toBe(0)
    await shutdown.request(() => { parentExits++ })
    expect(parentExits).toBe(1)
    expect(requests).toBe(1)
  } finally {
    reader.releaseLock()
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}, 10_000)

test("force waits for real child exit and does not kill an already exited child", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
  let kills = 0
  try {
    await forceSidecarStop({
      kill: () => { kills++; child.kill() },
      exited: child.exited,
      isExited: () => child.exitCode !== null,
      timeoutMs: 5000,
    })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    await forceSidecarStop({ kill: () => { kills++ }, exited: child.exited, isExited: () => true })
    expect(kills).toBe(1)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await child.exited
  }
})

test("force failure does not pretend the child exited", async () => {
  await expect(forceSidecarStop({ kill: () => {}, exited: new Promise<number>(() => {}), isExited: () => false, timeoutMs: 10 }))
    .rejects.toThrow("exit unconfirmed")
})
