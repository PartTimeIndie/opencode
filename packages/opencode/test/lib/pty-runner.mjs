import { spawn } from "@lydell/node-pty"

const [entry, ...args] = process.argv.slice(2)
const proc = spawn(process.env.OPENCODE_TEST_BUN, ["run", "--conditions=browser", entry, ...args], {
  name: "xterm-256color",
  cols: 120,
  rows: 30,
  cwd: process.env.OPENCODE_TEST_PTY_CWD,
  env: process.env,
})

let done = false
proc.onData((data) => process.stdout.write(data))
proc.onExit((event) => {
  done = true
  process.exit(event.exitCode === 0 ? 0 : 1)
})

process.stdin.on("data", (data) => {
  if (data.length === 1 && data[0] === 0) {
    if (!done) proc.kill()
    return
  }
  proc.write(data)
})
