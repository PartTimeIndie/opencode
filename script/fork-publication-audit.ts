import { parseArgs } from "node:util"
import { forkTransferExclusion } from "./fork-transfer-policy"

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trimEnd()
}

/** Read-only: audit the index, a pinned tree, or every tree reachable from it. */
export function auditForkPublication(input: { cwd: string; ref?: string; history?: boolean }) {
  if (input.history && !input.ref) throw new Error("History auditing requires --ref")
  const ref = input.ref ? git(input.cwd, ["rev-parse", "--verify", "--end-of-options", `${input.ref}^{commit}`]) : undefined
  const ignored = ref ? new Set<string>() : new Set(git(input.cwd, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]).split("\0"))
  const files = git(input.cwd, ref ? ["ls-tree", "-r", "--name-only", "-z", ref] : ["ls-files", "--cached", "-z"]).split("\0").filter(Boolean)
  const excluded = files.flatMap((file) => {
    const reason = forkTransferExclusion(file, ignored.has(file))
    return reason ? [{ file, reason }] : []
  })
  const commits = input.history ? git(input.cwd, ["rev-list", ref!]).split("\n").filter(Boolean) : []
  const historical = new Map<string, { file: string; reason: string; commit: string }>()
  for (const commit of commits) {
    for (const file of git(input.cwd, ["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean)) {
      const reason = forkTransferExclusion(file)
      if (reason && !historical.has(file)) historical.set(file, { file, reason, commit })
    }
  }
  return { ref: ref ?? "index", checked: files.length, excluded, commitsChecked: commits.length, historical: [...historical.values()] }
}

if (import.meta.main) {
  const args = parseArgs({ options: { ref: { type: "string" }, history: { type: "boolean" }, json: { type: "boolean" } } }).values
  const report = auditForkPublication({ cwd: process.cwd(), ref: args.ref, history: args.history })
  const ok = report.excluded.length === 0 && report.historical.length === 0
  console.log(JSON.stringify(args.json ? report : {
    ok,
    ref: report.ref,
    checked: report.checked,
    excluded: report.excluded.length,
    reasons: report.excluded.reduce<Record<string, number>>((counts, item) => {
      counts[item.reason] = (counts[item.reason] ?? 0) + 1
      return counts
    }, {}),
    commitsChecked: report.commitsChecked,
    historicalExcluded: report.historical.length,
    examples: report.excluded.slice(0, 12),
  }, null, 2))
  process.exitCode = ok ? 0 : 1
}
