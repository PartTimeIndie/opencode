import { expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// These probes verify the Windows inheritance boundary the desktop Primary
// depends on: a kill-on-close scheduler job can only ever capture processes
// directly parented inside it, while broker-mediated launches (the mechanism a
// protocol handoff triggers through the shell) and the single-instance warm
// handoff stay outside scheduler ownership. Everything runs on an isolated
// Electron fixture with recorded PIDs; no global OS protocol is registered, no
// real OpenCode process is touched. The true opencode:// protocol activation on
// the installed app remains an explicitly open gate for deployed-app QA.
setDefaultTimeout(150_000)

const electronExe = join(import.meta.dir, "..", "..", "node_modules", "electron", "dist", "electron.exe")
const electronAvailable = process.platform === "win32" && existsSync(electronExe)

// Mirrors the scheduler runner's kill-on-close job flags (KillOnJobClose only).
// The production C# class lives in the opencode-scheduler plugin and is pinned
// by its own tests; this standalone copy exists so the desktop fixture does not
// depend on another checkout's layout.
const jobProbeSource = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OpencodeDesktopJobProbe {
  private const uint KillOnJobClose = 0x00002000;
  private const int ExtendedLimitInformation = 9;

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimitInformation {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimit {
    public BasicLimitInformation BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint informationLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  public static IntPtr CreateKillOnClose() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var information = new ExtendedLimit();
    information.BasicLimitInformation.LimitFlags = KillOnJobClose;
    var length = Marshal.SizeOf(typeof(ExtendedLimit));
    var pointer = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(information, pointer, false);
      if (SetInformationJobObject(job, ExtendedLimitInformation, pointer, (uint)length)) return job;
      var error = Marshal.GetLastWin32Error();
      CloseHandle(job);
      throw new Win32Exception(error);
    } finally {
      Marshal.FreeHGlobal(pointer);
    }
  }

  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  public static void Close(IntPtr job) {
    if (job == IntPtr.Zero) return;
    if (!CloseHandle(job)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }

  public static bool ProcessIsInJob(int pid, IntPtr job) {
    var handle = OpenProcess(0x1000, false, pid);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      bool inJob;
      if (!IsProcessInJob(handle, job, out inJob)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return inJob;
    } finally {
      CloseHandle(handle);
    }
  }
}
`

interface FixtureState {
  role: "primary" | "second"
  pid: number
  ppid: number
  gotLock: boolean
}

function fixtureMainJs(paths: { state: string; exit: string; userData: string }) {
  return `
const { app } = require("electron")
const fs = require("fs")
const statePath = ${JSON.stringify(paths.state)}
const exitPath = ${JSON.stringify(paths.exit)}
app.disableHardwareAcceleration()
app.setPath("userData", ${JSON.stringify(paths.userData)})
const gotLock = app.requestSingleInstanceLock()
const record = (role) => {
  try {
    fs.writeFileSync(statePath, JSON.stringify({ role, pid: process.pid, ppid: process.ppid, gotLock }))
  } catch {}
}
if (!gotLock) {
  record("second")
  app.quit()
} else {
  record("primary")
  const startedAt = Date.now()
  const timer = setInterval(() => {
    try {
      if (fs.existsSync(exitPath) || Date.now() - startedAt > 150000) {
        clearInterval(timer)
        app.quit()
      }
    } catch {}
  }, 100)
}
`
}

async function createFixtureRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const fixtureDir = join(root, "fixture")
  const userData = join(fixtureDir, "userdata")
  const state = join(root, "fixture-state.json")
  const exit = join(root, "fixture-exit.txt")
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(join(fixtureDir, "package.json"), JSON.stringify({ name: "opencode-electron-primary-fixture", main: "main.js" }))
  await writeFile(join(fixtureDir, "main.js"), fixtureMainJs({ state, exit, userData }))
  return { root, fixtureDir, state, exit }
}

async function waitForState(state: string, timeoutMs: number, role?: "primary" | "second") {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await Bun.file(state).text()) as FixtureState
      // A second launch overwrites the shared state file; without a role filter
      // the caller could observe the previous instance's record.
      if (!role || parsed.role === role) return parsed
    } catch {}
    await Bun.sleep(250)
  }
  throw new Error(`electron fixture never reported${role ? ` role ${role}` : " readiness"}`)
}

function pidAlive(pid: number) {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`],
    { encoding: "utf8", windowsHide: true },
  ).trim()
  return output === "alive"
}

function stopExactPid(pid: number) {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], {
      windowsHide: true,
    })
  } catch {}
}

async function stopFixture(exit: string, pid: number) {
  try {
    await Bun.write(exit, "exit")
  } catch {}
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && pidAlive(pid)) await Bun.sleep(250)
  if (pidAlive(pid)) stopExactPid(pid)
}

async function runJobProbe(root: string, mode: "brokered" | "direct", fixtureDir: string, state: string, exit: string) {
  const innerScript = join(root, `inner-${mode}.ps1`)
  const electronArgument = `"${fixtureDir.replaceAll("'", "''")}"`
  const launchLines =
    mode === "brokered"
      ? [
          "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '\""
            + electronExe.replaceAll("'", "''")
            + "\" \""
            + fixtureDir.replaceAll("'", "''")
            + "\"' }",
          "if ($result.ReturnValue -ne 0) { throw \"brokered electron launch failed with $($result.ReturnValue)\" }",
        ]
      : [
          "$startInfo = [System.Diagnostics.ProcessStartInfo]::new()",
          `$startInfo.FileName = '${electronExe.replaceAll("'", "''")}'`,
          `$startInfo.Arguments = '${electronArgument.replaceAll("'", "''")}'`,
          "$startInfo.UseShellExecute = $false",
          "$startInfo.CreateNoWindow = $true",
          "$null = [System.Diagnostics.Process]::Start($startInfo)",
        ]
  await Bun.write(
    innerScript,
    [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      ...launchLines,
      "Start-Sleep -Seconds 120",
      "",
    ].join("\n"),
  )
  const probe = join(root, `job-probe-${mode}.ps1`)
  await Bun.write(
    probe,
    [
      "Set-StrictMode -Version Latest",
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -TypeDefinition @'",
      jobProbeSource.trim(),
      "'@",
      "function Test-PidAlive([int]$ProcessId) { try { $null = Get-Process -Id $ProcessId -ErrorAction Stop; $true } catch { $false } }",
      "$inner = Start-Process powershell.exe -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" + innerScript.replaceAll("'", "''") + "' -PassThru -WindowStyle Hidden",
      "$job = [OpencodeDesktopJobProbe]::CreateKillOnClose()",
      "[OpencodeDesktopJobProbe]::Assign($job, $inner.Handle)",
      "$jobClosed = $false",
      "$electronPid = 0",
      "try {",
      `  $deadline = [DateTime]::UtcNow.AddSeconds(60)`,
      `  while ($electronPid -eq 0 -and [DateTime]::UtcNow -lt $deadline) {`,
      `    if (Test-Path '${state.replaceAll("'", "''")}') {`,
      `      $electronPid = [int]([System.IO.File]::ReadAllText('${state.replaceAll("'", "''")}') | ConvertFrom-Json).pid`,
      "    } else { Start-Sleep -Milliseconds 250 }",
      "  }",
      "  if ($electronPid -eq 0) { throw 'electron fixture never reported readiness' }",
      "  Start-Sleep -Milliseconds 500",
      '  "ELECTRON_ALIVE_BEFORE_CLOSE=$(Test-PidAlive $electronPid)"',
      '  "ELECTRON_IN_JOB=$([OpencodeDesktopJobProbe]::ProcessIsInJob($electronPid, $job))"',
      "  [OpencodeDesktopJobProbe]::Close($job)",
      "  $jobClosed = $true",
      "  $deadline = [DateTime]::UtcNow.AddSeconds(20)",
      "  while (-not $inner.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }",
      "  Start-Sleep -Milliseconds 2000",
      // Measured BEFORE any cleanup touches the fixture PID.
      '  "LAUNCHER_DIED_ON_JOB_CLOSE=$($inner.HasExited)"',
      '  "ELECTRON_SURVIVED_JOB_CLOSE=$(Test-PidAlive $electronPid)"',
      "} finally {",
      `  try { [System.IO.File]::WriteAllText('${exit.replaceAll("'", "''")}', 'exit') } catch {}`,
      "  if ($electronPid -ne 0) {",
      "    $graceful = [DateTime]::UtcNow.AddSeconds(10)",
      "    while ((Test-PidAlive $electronPid) -and [DateTime]::UtcNow -lt $graceful) { Start-Sleep -Milliseconds 250 }",
      "    try { if (Test-PidAlive $electronPid) { Stop-Process -Id $electronPid -Force -ErrorAction SilentlyContinue } } catch {}",
      "  }",
      "  try { if (-not $inner.HasExited) { Stop-Process -Id $inner.Id -Force -ErrorAction SilentlyContinue } } catch {}",
      "  if (-not $jobClosed) { try { [OpencodeDesktopJobProbe]::Close($job) } catch {} }",
      "}",
      "",
    ].join("\n"),
  )
  return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe], {
    timeout: 120_000,
    encoding: "utf8",
    windowsHide: true,
  })
}

test.skipIf(!electronAvailable)(
  "broker-launched electron cold start stays outside a kill-on-close scheduler job",
  async () => {
    const root = await createFixtureRoot("opencode-electron-brokered-")
    try {
      const output = await runJobProbe(root.root, "brokered", root.fixtureDir, root.state, root.exit)
      expect(output).toContain("ELECTRON_ALIVE_BEFORE_CLOSE=True")
      expect(output).toContain("ELECTRON_IN_JOB=False")
      expect(output).toContain("LAUNCHER_DIED_ON_JOB_CLOSE=True")
      expect(output).toContain("ELECTRON_SURVIVED_JOB_CLOSE=True")
    } finally {
      await rm(root.root, { recursive: true, force: true })
    }
  },
)

test.skipIf(!electronAvailable)(
  "directly parented electron inherits the kill-on-close job and dies with it",
  async () => {
    const root = await createFixtureRoot("opencode-electron-direct-")
    try {
      const output = await runJobProbe(root.root, "direct", root.fixtureDir, root.state, root.exit)
      expect(output).toContain("ELECTRON_ALIVE_BEFORE_CLOSE=True")
      // Negative control: the fixture CAN detect job capture, so the brokered
      // survival above is a real inheritance boundary, not a blind spot.
      expect(output).toContain("ELECTRON_IN_JOB=True")
      expect(output).toContain("LAUNCHER_DIED_ON_JOB_CLOSE=True")
      expect(output).toContain("ELECTRON_SURVIVED_JOB_CLOSE=False")
    } finally {
      await rm(root.root, { recursive: true, force: true })
    }
  },
)

test.skipIf(!electronAvailable)(
  "a second electron instance exits through the single-instance lock while the primary stays alive",
  async () => {
    const root = await createFixtureRoot("opencode-electron-warm-")
    const primary = Bun.spawn([electronExe, root.fixtureDir], { stdout: "ignore", stderr: "ignore" })
    let second: ReturnType<typeof Bun.spawn> | undefined
    try {
      const primaryState = await waitForState(root.state, 60_000)
      expect(primaryState.role).toBe("primary")
      expect(primaryState.gotLock).toBe(true)
      expect(primaryState.pid).toBe(primary.pid)

      second = Bun.spawn([electronExe, root.fixtureDir], { stdout: "ignore", stderr: "ignore" })
      const secondState = await waitForState(root.state, 60_000, "second")
      expect(secondState.role).toBe("second")
      expect(secondState.gotLock).toBe(false)
      expect(await Promise.race([second.exited, Bun.sleep(30_000).then(() => "timeout")])).not.toBe("timeout")

      // Measured before cleanup: the warm handoff left the primary untouched.
      expect(pidAlive(primary.pid)).toBe(true)
    } finally {
      await stopFixture(root.exit, primary.pid)
      if (second) {
        await Promise.race([second.exited, Bun.sleep(10_000)])
        if (pidAlive(second.pid)) stopExactPid(second.pid)
      }
      await rm(root.root, { recursive: true, force: true })
    }
  },
)
