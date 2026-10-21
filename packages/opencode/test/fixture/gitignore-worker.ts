import { appendGitignore } from "../../src/project/vcs"
import { Flock } from "@opencode-ai/core/util/flock"

const cwd = process.argv[2]
const pattern = process.argv[3]
if (!cwd || !pattern) throw new Error("Usage: gitignore-worker.ts <cwd> <pattern>")
if (process.env.OPENCODE_TEST_FLOCK_STATE) Flock.setGlobal({ state: process.env.OPENCODE_TEST_FLOCK_STATE })

const result = await appendGitignore(cwd, pattern)
if (process.env.OPENCODE_TEST_GITIGNORE_RESULT) {
  process.stdout.write(JSON.stringify(result))
  process.exit(0)
}
if (!result.ok) throw new Error(result.message ?? `Failed to append ${pattern}`)
