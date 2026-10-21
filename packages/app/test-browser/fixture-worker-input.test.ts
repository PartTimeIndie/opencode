import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { endFixtureWorkerInput } from "../e2e/utils/fixture-worker-input"

test("fixture teardown is safe when setup never created a worker", () => {
  expect(() => endFixtureWorkerInput()).not.toThrow()
})

test("fixture teardown is safe when the worker has no stdin pipe", () => {
  expect(() => endFixtureWorkerInput({ stdin: null })).not.toThrow()
})

test("fixture teardown sends EOF to the actual owned worker without a kill signal", async () => {
  const worker = spawn("node", ["-e", "process.stdin.resume(); process.stdin.once('end', () => { process.stdout.write('fixture-eof'); process.exit(0) })"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const output: string[] = []
  worker.stdout.setEncoding("utf8")
  worker.stdout.on("data", (chunk: string) => output.push(chunk))
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    worker.once("error", reject)
    worker.once("close", (code, signal) => resolve({ code, signal }))
  })
  try {
    endFixtureWorkerInput(worker)
    expect(await exited).toEqual({ code: 0, signal: null })
    expect(output.join("")).toBe("fixture-eof")
    expect(worker.killed).toBe(false)
  } finally {
    if (worker.exitCode === null && !worker.killed) worker.kill()
  }
})
