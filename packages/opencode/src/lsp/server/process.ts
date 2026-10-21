import fs from "fs/promises"
import { Process } from "@/util/process"

export const pathExists = async (p: string) =>
  fs
    .stat(p)
    .then(() => true)
    .catch(() => false)

export const run = (cmd: string[], opts: Process.RunOptions = {}) => Process.run(cmd, { ...opts, nothrow: true })

export const output = (cmd: string[], opts: Process.RunOptions = {}) => Process.text(cmd, { ...opts, nothrow: true })
