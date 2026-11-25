import { parseArgs } from "node:util"
import { MirrorSession } from "../packages/core/src/session/workspace/mirror-session"

const args = parseArgs({ args: process.argv.slice(2), strict: true, options: {
  action: { type: "string" }, directory: { type: "string" }, session: { type: "string" },
  root: { type: "string" }, untracked: { type: "string", multiple: true },
  "reservation-digest": { type: "string" },
} }).values
if (!["status", "start", "close", "discard", "recover", "recover-legacy-empty"].includes(args.action ?? "") || !args.directory || !args.session ||
  (args["reservation-digest"] !== undefined && !["recover", "recover-legacy-empty"].includes(args.action ?? "")))
  throw new Error("Usage: bun mirror.ts --action status|start|close|discard|recover|recover-legacy-empty --directory <source-root> --session <host-session-id> [--untracked <relative-file>] [--reservation-digest <reviewed-recovery-plan>]\n" +
    "close is a read-only merge plan; the reviewed application into the source runs host-side through mirror_integrate, never this CLI.")

const input = { directory: args.directory, sessionID: args.session,
  root: args.root ?? MirrorSession.defaultRoot(process.env.XDG_DATA_HOME) }
// Status/start only need the small filesystem adapter, not the host-side
// integration dependency graph. Keep repeated CLI inspection inexpensive.
const close = async () => {
  const { MirrorClose } = await import("../packages/core/src/session/workspace/mirror-close")
  return args.action === "close" ? MirrorClose.close(input) : MirrorClose.discard(input)
}
const assertQuiescent = async () => {
  if (process.platform !== "win32") throw new Error("Legacy empty recovery requires Windows host inspection")
  const command = "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'OpenCode.exe' OR Name = 'opencode-cli.exe' OR Name = 'bun.exe' OR Name = 'node.exe'\" -ErrorAction Stop | Select-Object ProcessId,Name,CommandLine) -Compress"
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
    { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code) throw new Error(`Cannot attest Mirror writer quiescence: ${stderr.trim()}`)
  const rows = JSON.parse(stdout) as { ProcessId: number; Name: string; CommandLine?: string }[]
  if (!Array.isArray(rows)) throw new Error("Cannot attest Mirror writer quiescence: invalid process inventory")
  const active = rows.filter((row) => row.ProcessId !== process.pid &&
    (["opencode.exe", "opencode-cli.exe"].includes(row.Name.toLowerCase()) ||
      (["bun.exe", "node.exe"].includes(row.Name.toLowerCase()) && /(?:^|[\\/])mirror\.ts\b/i.test(row.CommandLine ?? ""))))
  if (active.length) throw new Error(`Mirror writer quiescence is not established: ${active.map((row) => `${row.Name}:${row.ProcessId}`).join(", ")}`)
}
const result = args.action === "start"
  ? await MirrorSession.start({ ...input, untracked: args.untracked })
  : args.action === "recover"
    ? await MirrorSession.recover({ ...input, planDigest: args["reservation-digest"] })
    : args.action === "recover-legacy-empty"
      ? await MirrorSession.recoverLegacyEmpty({ ...input, planDigest: args["reservation-digest"], assertQuiescent })
    : args.action === "close" || args.action === "discard"
      ? await close()
      : await MirrorSession.inspect(input)
console.log(JSON.stringify(result))
