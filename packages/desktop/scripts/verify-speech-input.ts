#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureForegroundWindow,
  insertForegroundText,
  type ForegroundWindowTarget,
} from "../src/main/windows-foreground-input"

if (!process.argv.includes("--insert")) {
  const captured = await captureForegroundWindow()
  if (!captured.ok) throw new Error(captured.error)
  console.log(`verified foreground capture for ${captured.target.application}`)
  process.exit(0)
}

const root = await mkdtemp(join(tmpdir(), "opencode-speech-input-"))
const script = join(root, "target.ps1")
const ready = join(root, "ready.txt")
const result = join(root, "result.txt")
const close = join(root, "close.txt")
const expected = "OpenCode speech service Unicode ✓ äöü 漢字"
await Bun.write(
  script,
  String.raw`param([string]$Ready, [string]$Result, [string]$Close)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'OpenCode Speech Input Smoke Target'
$form.Width = 640
$form.Height = 240
$form.StartPosition = 'CenterScreen'
$text = New-Object System.Windows.Forms.TextBox
$text.Multiline = $true
$text.Dock = 'Fill'
$text.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$form.Controls.Add($text)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 100
$timer.Add_Tick({
  if (-not [IO.File]::Exists($Close)) { return }
  [IO.File]::WriteAllText($Result, $text.Text, [Text.UTF8Encoding]::new($false))
  $timer.Stop()
  $form.Close()
})
$form.Add_Shown({
  $form.TopMost = $true
  $form.Activate()
  $text.Focus()
  $process = Get-Process -Id $PID
  $target = @{ handle = $form.Handle.ToInt64().ToString(); processID = [int]$PID; processStartedAt = $process.StartTime.ToUniversalTime().Ticks.ToString(); application = $process.ProcessName; bounds = @{ x = $form.Bounds.X; y = $form.Bounds.Y; width = $form.Bounds.Width; height = $form.Bounds.Height } }
  [IO.File]::WriteAllText($Ready, ($target | ConvertTo-Json -Compress -Depth 3), [Text.UTF8Encoding]::new($false))
  $timer.Start()
})
[System.Windows.Forms.Application]::Run($form)
`,
)

const powershell = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : "powershell.exe"
const child = Bun.spawn(
  [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", script, "-Ready", ready, "-Result", result, "-Close", close],
  { stdout: "pipe", stderr: "pipe", windowsHide: false },
)

try {
  await waitForFile(ready, 10_000)
  const target = (await Bun.file(ready).json()) as ForegroundWindowTarget
  if (target.processID !== child.pid) throw new Error("The controlled input target reported an unexpected process identity.")
  const inserted = await insertForegroundText(target, expected)
  if (!inserted.ok) throw new Error(inserted.error)
  await Bun.write(close, "close")
  await Promise.race([
    child.exited,
    Bun.sleep(5_000).then(() => {
      throw new Error("The controlled input target did not close.")
    }),
  ])
  if ((await child.exited) !== 0) throw new Error((await new Response(child.stderr).text()).trim() || "The controlled input target failed.")
  await waitForFile(result, 2_000)
  const actual = await Bun.file(result).text()
  if (actual !== expected) throw new Error(`The controlled input target received ${JSON.stringify(actual)} instead of the smoke-test text.`)
  console.log("verified controlled target activation and exact Unicode insertion")
} finally {
  if (child.exitCode === null) child.kill()
  await rm(root, { recursive: true, force: true })
}

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${path}.`)
}
