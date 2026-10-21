import type { ChildProcess } from "node:child_process"

// EOF asks only the owned fixture worker to shut down. Setup can leave no
// worker or no input pipe; teardown must not touch any installed app process.
export function endFixtureWorkerInput(worker?: Pick<ChildProcess, "stdin">) {
  worker?.stdin?.end()
}
