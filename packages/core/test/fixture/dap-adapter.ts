import { Buffer } from "buffer"
import { appendFileSync } from "fs"

let buffered = Buffer.alloc(0)
let seq = 1

function send(message: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }))
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

function receive(message: Record<string, unknown>) {
  if (message.type !== "request" || typeof message.seq !== "number" || typeof message.command !== "string") return
  const args = typeof message.arguments === "object" && message.arguments !== null ? message.arguments : {}
  if (message.command === "disconnect" && process.argv[2])
    appendFileSync(process.argv[2], `${JSON.stringify(args)}\n`)
  if ((message.command === "launch" || message.command === "attach") && "fail" in args) {
    send({ type: "response", request_seq: message.seq, command: message.command, success: false, message: "start failed" })
    return
  }
  send({ type: "response", request_seq: message.seq, command: message.command, success: true, body: { command: message.command } })
  if (message.command === "configurationDone") send({ type: "event", event: "stopped", body: { threadId: 1 } })
  if (message.command === "disconnect") process.exit(0)
}

for await (const chunk of Bun.stdin.stream()) {
  buffered = Buffer.concat([buffered, Buffer.from(chunk)])
  while (true) {
    const headerEnd = buffered.indexOf("\r\n\r\n")
    if (headerEnd < 0) break
    const match = /Content-Length:\s*(\d+)/i.exec(buffered.subarray(0, headerEnd).toString())
    if (!match) process.exit(1)
    const length = Number(match[1])
    const bodyStart = headerEnd + 4
    if (buffered.length < bodyStart + length) break
    receive(JSON.parse(buffered.subarray(bodyStart, bodyStart + length).toString()) as Record<string, unknown>)
    buffered = buffered.subarray(bodyStart + length)
  }
}
