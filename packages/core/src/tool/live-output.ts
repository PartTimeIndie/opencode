import { StringDecoder } from "node:string_decoder"

export const LIVE_OUTPUT_BYTES = 64 * 1024
export const LIVE_OUTPUT_INTERVAL_MS = 250

/** A bounded UTF-8 tail. Decoders retain incomplete codepoints across pipe chunks. */
export function liveOutput() {
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") }
  let text = ""
  let truncated = false
  let previous: "stdout" | "stderr" = "stdout"
  const append = (value: string) => {
    const bytes = Buffer.from(text + value)
    let start = Math.max(0, bytes.length - LIVE_OUTPUT_BYTES)
    if (start > 0) {
      truncated = true
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
    }
    text = bytes.subarray(start).toString("utf8")
  }
  return {
    push(stream: "stdout" | "stderr", chunk: Uint8Array) {
      const value = decoders[stream].write(Buffer.from(chunk))
      if (!value) return
      if (stream !== previous) append(`\n[${stream}]\n`)
      previous = stream
      append(value)
    },
    finish() {
      append(decoders.stdout.end())
      append(decoders.stderr.end())
    },
    snapshot: () => ({ output: text, truncated }),
  }
}
