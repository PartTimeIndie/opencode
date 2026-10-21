import { spawn } from "node:child_process"

const maximumOutputBytes = 64 * 1024
const operationTimeoutMs = 10_000

export type ForegroundWindowTarget = {
  handle: string
  processID: number
  processStartedAt: string
  application: string
  bounds: { x: number; y: number; width: number; height: number }
}

export async function captureForegroundWindow() {
  if (process.platform !== "win32") return { ok: false as const, error: "External text insertion is only available on Windows." }
  const result = await runPowerShell(captureScript)
  if (!result.ok) return result
  const value = await parseResult(result.stdout)
  if (!value || value.ok !== true || !validTarget(value.target)) {
    return { ok: false as const, error: result.stderr || "The foreground Windows application could not be identified." }
  }
  return { ok: true as const, target: value.target }
}

export async function insertForegroundText(target: ForegroundWindowTarget, text: string, signal?: AbortSignal) {
  if (process.platform !== "win32") return { ok: false as const, error: "External text insertion is only available on Windows." }
  if (!validTarget(target)) return { ok: false as const, error: "The captured target is invalid." }
  const result = await runPowerShell(insertScript, JSON.stringify({ target, text }), signal)
  if (!result.ok) return result
  const value = await parseResult(result.stdout)
  if (!value || value.ok !== true) {
    return {
      ok: false as const,
      error: typeof value?.error === "string" ? value.error : result.stderr || "Windows rejected the text insertion.",
    }
  }
  return { ok: true as const }
}

function validTarget(value: unknown): value is ForegroundWindowTarget {
  if (!value || typeof value !== "object") return false
  const target = value as Record<string, unknown>
  if (typeof target.handle !== "string" || !/^\d+$/.test(target.handle)) return false
  if (!Number.isSafeInteger(target.processID) || Number(target.processID) <= 0) return false
  if (typeof target.processStartedAt !== "string" || !/^\d+$/.test(target.processStartedAt)) return false
  if (typeof target.application !== "string" || !target.application.trim() || target.application.length > 256) return false
  if (!target.bounds || typeof target.bounds !== "object") return false
  const bounds = target.bounds as Record<string, unknown>
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return false
  return Number(bounds.width) > 0 && Number(bounds.height) > 0
}

function parseResult(value: string) {
  const line = value.trim().split(/\r?\n/).at(-1)
  if (!line) return
  return Promise.resolve()
    .then(() => JSON.parse(line) as Record<string, unknown>)
    .catch(() => undefined)
}

async function runPowerShell(script: string, input?: string, signal?: AbortSignal) {
  if (signal?.aborted) return { ok: false as const, error: "The Windows input helper was cancelled." }
  const executable = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe"
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  return new Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }>((resolve) => {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let oversized = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      child.kill()
      finish({ ok: false, error: "The Windows input helper was cancelled." })
    }
    const finish = (result: { ok: true; stdout: string; stderr: string } | { ok: false; error: string }) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      resolve(result)
    }
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString("utf8")
      if (Buffer.byteLength(next) <= maximumOutputBytes) return next
      oversized = true
      return next.slice(0, maximumOutputBytes)
    }
    child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)))
    child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)))
    child.once("error", (error) => finish({ ok: false, error: error.message }))
    timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: "The Windows input helper timed out." })
    }, operationTimeoutMs)
    child.once("exit", (code) => {
      if (oversized) return finish({ ok: false, error: "The Windows input helper returned too much output." })
      if (code !== 0) return finish({ ok: false, error: stderr.trim() || `The Windows input helper exited with code ${code}.` })
      finish({ ok: true, stdout, stderr })
    })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) return abort()
    child.stdin.end(input ?? "")
  })
}

const nativeTypes = String.raw`
using System;
using System.Runtime.InteropServices;

public static class OpenCodeDesktopInput {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X; public int Y; public uint MouseData; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort VirtualKey; public ushort Scan; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
  [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputUnion Union; }
  [StructLayout(LayoutKind.Sequential)] public struct TokenElevation { public int TokenIsElevated; }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError = true)] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processID);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processID);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int informationClass, out TokenElevation information, int length, out int returnLength);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, Input[] inputs, int size);

  public static int Elevation(uint processID) {
    var process = OpenProcess(0x1000, false, processID);
    if (process == IntPtr.Zero) return -1;
    try {
      IntPtr token;
      if (!OpenProcessToken(process, 0x0008, out token)) return -1;
      try {
        TokenElevation elevation;
        int returned;
        if (!GetTokenInformation(token, 20, out elevation, Marshal.SizeOf(typeof(TokenElevation)), out returned)) return -1;
        return elevation.TokenIsElevated == 0 ? 0 : 1;
      } finally {
        CloseHandle(token);
      }
    } finally {
      CloseHandle(process);
    }
  }

  public static bool Activate(IntPtr window) {
    if (IsIconic(window)) ShowWindow(window, 9);
    var foreground = GetForegroundWindow();
    uint foregroundProcess;
    var foregroundThread = GetWindowThreadProcessId(foreground, out foregroundProcess);
    var currentThread = GetCurrentThreadId();
    var attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
    try {
      BringWindowToTop(window);
      SetForegroundWindow(window);
    } finally {
      if (attached) AttachThreadInput(currentThread, foregroundThread, false);
    }
    return GetForegroundWindow() == window;
  }

  public static uint Insert(string value) {
    var normalized = value.Replace("\r\n", "\n").Replace("\n", "\r");
    var inputs = new Input[normalized.Length * 2];
    for (var index = 0; index < normalized.Length; index++) {
      inputs[index * 2].Type = 1;
      inputs[index * 2].Union.Keyboard.Scan = normalized[index];
      inputs[index * 2].Union.Keyboard.Flags = 0x0004;
      inputs[index * 2 + 1].Type = 1;
      inputs[index * 2 + 1].Union.Keyboard.Scan = normalized[index];
      inputs[index * 2 + 1].Union.Keyboard.Flags = 0x0004 | 0x0002;
    }
    return inputs.Length == 0 ? 0 : SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
  }
}
`

const captureScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${nativeTypes}
'@
$window = [OpenCodeDesktopInput]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero) { throw 'No foreground window is available.' }
$processID = [uint32]0
[void][OpenCodeDesktopInput]::GetWindowThreadProcessId($window, [ref]$processID)
$process = Get-Process -Id $processID -ErrorAction Stop
$bounds = New-Object OpenCodeDesktopInput+Rect
[void][OpenCodeDesktopInput]::GetWindowRect($window, [ref]$bounds)
@{ ok = $true; target = @{ handle = $window.ToInt64().ToString(); processID = [int]$processID; processStartedAt = $process.StartTime.ToUniversalTime().Ticks.ToString(); application = $process.ProcessName; bounds = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top } } } | ConvertTo-Json -Compress -Depth 4
`

const insertScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
${nativeTypes}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$window = [IntPtr]::new([int64]$request.target.handle)
if (-not [OpenCodeDesktopInput]::IsWindow($window)) { throw 'The original target window is no longer available.' }
$processID = [uint32]0
[void][OpenCodeDesktopInput]::GetWindowThreadProcessId($window, [ref]$processID)
if ([int]$processID -ne [int]$request.target.processID) { throw 'The original target window identity changed.' }
$process = Get-Process -Id $processID -ErrorAction Stop
if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$request.target.processStartedAt) { throw 'The original target process identity changed.' }
$targetElevation = [OpenCodeDesktopInput]::Elevation($processID)
$controllerElevation = [OpenCodeDesktopInput]::Elevation([uint32]$PID)
if ($targetElevation -lt 0 -or $controllerElevation -lt 0) { throw 'Windows could not verify the target application security level.' }
if ($targetElevation -gt $controllerElevation) { throw 'The original target is elevated and cannot safely receive text from OpenCode.' }
if (-not [OpenCodeDesktopInput]::Activate($window)) { throw 'Windows did not allow the original application to regain focus.' }
Start-Sleep -Milliseconds 80
if ([OpenCodeDesktopInput]::GetForegroundWindow() -ne $window) { throw 'The original application lost focus before text insertion.' }
$expected = ([string]$request.text).Length * 2
$inserted = [OpenCodeDesktopInput]::Insert([string]$request.text)
if ($inserted -ne $expected) { throw "Windows accepted $inserted of $expected keyboard events." }
@{ ok = $true } | ConvertTo-Json -Compress
`
