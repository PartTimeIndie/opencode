import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createDoubleTapMatcher } from "./double-tap-matcher"
import { doubleTapNativeSource } from "./windows-double-tap-native"

type Result = { ok: true } | { ok: false; error: string }

export function createWindowsDoubleTapObserver(input: {
  key: number
  modifiers: number
  onInvoke: () => void
  onFailure: (error: string) => void
  spawn?: () => ChildProcessWithoutNullStreams
}) {
  const match = createDoubleTapMatcher()
  let stopped = false
  let started = false
  let buffer = ""
  let child: ChildProcessWithoutNullStreams | undefined
  let resolveReady!: (result: Result) => void
  const ready = new Promise<Result>((resolve) => (resolveReady = resolve))
  const timer = setTimeout(() => fail("The Windows double-tap observer timed out during startup."), 10_000)
  timer.unref()

  function stop() {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    match({ type: "reset" })
    child?.kill()
    resolveReady({ ok: false, error: "The Windows double-tap observer was stopped." })
  }

  function fail(error: string) {
    if (stopped) return
    resolveReady({ ok: false, error })
    stop()
    input.onFailure(error)
  }

  try {
    child = input.spawn ? input.spawn() : spawn(
      `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    child.once("error", () => fail("The Windows double-tap observer could not be started."))
    child.once("exit", () => fail("The Windows double-tap observer exited unexpectedly. Re-register the shortcut to retry."))
    child.stdin.on("error", () => fail("The Windows double-tap observer input pipe failed."))
    child.stdout.on("error", () => fail("The Windows double-tap observer output pipe failed."))
    child.stderr.on("error", () => fail("The Windows double-tap observer error pipe failed."))
    // Never forward native output or keyboard details to logs.
    child.stderr.resume()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (stopped) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > 8192) return fail("The Windows double-tap observer exceeded its output limit.")
      while (buffer.includes("\n") && !stopped) {
        const index = buffer.indexOf("\n")
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        let event: unknown
        try {
          event = JSON.parse(line)
        } catch {
          return fail("The Windows double-tap observer returned an invalid event.")
        }
        if (!event || typeof event !== "object") return fail("The Windows double-tap observer returned an invalid event.")
        const value = event as Record<string, unknown>
        if (value.type === "ready" && !started) {
          started = true
          clearTimeout(timer)
          resolveReady({ ok: true })
          continue
        }
        if (started && value.type === "reset") {
          match({ type: "reset" })
          continue
        }
        if (started && value.type === "tap" && typeof value.time === "number" && Number.isSafeInteger(value.time) && value.time >= 0 && typeof value.window === "string" && /^\d{1,20}$/.test(value.window)) {
          if (match({ type: "tap", time: value.time, window: value.window })) input.onInvoke()
          continue
        }
        return fail("The Windows double-tap observer returned an invalid event.")
      }
    })
    child.stdin.end(JSON.stringify({ key: input.key, modifiers: input.modifiers, parent: process.pid }))
  } catch {
    fail("The Windows double-tap observer could not be started.")
  }
  return { ready, stop }
}

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${doubleTapNativeSource}
'@
$config = [Console]::In.ReadToEnd() | ConvertFrom-Json
[OpenCodeDoubleTap]::Run([int]$config.key, [int]$config.modifiers, [int]$config.parent)
`
