import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { IsolatedWorker } from "../src/isolated-worker"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("isolated worker", () => {
  test("resolves the bundled Electron worker with run-as-node isolation", () => {
    const invocation = IsolatedWorker.resolve(["storage", "checkpoint-worker", "input.json"], {
      execPath: "C:\\Program Files\\OpenCode\\OpenCode.exe",
      argv: ["OpenCode.exe"],
      env: { OPENCODE_NODE_WORKER: "C:\\Program Files\\OpenCode\\resources\\storage-worker.js" },
      versions: { ...process.versions, electron: "42.0.0" },
    })

    expect(invocation).toMatchObject({
      command: "C:\\Program Files\\OpenCode\\OpenCode.exe",
      args: ["C:\\Program Files\\OpenCode\\resources\\storage-worker.js", "storage", "checkpoint-worker", "input.json"],
    })
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBe("1")
  })

  test("refuses to start another desktop instance when the worker entry is missing", () => {
    expect(() =>
      IsolatedWorker.resolve(["storage", "checkpoint-worker", "input.json"], {
        execPath: "C:\\Program Files\\OpenCode\\OpenCode.exe",
        argv: ["OpenCode.exe"],
        env: {},
        versions: { ...process.versions, electron: "42.0.0" },
      }),
    ).toThrow("OPENCODE_NODE_WORKER")
  })

  test("preserves the JavaScript entrypoint under standalone Node", () => {
    expect(
      IsolatedWorker.resolve(["storage", "session-worker", "input.json"], {
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        argv: ["node.exe", "C:\\OpenCode\\index.js"],
        env: {},
        versions: { ...process.versions },
      }),
    ).toMatchObject({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\OpenCode\\index.js", "storage", "session-worker", "input.json"],
    })
  })

  test("ignores an inherited OPENCODE_NODE_WORKER in the compiled binary", () => {
    // Regression for the deploy smoke failure: a shell spawned inside the
    // desktop app inherits OPENCODE_NODE_WORKER, but the compiled binary
    // cannot execute the asar worker entry and must not try.
    const invocation = IsolatedWorker.resolve(["storage", "checkpoint-worker", "input.json"], {
      execPath: "C:\\Users\\crisc\\AppData\\Local\\Programs\\opencode\\opencode.exe",
      argv: ["opencode.exe"],
      env: {
        OPENCODE_NODE_WORKER:
          "C:\\Users\\crisc\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources\\app.asar\\out\\main\\storage-worker.js",
      },
      versions: { ...process.versions },
    })

    expect(invocation).toEqual({
      command: "C:\\Users\\crisc\\AppData\\Local\\Programs\\opencode\\opencode.exe",
      args: ["storage", "checkpoint-worker", "input.json"],
      env: {
        OPENCODE_NODE_WORKER:
          "C:\\Users\\crisc\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources\\app.asar\\out\\main\\storage-worker.js",
      },
    })
  })

  test("uses its own entrypoint under Bun when the worker variable leaks into the environment", () => {
    const invocation = IsolatedWorker.resolve(["storage", "session-worker", "input.json"], {
      execPath: "C:\\Users\\crisc\\.bun\\bin\\bun.exe",
      argv: ["bun.exe", "C:\\GitRepros\\opencode\\packages\\opencode\\src\\index.ts"],
      env: {
        OPENCODE_NODE_WORKER:
          "C:\\Users\\crisc\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources\\app.asar\\out\\main\\storage-worker.js",
      },
      versions: { ...process.versions },
    })

    expect(invocation).toEqual({
      command: "C:\\Users\\crisc\\.bun\\bin\\bun.exe",
      args: ["C:\\GitRepros\\opencode\\packages\\opencode\\src\\index.ts", "storage", "session-worker", "input.json"],
      env: {
        OPENCODE_NODE_WORKER:
          "C:\\Users\\crisc\\AppData\\Local\\Programs\\@opencode-aidesktop\\resources\\app.asar\\out\\main\\storage-worker.js",
      },
    })
  })

  test("launches the configured worker instead of an injected spawn mock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-isolated-worker-"))
    roots.push(root)
    const worker = path.join(root, "worker.js")
    await writeFile(worker, "process.stdout.write(JSON.stringify(process.argv.slice(2)))")
    const child = IsolatedWorker.launch(["storage", "session-worker", "input.json"], {
      execPath: process.execPath,
      argv: process.argv,
      env: { ...process.env, OPENCODE_NODE_WORKER: worker },
      // The worker contract belongs to the Electron sidecar runtime; bun merely
      // executes the same entry here so the spawn stays real.
      versions: { ...process.versions, electron: "42.0.0" },
    })
    child.stdin.end()
    const output = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve(code ?? 1))
    })

    expect(exitCode).toBe(0)
    expect(await stderr).toBe("")
    expect(JSON.parse(await output)).toEqual(["storage", "session-worker", "input.json"])
  })
})
