import { parseArgs } from "node:util"
import path from "node:path"
import { Effect } from "effect"
import { Global } from "../src/global"
import { FileLockRecovery } from "../src/file-lock-recovery"

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    apply: { type: "boolean", default: false },
    "owner-token": { type: "string" },
    "owner-sha256": { type: "string" },
  },
  strict: true,
})
if (!values.target)
  throw new Error("--target <exact absolute canonical target> is required; default is read-only inspection")
const global = await Effect.runPromise(Global.Service.pipe(Effect.provide(Global.layer)))
const input = { target: values.target, lockRoot: path.join(global.state, "locks") }
if (!values.apply) console.log(JSON.stringify(await FileLockRecovery.inspect(input), null, 2))
else {
  if (!values["owner-token"] || !values["owner-sha256"])
    throw new Error("Apply requires the exact inspected --owner-token and --owner-sha256")
  console.log(
    JSON.stringify(
      await FileLockRecovery.recover({
        ...input,
        ownerToken: values["owner-token"],
        ownerSha256: values["owner-sha256"],
      }),
      null,
      2,
    ),
  )
}
