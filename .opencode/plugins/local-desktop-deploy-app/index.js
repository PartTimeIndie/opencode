const ICON = new URL("./assets/deploy-icon.svg", import.meta.url).href
const STATUS_KEY = "lastDeploy"
const HANDOFF_TIMEOUT_MS = 30 * 1000
const COMPOSER_TOOLBAR_ORDER = 60
const ERROR_TAIL_LINES = 40
const ERROR_TAIL_CHARS = 6_000
const PREVIOUS_STATUS_LINES = 8
const PREVIOUS_STATUS_CHARS = 1_000
const DEPLOY_CHECKLIST = [
  "Checkliste:",
  "1. Externe CMD startet sofort und beendet OpenCode vollständig, bevor Build, Paketierung und Prüfung beginnen.",
  "2. Prod-Marker aus packages/desktop/out/.build-channel prüfen; ohne Marker kein Deploy.",
  "3. Bundle-Guard muss Bun.file, Bun.write, bun:-Imports und weitere Bun-only Runtime-APIs blockieren.",
  "4. Installation/ASAR erst nach vollständigem App-Ende und geprüftem Paket anfassen.",
  "5. Erfolgreicher Deploy meldet Prod-Marker, Backup-Pfad und deployte ASAR-Version.",
]

export default {
  id: "local-desktop-deploy-app",
  app(api) {
    api.toolbar.register({
      id: "deployLocalDesktop",
      defaultVisible: true,
      title: "Build and Deploy",
      tooltip: "Build, atomically deploy, verify, and restart the complete prod desktop app",
      placement: "composer",
      align: "right",
      order: COMPOSER_TOOLBAR_ORDER,
      icon: { src: ICON, alt: "Deploy", size: "large" },
      visible: (ctx) => Boolean(isOpencodeProject(ctx.directory) && isWindowsHost() && canRunHostCommand(api)),
      enabled: (ctx) => Boolean(isOpencodeProject(ctx.directory) && isWindowsHost() && canRunHostCommand(api)),
      run: async (ctx) => {
        if (!ctx.directory) return
        const startedAt = Date.now()
        try {
          const previous = (await currentDeployStatus(api, ctx.directory)) ?? api.kv?.get?.(STATUS_KEY, undefined)
          const resume = previous?.status === "ready" ? readyBuild(previous) : undefined
          if (previous?.status === "ready" && !resume) {
            throw new Error(
              "Prepared deployment metadata is incomplete. Inspect desktop:deploy status before retrying.",
            )
          }
          if (isInFlightDeployStatus(previous?.status)) {
            const result = await runHostScript(api, ctx.directory, conflictConsoleScript(), {
              title: "Opening deploy console",
              message: "Opening the visible console to review the existing deployment.",
              timeoutMs: HANDOFF_TIMEOUT_MS,
            })
            if (!commandSucceeded(result) || !commandOutput(result).includes("CANCELLATION_CONSOLE : started"))
              throw new Error(commandErrorMessage(result))
            return
          }
          if (
            !window.confirm(
              [
                resume
                  ? `Vorbereiteten Build ${resume.buildID} extern deployen?`
                  : "Neue OpenCode-Prod-Version extern bauen und deployen?",
                "",
                resume
                  ? "Das vorhandene unveränderliche Paket wird verwendet, nicht der aktuelle Quellcode. Es wird kein neuer Build gestartet."
                  : "Eine unabhängige CMD startet sofort und beendet OpenCode vollständig, bevor Build, Paketierung und Prüfung beginnen.",
                resume
                  ? "Für einen neuen Build zuerst desktop:deploy discard ausführen. Abbrechen behält das Paket."
                  : "OpenCode bleibt während des gesamten Builds geschlossen und startet erst nach geprüftem Deploy neu.",
                "Mit OK erteilst du ausdrücklich die Freigabe für sofortiges Schließen, nötigenfalls Force-Close und Neustart nach geprüftem Deploy.",
                "",
                ...DEPLOY_CHECKLIST,
                previousStatusLine(previous),
              ].join("\n"),
            )
          ) {
            return
          }

          saveDeployStatus(api, { status: "running", phase: "Handoff", startedAt, directory: ctx.directory })
          const handoffScript = resume ? launchScript(resume.buildID) : automaticScript()
          const handoffResult = await runHostScript(api, ctx.directory, handoffScript, {
            title: resume ? "Deploying prepared desktop package" : "Starting external build and deploy",
            message: resume
              ? "Handing the verified package to the detached deploy worker."
              : "Handing off to an independent console that closes OpenCode first.",
            timeoutMs: HANDOFF_TIMEOUT_MS,
          })
          const recoveredAutomaticStatus =
            !resume && commandSucceeded(handoffResult) && !hasAutomaticMarker(handoffResult)
              ? await reconcileAutomaticHandoff(api, ctx.directory, startedAt)
              : undefined
          const acknowledged = resume
            ? commandSucceeded(handoffResult) && hasLaunchMarker(handoffResult, resume.buildID)
            : commandSucceeded(handoffResult) &&
              (hasAutomaticMarker(handoffResult) || advancedAutomaticHandoffStatus(recoveredAutomaticStatus, startedAt))
          if (!acknowledged) {
            const failed = {
              ...handoffResult,
              output: `${commandOutput(handoffResult)}\n${resume ? "Detached deploy worker did not acknowledge STARTED." : "External automatic worker did not acknowledge handoff."}`,
            }
            const status = { ...deployStatus("failed", failed, ctx.directory), startedAt }
            status.message = commandErrorMessage(failed)
            if (resume) {
              status.buildID = resume.buildID
              status.stagePath = resume.stagePath
            }
            saveDeployStatus(api, status)
            throw new Error(status.message)
          }
          saveDeployStatus(api, {
            status: "restarting",
            phase: "Deploy",
            startedAt,
            finishedAt: Date.now(),
            directory: ctx.directory,
            message:
              "External automatic deploy started. OpenCode will close now; durable completion will be reconciled after restart.",
          })
        } catch (error) {
          const status = api.kv?.get?.(STATUS_KEY, undefined)
          const message = error instanceof Error ? error.message : String(error)
          if (status?.status !== "failed" || status.startedAt !== startedAt)
            saveDeployStatus(api, {
              status: "failed",
              phase: status?.phase ?? "Prepare",
              startedAt,
              finishedAt: Date.now(),
              directory: ctx.directory,
              message,
            })
          window.alert(
            [
              "Build and Deploy ist fehlgeschlagen.",
              "",
              message,
              "",
              "Die vollständigen Build- und Statusdetails bleiben für den nächsten Versuch erhalten.",
            ].join("\n"),
          )
          throw error
        }
      },
    })
  },
}

async function currentDeployStatus(api, directory) {
  const result = await api.host.command.run({
    command: "powershell.exe",
    arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64Utf16Le(statusScript())],
    directory,
  })
  if (!commandSucceeded(result)) throw new Error(commandErrorMessage(result))
  const status = durableStatus(commandOutput(result), directory)
  if (!status) return undefined
  saveDeployStatus(api, status)
  return status
}

async function reconcileAutomaticHandoff(api, directory, startedAt) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const status = await currentDeployStatus(api, directory)
      if (advancedAutomaticHandoffStatus(status, startedAt)) return status
    } catch {
      // The command's output may be incomplete; keep checking durable state until the handoff window closes.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export function advancedAutomaticHandoffStatus(status, startedAt) {
  return Boolean(
    status &&
      typeof status === "object" &&
      typeof status.runID === "string" &&
      /^auto-[A-Za-z0-9-]+$/.test(status.runID) &&
      typeof status.finishedAt === "number" &&
      status.finishedAt >= startedAt &&
      ["automatic-closing-app", "automatic-building", "automatic-deploying", "completed", "automatic-failed"].includes(
        status.status,
      ),
  )
}

async function runHostScript(api, directory, script, loading) {
  return api.ui.loading.with(loading, () =>
    api.host.command.run({
      command: "powershell.exe",
      arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64Utf16Le(script)],
      directory,
    }),
  )
}

export function previousStatusLine(status) {
  if (!status || typeof status !== "object") return ""
  const when =
    status.finishedAt || status.startedAt
      ? new Date(status.finishedAt || status.startedAt).toLocaleString()
      : "unknown time"
  const label = status.status || "unknown"
  const build = status.buildID ? `\nLetzter Build: ${status.buildID}` : ""
  const backup = status.backupPath ? `\nLetztes Backup: ${status.backupPath}` : ""
  const log = status.logPath ? `\nLetztes Log: ${status.logPath}` : ""
  const message = status.message
    ? `\nLetzte Meldung: ${outputTail(String(status.message), PREVIOUS_STATUS_LINES, PREVIOUS_STATUS_CHARS)}`
    : ""
  return `\nLetzter Deploy-Status: ${label} (${when})${build}${backup}${log}${message}\n`
}

export function deployStatus(status, result, directory) {
  const output = commandOutput(result)
  const tail = errorOutputTail(output)
  return {
    status,
    phase: deployPhase(output),
    finishedAt: Date.now(),
    directory,
    buildID: metadata(output, "READY") ?? metadata(output, "STARTED")?.match(/for\s+(\S+)$/)?.[1],
    sourceFingerprint: metadata(output, "SOURCE"),
    artifactSha256: metadata(output, "ARTIFACT"),
    stagePath: metadata(output, "STAGE"),
    prodMarker: metadata(output, "PROD"),
    logPath: metadata(output, "LOG"),
    output: tail,
    outputTruncated:
      tail.startsWith("[earlier output omitted]\n") ||
      output.split(/\r?\n/).filter((line) => line.trim()).length > ERROR_TAIL_LINES,
  }
}

export function preparedBuild(output) {
  const buildID = metadata(output, "READY")
  const sourceFingerprint = metadata(output, "SOURCE")
  const artifactSha256 = metadata(output, "ARTIFACT")
  const stagePath = metadata(output, "STAGE")
  const prodMarker = metadata(output, "PROD")
  const logPath = metadata(output, "LOG")
  if (!buildID || !sourceFingerprint || !artifactSha256 || !stagePath || !prodMarker || !logPath) return undefined
  return { buildID, sourceFingerprint, artifactSha256, stagePath, prodMarker, logPath }
}

export function preparedBuildStatus(status, startedAt) {
  if (status?.status !== "ready" || typeof status.finishedAt !== "number" || status.finishedAt < startedAt)
    return undefined
  return readyBuild(status)
}

function readyBuild(status) {
  const keys = ["buildID", "sourceFingerprint", "artifactSha256", "stagePath", "prodMarker", "logPath"]
  if (!keys.every((key) => typeof status[key] === "string" && status[key].trim())) return undefined
  if (!/^[A-Za-z0-9-]+$/.test(status.buildID)) return undefined
  return Object.fromEntries(keys.map((key) => [key, status[key]]))
}

export function durableStatus(output, directory) {
  const start = output.indexOf("{")
  const end = output.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  try {
    const status = JSON.parse(output.slice(start, end + 1))
    if (!status || typeof status !== "object" || typeof status.status !== "string") return undefined
    return {
      ...status,
      directory,
      finishedAt: Date.parse(status.updatedAt) || Date.now(),
      message: durableStatusMessage(status),
    }
  } catch {
    return undefined
  }
}

function durableStatusMessage(status) {
  if (status.error) return status.error
  if (status.status !== "completed") return undefined
  return [
    `Prod deploy completed for ${status.buildID ?? "unknown build"}.`,
    status.prodMarker ? `Prod marker: ${status.prodMarker}.` : undefined,
    status.backupPath ? `Backup: ${status.backupPath}.` : undefined,
    status.artifactSha256 ? `Deployed ASAR version: ${status.artifactSha256}.` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
}

function saveDeployStatus(api, status) {
  try {
    api.kv?.set?.(STATUS_KEY, status)
  } catch (error) {
    console.warn(
      "[local-desktop-deploy-app] status persistence failed",
      error instanceof Error ? error.message : String(error),
    )
  }
  console.info("[local-desktop-deploy-app] status", {
    status: status.status,
    phase: status.phase,
    buildID: status.buildID,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    directory: status.directory,
    backupPath: status.backupPath,
    logPath: status.logPath,
  })
}

function metadata(output, label) {
  if (typeof output !== "string") return undefined
  return output.match(new RegExp(`^${label}\\s*:\\s*(.+)$`, "m"))?.[1]?.trim()
}

export function isInFlightDeployStatus(status) {
  if (typeof status !== "string" || !status) return false
  if (
    [
      "automatic-completed",
      "automatic-failed",
      "automatic-cancelled",
      "completed",
      "failed",
      "deployed",
      "discarded",
      "ready",
    ].includes(status)
  )
    return false
  return (
    status.startsWith("automatic-") ||
    [
      "fingerprinting-source",
      "building",
      "packaging",
      "staging",
      "launching-worker",
      "worker-started",
      "closing-app",
      "deploying",
      "restarting",
      "running",
    ].includes(status)
  )
}

function isOpencodeProject(directory) {
  if (typeof directory !== "string") return false
  return /(^|[\\/])opencode$/i.test(directory.replace(/[\\/]+$/, ""))
}

function isWindowsHost() {
  return /windows|win32/i.test(`${navigator.platform} ${navigator.userAgent}`)
}

function canRunHostCommand(api) {
  return typeof api.host?.command?.run === "function"
}

export function prepareScript() {
  return deployCommandScript(["prepare"])
}

export function automaticScript() {
  return deployCommandScript(["automatic", "--approved-close", "--force-close-approved", "--restart"])
}

export function hasAutomaticMarker(result) {
  return /^AUTOMATIC\s*:\s*detached worker for auto-[A-Za-z0-9-]+\s*$/im.test(commandOutput(result))
}

export function launchScript(buildID) {
  if (!/^[A-Za-z0-9-]+$/.test(buildID)) throw new Error(`invalid desktop deploy build ID: ${buildID}`)
  return deployCommandScript([
    "launch",
    "--build-id",
    buildID,
    "--approved-close",
    "--force-close-approved",
    "--restart",
  ])
}

export function statusScript() {
  return deployCommandScript(["status"])
}

export function conflictConsoleScript() {
  return `
$ErrorActionPreference = "Stop"
try {
  $repo = (Get-Location).Path
  $candidateRepo = [IO.Path]::GetFullPath((Join-Path $repo ([IO.Path]::Combine("..", ".."))))
  if (Test-Path -LiteralPath (Join-Path $candidateRepo "packages/opencode/package.json") -PathType Leaf) { $repo = $candidateRepo }
  $script = Join-Path $repo "script/build-and-deploy.cmd"
  if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "CMD tool not found: $script" }
  Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /k ""' + $script + '""') -WorkingDirectory $repo -WindowStyle Normal
  [Console]::WriteLine("CANCELLATION_CONSOLE : started")
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`
}

function deployCommandScript(args) {
  return `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try {
  $repo = (Get-Location).Path
  $candidateRepo = [IO.Path]::GetFullPath((Join-Path $repo ([IO.Path]::Combine("..", ".."))))
  if (Test-Path -LiteralPath (Join-Path $candidateRepo "packages/opencode/package.json") -PathType Leaf) { $repo = $candidateRepo }
  $env:PATH = @(
    $env:PATH,
    [Environment]::GetEnvironmentVariable("Path", "User"),
    [Environment]::GetEnvironmentVariable("Path", "Machine")
  ) -join [IO.Path]::PathSeparator

  $bunUserBin = Join-Path $env:USERPROFILE ".bun\\bin"
  $bunInstallBin = if ($env:BUN_INSTALL) { Join-Path $env:BUN_INSTALL "bin" } else { $null }
  foreach ($candidateBin in @($bunUserBin, $bunInstallBin)) {
    if ($candidateBin -and (Test-Path -LiteralPath $candidateBin) -and (($env:PATH -split [IO.Path]::PathSeparator) -notcontains $candidateBin)) {
      $env:PATH = "$candidateBin$([IO.Path]::PathSeparator)$env:PATH"
    }
  }

  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $bun) { throw "bun was not found. Expected it on PATH or at $bunUserBin" }
  $opencodeDir = Join-Path $repo "packages/opencode"
  if (-not (Test-Path -LiteralPath $opencodeDir)) { throw "opencode package not found: $opencodeDir" }
  Set-Location -LiteralPath $opencodeDir
  $ErrorActionPreference = "Continue"
  & $bun.Source @("run", "desktop:deploy", ${args.map((value) => `"${value}"`).join(", ")}) 2>&1 | ForEach-Object { $_.ToString() }
  $deployExitCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($deployExitCode -ne 0) { exit $deployExitCode }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`
}

export function commandErrorMessage(result) {
  const output = commandOutput(result).trim()
  const status = commandStatus(result)
  const phase = deployPhase(output)
  const log = metadata(output, "LOG")
  if (output)
    return `${phase} failed (${status}). Last relevant output:\n${errorOutputTail(output)}${log ? `\nFull log: ${log}` : ""}`
  return `${phase} failed (${status})`
}

export function deployPhase(output) {
  if (/desktop:deploy (?:launch|automatic)|desktop-prod-deploy\.ts automatic|STARTED\s*:|AUTOMATIC\s*:|automatic-worker/i.test(output)) return "Deploy"
  return "Prepare"
}

export function hasLaunchMarker(result, buildID) {
  return commandOutput(result).includes(`STARTED : detached deploy worker for ${buildID}`)
}

function commandOutput(result) {
  const detail =
    result?.output || result?.message || result?.error || [result?.stdout, result?.stderr].filter(Boolean).join("\n")
  return typeof detail === "string" ? detail : detail ? String(detail) : ""
}

function errorOutputTail(output) {
  return outputTail(output, ERROR_TAIL_LINES, ERROR_TAIL_CHARS)
}

function outputTail(output, lines, chars) {
  const tail = output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n")
  if (tail.length <= chars) return tail
  return `[earlier output omitted]\n${tail.slice(-chars)}`
}

function commandSucceeded(result) {
  if (!result || typeof result !== "object") return false
  if (result.ok === true) return true
  if (result.success === true) return true
  return result.exitCode === 0
}

function commandStatus(result) {
  if (!result || typeof result !== "object") return "no command result"
  if (typeof result.exitCode === "number") return `exit code ${result.exitCode}`
  if (typeof result.status === "number") return `HTTP status ${result.status}`
  if (result.ok === false) return "command reported failure"
  if (result.success === false) return "command reported failure"
  return "unknown exit code"
}

function base64Utf16Le(value) {
  const bytes = new Uint8Array(value.length * 2)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
