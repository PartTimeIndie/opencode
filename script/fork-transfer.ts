import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { forkTransferExclusion } from "./fork-transfer-policy"

function git(cwd: string, args: string[], input?: string, index?: string) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
    stdin: input === undefined ? undefined : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trimEnd()
}

// Only transfer a pinned tree into a disposable, clean checkout of the clean base.
// The original branch and every original commit remain outside the new ancestry.
export function transferForkTree(input: { source: string; target: string; ref: string; base: string; apply?: boolean }) {
  if (![input.ref, input.base].every((ref) => /^[a-f0-9]{40}$/.test(ref)))
    throw new Error("Source and base must be full commit IDs")
  const source = resolve(input.source)
  const target = resolve(input.target)
  if (source.toLowerCase() === target.toLowerCase()) throw new Error("Use a separate target worktree")
  if (git(target, ["rev-parse", "HEAD"]) !== input.base) throw new Error("Target HEAD must be the clean base")
  git(target, ["diff", "--quiet"])
  git(target, ["diff", "--cached", "--quiet"])
  const ignored = new Set(git(source, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]).split("\0"))
  const files = git(source, ["ls-tree", "-r", "--name-only", "-z", input.ref]).split("\0").filter(Boolean)
  const excluded = files.flatMap((file) => {
    const reason = forkTransferExclusion(file, ignored.has(file))
    return reason ? [{ file, reason }] : []
  })
  const report = { source, ref: input.ref, base: input.base, included: files.length - excluded.length, excluded }
  if (!input.apply) return report

  // read-tree refuses collisions with untracked files. Do not reset or force-checkout
  // the user's source branch, and do not create a commit before verification.
  const state = resolve(git(target, ["rev-parse", "--absolute-git-dir"]), "fork-transfer")
  mkdirSync(state, { recursive: true })
  const index = resolve(state, "index")
  rmSync(index, { force: true })
  try {
    git(source, ["read-tree", input.ref], undefined, index)
    if (excluded.length) {
      git(source, ["update-index", "--force-remove", "-z", "--stdin"], excluded.map((item) => item.file).join("\0") + "\0", index)
      // Exclusions also apply to files inherited from the base. Restoring an excluded
      // base version would silently put private content back into the publication.
    }
    const tree = git(source, ["write-tree"], undefined, index)
    git(target, ["read-tree", "-m", "-u", input.base, tree])
    writeFileSync(resolve(state, "report.json"), JSON.stringify({ ...report, tree }, null, 2) + "\n")
    return { ...report, tree }
  } finally {
    rmSync(index, { force: true })
  }
}

if (import.meta.main) {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      source: { type: "string" },
      ref: { type: "string" },
      base: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  }).values
  if (!args.source || !args.ref || !args.base) throw new Error("Required: --source PATH --ref COMMIT --base COMMIT [--apply]")
  const report = transferForkTree({ source: args.source, target: process.cwd(), ref: args.ref, base: args.base, apply: args.apply })
  console.log(JSON.stringify({ ref: report.ref, base: report.base, included: report.included, excluded: report.excluded.length, applied: args.apply }, null, 2))
}
