export * as IsolatedWorker from "./isolated-worker"

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"

export type Runtime = {
  readonly execPath: string
  readonly argv: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
  readonly versions: NodeJS.ProcessVersions
}

export type Invocation = {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
}

export function resolve(args: ReadonlyArray<string>, runtime: Runtime = process): Invocation {
  // OPENCODE_NODE_WORKER is the Electron sidecar's worker contract: only an
  // Electron executable can execute the bundled worker through
  // ELECTRON_RUN_AS_NODE. Bun, Node, and compiled OpenCode binaries merely
  // inherit the variable from desktop-spawned shells and must ignore it.
  if (runtime.versions.electron) {
    const worker = runtime.env.OPENCODE_NODE_WORKER
    if (!worker) throw new Error("The Electron sidecar did not configure OPENCODE_NODE_WORKER")
    return {
      command: runtime.execPath,
      args: [path.resolve(worker), ...args],
      env: { ...runtime.env, ELECTRON_RUN_AS_NODE: "1" },
    }
  }

  const executable = path.basename(runtime.execPath).toLowerCase()
  if (!["bun", "bun.exe", "node", "node.exe"].includes(executable))
    return { command: runtime.execPath, args, env: runtime.env }
  const entry = runtime.argv[1]
  if (!entry) throw new Error(`The ${executable.startsWith("bun") ? "Bun" : "Node"} OpenCode entrypoint could not be determined`)
  return { command: runtime.execPath, args: [entry, ...args], env: runtime.env }
}

export function launch(args: ReadonlyArray<string>, runtime: Runtime = process): ChildProcessWithoutNullStreams {
  const invocation = resolve(args, runtime)
  return spawn(invocation.command, [...invocation.args], {
    env: invocation.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
}
