import path from "node:path"

export function command(
  args: ReadonlyArray<string>,
  runtime: { readonly execPath: string; readonly argv: ReadonlyArray<string> } = process,
) {
  const executable = path.basename(runtime.execPath).toLowerCase()
  if (executable !== "bun" && executable !== "bun.exe") return [runtime.execPath, ...args]
  const entry = runtime.argv[1]
  if (!entry) throw new Error("The Bun OpenCode entrypoint could not be determined")
  return [runtime.execPath, entry, ...args]
}

export async function run(args: ReadonlyArray<string>) {
  const child = Bun.spawn(command(args), { stdout: "ignore", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode === 0) return
  throw new Error(stderr.trim() || `OpenCode worker exited ${exitCode}`)
}
