import whichPkg from "which"
import path from "path"
import { Global } from "../global"
import { executablePath } from "./windows-path"

export function which(cmd: string, env?: NodeJS.ProcessEnv) {
  const base = executablePath(env)
  const full = base ? base + path.delimiter + Global.Path.bin : Global.Path.bin
  const result = whichPkg.sync(cmd, {
    nothrow: true,
    path: full,
    pathExt: env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt,
  })
  return typeof result === "string" ? result : null
}
