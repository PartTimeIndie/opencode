import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { PassThrough } from "node:stream"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureForegroundWindow,
  helperErrorMessage,
  helperScripts,
  insertForegroundText,
  runPowerShell,
  type ForegroundWindowTarget,
} from "./windows-foreground-input"

// The live suite drives the real PowerShell/C# helper against real top-level
// windows, so it steals the foreground for a few seconds and only runs when
// explicitly requested: OPENCODE_LIVE_INPUT_TEST=1 bun test src/main/windows-foreground-input.test.ts
// Run this file in its own process (as scripts/test.ts does): the desktop
// services test replaces this module globally through mock.module.
const live = process.platform === "win32" && process.env.OPENCODE_LIVE_INPUT_TEST === "1"

// PowerShell 5.1 serializes its error stream as CLIXML once stderr is
// redirected; without decoding, the user only ever sees "#< CLIXML".
const clixml =
  '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">The original target window is no longer available._x000D__x000A_</S><S S="Error">    + CategoryInfo          : OperationStopped: (The original target window is no longer available.:String) [], RemoteException</S><S S="Error">    + FullyQualifiedErrorId : The original target window is no longer available.</S></Objs>'

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: { end() {} },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true
      return true
    },
  })
  return child as unknown as ChildProcessWithoutNullStreams
}

describe("Windows input helper diagnostics", () => {
  test("turns CLIXML stderr into the readable PowerShell error", () => {
    expect(helperErrorMessage(clixml, "fallback")).toBe("The original target window is no longer available.")
  })

  test("unescapes XML entities and keeps every message line", () => {
    const stderr =
      '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Add-Type : Cannot compile &lt;foo&gt; &amp; &quot;bar&quot;_x000D__x000A_second line</S></Objs>'
    expect(helperErrorMessage(stderr, "fallback")).toBe('Add-Type : Cannot compile <foo> & "bar"\nsecond line')
  })

  test("passes plain stderr through trimmed without PowerShell position noise", () => {
    const stderr = [
      "  The Windows input helper is broken.  ",
      "At C:\\helper.ps1:3 char:1",
      "+     throw 'The Windows input helper is broken.'",
      "    + CategoryInfo          : OperationStopped: (The Windows input helper is broken.:String) [], RemoteException",
      "    + FullyQualifiedErrorId : The Windows input helper is broken.",
    ].join("\r\n")
    expect(helperErrorMessage(stderr, "fallback")).toBe("The Windows input helper is broken.")
  })

  test("falls back when stderr carries no readable message", () => {
    expect(helperErrorMessage("", "fallback")).toBe("fallback")
    expect(helperErrorMessage("   \r\n", "fallback")).toBe("fallback")
    expect(
      helperErrorMessage(
        '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" /></Objs>',
        "fallback",
      ),
    ).toBe("fallback")
  })

  test("helper scripts emit structured JSON failures instead of CLIXML stderr", () => {
    for (const [name, script] of Object.entries(helperScripts)) {
      const guarded = script.indexOf("try {")
      const success = script.indexOf("@{ ok = $true")
      expect(guarded, `${name} script has a guarded body`).toBeGreaterThan(0)
      expect(success, `${name} script reports success inside the guard`).toBeGreaterThan(guarded)
      expect(script.indexOf("throw '"), `${name} script throws inside the guard`).toBeGreaterThan(guarded)
      expect(script).toMatch(/catch \{\r?\n\s*@\{ ok = \$false; error = \$_\.Exception\.Message \} \| ConvertTo-Json -Compress/)
    }
  })

  test("runPowerShell waits for stdio to end before resolving", async () => {
    const child = fakeChild()
    const pending = runPowerShell("script", undefined, undefined, () => child)
    child.stdout.write('{"ok":tr')
    child.emit("exit", 0)
    let settled = false
    void pending.then(() => (settled = true))
    await Bun.sleep(10)
    expect(settled).toBe(false)
    child.stdout.write("ue}\n")
    child.emit("close", 0)
    expect(await pending).toEqual({ ok: true, stdout: '{"ok":true}\n', stderr: "" })
  })

  test("runPowerShell reports failed exits with readable stderr and keeps the output cap", async () => {
    const failed = fakeChild()
    const failure = runPowerShell("script", undefined, undefined, () => failed)
    failed.stderr.write(clixml)
    failed.emit("close", 1)
    expect(await failure).toEqual({ ok: false, error: "The original target window is no longer available." })

    const silent = fakeChild()
    const exited = runPowerShell("script", undefined, undefined, () => silent)
    silent.emit("close", 3)
    expect(await exited).toEqual({ ok: false, error: "The Windows input helper exited with code 3." })

    const oversized = fakeChild()
    const capped = runPowerShell("script", undefined, undefined, () => oversized)
    oversized.stdout.write("x".repeat(70 * 1024))
    oversized.emit("close", 0)
    expect(await capped).toEqual({ ok: false, error: "The Windows input helper returned too much output." })
  })
})

type HostStatus = {
  last?: string
  handleA: number
  handleB: number
  foreground: number
  foregroundPid: number
  textA: string
  textB: string
  pid: number
  startedAt: string
  application: string
  bounds: { x: number; y: number; width: number; height: number }
  error?: string
}

// A WinForms host with two independent top-level windows. Form A is the
// dictation target; form B exists only to cover A inside the same process. On
// request the host also starts a second process with window C, which becomes
// the foreground window of a foreign process. The host polls a command file
// and republishes its window state, so the test never needs its own Win32
// access.
const coverScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InputTestCoverNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$script:report = [string]([Console]::In.ReadToEnd() | ConvertFrom-Json).report
$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'OpenCode input test C'
$script:form.StartPosition = 'Manual'
$script:form.Location = New-Object System.Drawing.Point(260, 320)
$script:form.ClientSize = New-Object System.Drawing.Size(340, 110)
$script:box = New-Object System.Windows.Forms.TextBox
$script:box.Multiline = $true
$script:box.Bounds = New-Object System.Drawing.Rectangle(8, 8, 324, 94)
$script:form.Controls.Add($script:box)
$script:form.Add_Shown({
  [void][InputTestCoverNative]::ShowWindow($script:form.Handle, 5)
  [void][InputTestCoverNative]::SetForegroundWindow($script:form.Handle)
  [IO.File]::WriteAllText($script:report, (@{ handle = $script:form.Handle.ToInt64(); pid = $PID } | ConvertTo-Json -Compress))
})
[System.Windows.Forms.Application]::Run($script:form)
`

const hostScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InputTestNative {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processID);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
}
'@
$script:config = [Console]::In.ReadToEnd() | ConvertFrom-Json
$script:commandFile = [string]$script:config.command
$script:statusFile = [string]$script:config.status
$script:coverScript = [string]$script:config.coverScript
$script:coverReport = [string]$script:config.coverReport
$script:cover = $null
$script:last = ''
$script:formA = New-Object System.Windows.Forms.Form
$script:formA.Text = 'OpenCode input test A'
$script:formA.StartPosition = 'Manual'
$script:formA.Location = New-Object System.Drawing.Point(60, 60)
$script:formA.ClientSize = New-Object System.Drawing.Size(340, 110)
$script:boxA = New-Object System.Windows.Forms.TextBox
$script:boxA.Multiline = $true
$script:boxA.Bounds = New-Object System.Drawing.Rectangle(8, 8, 324, 94)
$script:formA.Controls.Add($script:boxA)
$script:formB = New-Object System.Windows.Forms.Form
$script:formB.Text = 'OpenCode input test B'
$script:formB.StartPosition = 'Manual'
$script:formB.Location = New-Object System.Drawing.Point(460, 60)
$script:formB.ClientSize = New-Object System.Drawing.Size(340, 110)
$script:boxB = New-Object System.Windows.Forms.TextBox
$script:boxB.Multiline = $true
$script:boxB.Bounds = New-Object System.Drawing.Rectangle(8, 8, 324, 94)
$script:formB.Controls.Add($script:boxB)
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 40
$script:timer.Add_Tick({
  try {
    $command = if ([IO.File]::Exists($script:commandFile)) { [IO.File]::ReadAllText($script:commandFile).Trim() } else { '' }
    if ($command -and $command -ne $script:last) {
      $script:last = $command
      switch -Regex ($command) {
        '^clearA' { $script:boxA.Clear() }
        '^minimizeA' { $script:formA.WindowState = [System.Windows.Forms.FormWindowState]::Minimized }
        '^restoreA' { $script:formA.WindowState = [System.Windows.Forms.FormWindowState]::Normal }
        '^coverA' { $script:formB.Show(); $script:formB.Activate() }
        '^hideB' { $script:formB.Hide() }
        '^coverForeign' {
          if ($script:cover -and -not $script:cover.HasExited) { $script:cover.Kill() }
          $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script:coverScript))
          $start = New-Object System.Diagnostics.ProcessStartInfo
          $start.FileName = Join-Path $PSHOME 'powershell.exe'
          $start.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded
          $start.UseShellExecute = $false
          $start.CreateNoWindow = $true
          $start.RedirectStandardInput = $true
          $script:cover = [System.Diagnostics.Process]::Start($start)
          $script:cover.StandardInput.Write((@{ report = $script:coverReport } | ConvertTo-Json -Compress))
          $script:cover.StandardInput.Close()
        }
        '^hideForeign' { if ($script:cover -and -not $script:cover.HasExited) { $script:cover.Kill() } }
        '^quit' {
          $script:timer.Stop()
          if ($script:cover -and -not $script:cover.HasExited) { $script:cover.Kill() }
          [System.Windows.Forms.Application]::Exit()
        }
      }
    }
    $bounds = New-Object InputTestNative+Rect
    [void][InputTestNative]::GetWindowRect($script:formA.Handle, [ref]$bounds)
    $foregroundProcess = [uint32]0
    $foreground = [InputTestNative]::GetForegroundWindow()
    [void][InputTestNative]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
    $process = [System.Diagnostics.Process]::GetCurrentProcess()
    $status = @{
      last = $script:last
      handleA = $script:formA.Handle.ToInt64()
      handleB = $(if ($script:formB.IsHandleCreated) { $script:formB.Handle.ToInt64() } else { 0 })
      foreground = $foreground.ToInt64()
      foregroundPid = [int]$foregroundProcess
      textA = $script:boxA.Text
      textB = $script:boxB.Text
      pid = $PID
      startedAt = $process.StartTime.ToUniversalTime().Ticks.ToString()
      application = $process.ProcessName
      bounds = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top }
    }
    [IO.File]::WriteAllText($script:statusFile, ($status | ConvertTo-Json -Compress))
  } catch {
    [IO.File]::WriteAllText($script:statusFile, (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
})
$script:formA.Add_Shown({ $script:timer.Start(); [Console]::Out.WriteLine('{"type":"ready"}'); [Console]::Out.Flush() })
[System.Windows.Forms.Application]::Run($script:formA)
`

describe.skipIf(!live)("live Windows foreground input helper", () => {
  let directory: string
  let host: ChildProcessWithoutNullStreams | undefined
  let commandFile: string
  let statusFile: string
  let status: HostStatus = { handleA: 0, handleB: 0, foreground: 0, foregroundPid: 0, textA: "", textB: "", pid: 0, startedAt: "", application: "", bounds: { x: 0, y: 0, width: 0, height: 0 } }
  let target: ForegroundWindowTarget

  const read = () => {
    if (!existsSync(statusFile)) return
    try {
      const value = JSON.parse(readFileSync(statusFile, "utf8")) as HostStatus
      if (value.error) throw new Error(`test host failed: ${value.error}`)
      status = value
    } catch (error) {
      if (error instanceof SyntaxError) return
      throw error
    }
  }
  const wait = async (condition: () => unknown, label: string, timeout = 10_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      read()
      if (condition()) return status
      await Bun.sleep(40)
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(status)}`)
  }
  const command = async (value: string) => {
    writeFileSync(commandFile, value)
    return wait(() => status.last === value, value)
  }
  const insert = (text: string) => insertForegroundText(target, text)

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "opencode-input-test-"))
    commandFile = join(directory, "command")
    statusFile = join(directory, "status")
    rmSync(statusFile, { force: true })
    const executable = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    host = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(hostScript, "utf16le").toString("base64")], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    host.stderr.resume()
    host.stdin.end(JSON.stringify({ command: commandFile, status: statusFile, coverScript, coverReport: join(directory, "cover") }))
    const ready = await wait(() => status.handleA > 0 && status.textA === "", "test windows")
    target = {
      handle: String(ready.handleA),
      processID: ready.pid,
      processStartedAt: ready.startedAt,
      application: ready.application,
      bounds: ready.bounds,
    }
  }, 30_000)

  afterAll(() => {
    try {
      writeFileSync(commandFile, `quit-${Date.now()}`)
    } catch {}
    host?.kill()
    rmSync(directory, { recursive: true, force: true })
  })

  test("captures a valid foreground target", async () => {
    const captured = await captureForegroundWindow()
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    expect(captured.target.handle).toMatch(/^\d+$/)
    expect(captured.target.processID).toBeGreaterThan(0)
    console.info(`[live-input] foreground=${status.foreground} handleA=${status.handleA} foregroundPid=${status.foregroundPid} hostPid=${status.pid}`)
    // Only comparable while the test window itself is the foreground window.
    if (status.foreground === status.handleA) expect(captured.target.processID).toBe(status.pid)
  })

  test("inserts into a window that is covered by another window", async () => {
    await command("clearA")
    await command("coverA")
    expect(status.handleB).toBeGreaterThan(0)
    console.info(`[live-input] covered: foreground=${status.foreground} handleB=${status.handleB} foregroundPid=${status.foregroundPid} hostPid=${status.pid}`)
    const result = await insert("Covered insertion ü")
    expect(result).toEqual({ ok: true })
    const after = await wait(() => status.textA.includes("Covered insertion"), "covered text")
    expect(after.textA.trim()).toBe("Covered insertion ü")
    expect(after.textB).toBe("")
    expect(after.foreground).toBe(after.handleA)
  })

  test("inserts into a window while another process is in the foreground", async () => {
    await command("hideB")
    await command("clearA")
    await command("coverForeign")
    const coverReport = join(directory, "cover")
    await wait(() => existsSync(coverReport), "foreign window report")
    const cover = JSON.parse(readFileSync(coverReport, "utf8")) as { handle: number; pid: number }
    const foreign = await wait(() => status.foreground === cover.handle, `foreign foreground window ${cover.handle}`)
    expect(foreign.foregroundPid).toBe(cover.pid)
    expect(foreign.foregroundPid).not.toBe(foreign.pid)
    console.info(`[live-input] foreign: foreground=${foreign.foreground} foregroundPid=${foreign.foregroundPid} hostPid=${foreign.pid}`)
    const result = await insert("Foreign insertion ü")
    expect(result).toEqual({ ok: true })
    const after = await wait(() => status.textA.includes("Foreign insertion"), "foreign text")
    expect(after.textA.trim()).toBe("Foreign insertion ü")
    expect(after.foreground).toBe(after.handleA)
    await command("hideForeign")
  })

  test("inserts into a minimized window", async () => {
    await command("hideB")
    await command("hideForeign")
    await command("clearA")
    const minimized = await command("minimizeA")
    expect(minimized.bounds.x).toBeLessThan(0)
    const result = await insert("Minimized insertion")
    expect(result).toEqual({ ok: true })
    const after = await wait(() => status.textA.includes("Minimized insertion"), "minimized text")
    expect(after.textA.trim()).toBe("Minimized insertion")
    expect(after.foreground).toBe(after.handleA)
  })

  test("rejects a target whose process identity changed without typing", async () => {
    await command("clearA")
    const result = await insertForegroundText({ ...target, processStartedAt: `${BigInt(target.processStartedAt) + 1n}` }, "Must not appear")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("identity changed")
    await Bun.sleep(300)
    read()
    expect(status.textA).toBe("")
  })
})
