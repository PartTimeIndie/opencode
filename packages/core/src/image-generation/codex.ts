export * as CodexImageGeneration from "./codex"

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { GenerateError, type Adapter, type Input, type Output } from "../image-generation"

export const adapter: Adapter = {
  generate: (input) =>
    Effect.tryPromise({
      try: (signal) => generate(input, signal),
      catch: (error) => new GenerateError({ message: sanitize(error instanceof Error ? error.message : String(error)) }),
    }),
}

export function codexArguments(options: { root: string; response: string; model?: string; prompt: string }) {
  return [
    "exec",
    "--ephemeral",
    // codex-cli >= 0.157 refuses to run outside a trusted git repo without this
    // flag; the throwaway workdir plus the workspace-write sandbox keep the
    // run isolated, so skipping the repo check is safe here.
    "--skip-git-repo-check",
    // Structured events are the only reliable way to attribute the generated
    // raster to THIS run: thread.started carries our thread_id, which scopes
    // the capability's artifact directory below generated_images/.
    "--json",
    "--color",
    "never",
    "--sandbox",
    "workspace-write",
    "--cd",
    options.root,
    "--output-last-message",
    options.response,
    ...(options.model ? ["--model", options.model] : []),
    options.prompt,
  ]
}

export function codexHome() {
  return process.env.CODEX_HOME?.trim() ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex")
}

/** Thread ids are opaque UUID-like tokens; anything else must never touch the filesystem. */
export function validThreadID(value: string | undefined): value is string {
  return !!value && /^[0-9a-fA-F][0-9a-fA-F-]{10,62}$/.test(value)
}

/**
 * Extract the thread id of THIS codex run from its structured event stream.
 * Only the first matching structured event wins; unparsable lines are skipped.
 */
export function threadIDFromEvents(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/)
  for (let index = 0; index < lines.length && index < 200; index++) {
    const line = lines[index].trim()
    if (!line.startsWith("{")) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id
    } catch {
      // Event streams can interleave non-JSON noise on some versions.
    }
  }
  return undefined
}

/**
 * The codex built-in image capability stores the raster under
 * `<CODEX_HOME>/generated_images/<thread-id>/` and the model only references a
 * path in its final message. Scope the lookup to THIS run's thread directory:
 * parallel user runs own their own directories, foreign or globally newest
 * images must never be returned, and nothing outside this directory is read.
 */
export async function runImageArtifacts(options: { homeDir?: string; threadID?: string; startedAt: number; limit?: number }) {
  if (!validThreadID(options.threadID)) return []
  const root = path.resolve(options.homeDir ?? codexHome(), "generated_images")
  // Junction/symlink-safe containment: the thread directory itself could be a
  // reparse point to anywhere on disk, so compare real paths instead of the
  // lexical join before touching any entry.
  const rootReal = await fs.realpath(root).catch(() => undefined)
  if (!rootReal) return []
  const sessionDir = path.join(root, options.threadID)
  const sessionReal = await fs.realpath(sessionDir).catch(() => undefined)
  if (!sessionReal) return []
  const contained = path.relative(rootReal, sessionReal)
  if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) return []
  const entries = await fs.readdir(sessionReal, { withFileTypes: true }).catch(() => [])
  const found: Array<{ file: string; mtimeMs: number }> = []
  for (const entry of entries) {
    // Never follow symlinks out of the run's own artifact directory.
    if (entry.isSymbolicLink()) continue
    if (!entry.isFile()) continue
    const full = path.join(sessionReal, entry.name)
    const stat = await fs.stat(full).catch(() => undefined)
    // Bounded reads: size is validated before any readFile, and empty or
    // oversized files are skipped outright.
    if (stat?.isFile() && stat.size > 0 && stat.size <= 9 * 1024 * 1024 && stat.mtimeMs >= options.startedAt - 2_000)
      found.push({ file: full, mtimeMs: stat.mtimeMs })
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, options.limit ?? 5).map((item) => item.file)
}

async function generate(input: Input, signal: AbortSignal): Promise<Output> {
  if (!input.prompt.trim()) throw new Error("Image prompt must not be empty")
  const root = path.join(os.tmpdir(), "opencode", "image-generation", crypto.randomUUID())
  const format = input.format ?? "png"
  const output = path.join(root, `image.${format}`)
  const response = path.join(root, "codex-response.txt")
  await fs.mkdir(root, { recursive: true })
  try {
    const codex = await resolveCodexCommand()
    const startedAt = Date.now()
    const result = await run(
      codex.command,
      [
        ...codex.prefixArgs,
        ...codexArguments({ root, response, model: input.model, prompt: [
          "Generate exactly one image with the Codex built-in image generation capability.",
          "Do not inspect files, environment variables, repositories, or network resources other than the image-generation capability.",
          "Do not create SVG, ASCII art, screenshots, placeholder drawings, or a programmatic local drawing.",
          `Save the final raster image exactly at ${output}.`,
          `Visual brief: ${input.prompt}`,
          `Requested size: ${input.size ?? "1024x1024"}.`,
          `Style: ${input.style ?? "auto"}.`,
          `Format: ${format}.`,
          "If image generation is unavailable, create no file and explain the failure briefly.",
        ].join("\n") }),
      ],
      (input.timeoutSeconds ?? 300) * 1_000,
      signal,
    )
    // A failed or aborted CLI run must fail closed: no artifact attribution at
    // all, so a concurrently generated foreign image can never be returned.
    const lookup = await collectRunImage({ exitCode: result.exitCode, stdout: result.stdout, output, runRoot: root, startedAt })
    let data = lookup?.data
    let mime = lookup?.mime
    if (!data || !mime) {
      const final = await fs.readFile(response, "utf8").catch(() => "")
      throw new Error(
        `Codex did not create a valid image (exit ${result.exitCode}). ${sanitize(final || result.stderr || result.stdout)}`,
      )
    }
    if (data.byteLength > 8 * 1024 * 1024) throw new Error("Generated image exceeds the 8 MiB attachment limit")
    return {
      data,
      mime,
      filename: `image.${mime === "image/jpeg" ? "jpg" : mime.slice("image/".length)}`,
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Reads one candidate image with reparse-point and size guards: the path must
 * be a regular file (lstat rejects symlinks/junctions), its size is validated
 * before any readFile, and when a containment root is given the file's real
 * path must stay inside it.
 */
async function readOwnImageFile(
  file: string,
  options: { root?: string },
): Promise<{ data: Uint8Array; mime: Output["mime"] } | undefined> {
  const lstat = await fs.lstat(file).catch(() => undefined)
  if (!lstat?.isFile()) return undefined
  if (lstat.size <= 0 || lstat.size > 9 * 1024 * 1024) return undefined
  if (options.root) {
    const rootReal = await fs.realpath(options.root).catch(() => undefined)
    const fileReal = await fs.realpath(file).catch(() => undefined)
    if (!rootReal || !fileReal) return undefined
    const contained = path.relative(rootReal, fileReal)
    if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) return undefined
  }
  const bytes = await fs.readFile(file).catch(() => undefined)
  const mime = bytes ? detect(bytes) : undefined
  return bytes && mime ? { data: bytes, mime } : undefined
}

/**
 * Success-only image resolution for one codex run: a non-zero exit never
 * returns an image, the requested file wins when the model actually wrote it,
 * and otherwise the run's own thread artifact (structured events -> thread_id
 * -> generated_images/<thread-id>/) is used. Everything else fails closed.
 */
export async function collectRunImage(options: {
  exitCode: number | null
  stdout: string
  output: string
  runRoot?: string
  startedAt: number
  homeDir?: string
}): Promise<{ data: Uint8Array; mime: Output["mime"] } | undefined> {
  if (options.exitCode !== 0) return undefined
  const direct = await readOwnImageFile(options.output, { root: options.runRoot })
  if (direct) return direct
  const threadID = threadIDFromEvents(options.stdout)
  for (const candidate of await runImageArtifacts({ threadID, startedAt: options.startedAt, homeDir: options.homeDir })) {
    const artifact = await readOwnImageFile(candidate, {})
    if (artifact) return artifact
  }
  return undefined
}

/**
 * A JS runtime is node or bun only. Electron hosts (e.g. the desktop
 * sidecar's utility process) expose process.execPath as the Electron binary;
 * spawning codex.js with it starts an empty second Electron instance that
 * exits 0 with no output, so it must never be used here.
 */
export function jsRuntimeFor(execPath: string, nodePath?: string): string | undefined {
  if (nodePath?.trim()) return nodePath
  const base = path.basename(execPath).toLowerCase()
  return base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe" ? execPath : undefined
}

/**
 * Pure selection for one where/which match. Native executables win without a
 * JS runtime; the npm shim (codex.js) requires a real node runtime and fails
 * with an honest error instead of spawning the host binary.
 */
export function codexEntryFor(
  executable: string,
  options: { hasCodexJs: boolean; execPath: string; nodePath?: string },
): { command: string; prefixArgs: string[] } {
  if (path.extname(executable).toLowerCase() === ".exe") return { command: executable, prefixArgs: [] }
  const script = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js")
  if (options.hasCodexJs) {
    const runtime = jsRuntimeFor(options.execPath, options.nodePath)
    if (!runtime)
      throw new Error(
        `Codex npm shim at ${executable} needs a real Node runtime, but process.execPath (${options.execPath}) is not a JS runtime and no node was found on PATH`,
      )
    return { command: runtime, prefixArgs: [script] }
  }
  if (/\.(cmd|bat)$/i.test(executable))
    return { command: process.env.ComSpec || "cmd.exe", prefixArgs: ["/d", "/s", "/c", executable] }
  return { command: executable, prefixArgs: [] }
}

export function codexCandidates(platform: string) {
  return platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"]
}

async function resolveNodeRuntime() {
  if (jsRuntimeFor(process.execPath)) return process.execPath
  const result = await run(
    process.platform === "win32" ? "where.exe" : "which",
    [process.platform === "win32" ? "node.exe" : "node"],
    10_000,
  ).catch(() => undefined)
  return result?.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
}

async function resolveCodexCommand() {
  const candidates = codexCandidates(process.platform)
  const matches = await Promise.all(
    candidates.map(async (candidate) => {
      const result = await run(process.platform === "win32" ? "where.exe" : "which", [candidate], 10_000).catch(
        () => undefined,
      )
      return result?.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean) ?? []
    }),
  )
  let lastFailure: Error | undefined
  for (const executable of matches.flat()) {
    const script = path.join(path.dirname(executable), "node_modules", "@openai", "codex", "bin", "codex.js")
    const hasCodexJs = await fs.access(script).then(() => true, () => false)
    try {
      const nodePath = hasCodexJs && !jsRuntimeFor(process.execPath) ? await resolveNodeRuntime() : undefined
      return codexEntryFor(executable, { hasCodexJs, execPath: process.execPath, nodePath })
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error(String(error))
    }
  }
  if (lastFailure) throw lastFailure
  throw new Error("Codex CLI was not found on PATH")
}

function run(command: string, args: string[], timeoutMs: number, signal?: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      cwd: os.tmpdir(),
      env: codexEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = () => {
      child.kill()
      fail(new Error("Codex image generation was aborted"))
    }
    const timeout = setTimeout(() => {
      child.kill()
      fail(new Error(`Codex image generation timed out after ${Math.round(timeoutMs / 1_000)} seconds`))
    }, timeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    child.stdout.on("data", (value) => stdout.push(Buffer.from(value)))
    child.stderr.on("data", (value) => stderr.push(Buffer.from(value)))
    child.once("error", fail)
    child.once("close", (exitCode) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode })
    })
  })
}

function codexEnvironment() {
  const keys = process.platform === "win32"
    ? ["APPDATA", "CODEX_HOME", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"]
    : ["CODEX_HOME", "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR"]
  return Object.fromEntries(
    [...keys, process.platform === "win32" ? "Path" : "PATH"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  )
}

function detect(data: Buffer): Output["mime"] | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png"
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
    return "image/webp"
}

function sanitize(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-openai-key]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer [redacted-token]")
    .trim()
    .slice(-4_000)
}
