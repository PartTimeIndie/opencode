import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

type TimelinePart = Record<string, unknown> & { id: string }
type TimelineMessage = {
  info: Record<string, unknown> & {
    id: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
  }
  parts: TimelinePart[]
}

type Input = {
  session: Record<string, unknown> & {
    id: string
    projectID: string
    directory: string
    slug: string
    title: string
    version: string
  }
  messages: TimelineMessage[]
}

type Page = { items: unknown[]; cursor?: string }

export type ArchiveInspection = {
  location: string
  revision: number
  sessionCount: number
  activeSessionCount: number
  shardPath: string
  shardBytes: number
  archivedMessageCount: number
  archivedLegacyMessageCount: number
}

export type ArchiveCatalogEntry = {
  sessionID: string
  projectID: string
  title: string
  directory: string
  sessionData?: Record<string, unknown>
  location: "active" | "archived"
  revision: number
  messageCount: number
  inputCount: number
  timeCreated: number
  timeLastModified: number
}

const worker = fileURLToPath(new URL("./real-session-archive.worker.ts", import.meta.url))

export async function createRealSessionArchive(input: Input) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-app-archive-"))
  const operations = new Set<Promise<unknown>>()
  let operationVersion = 0
  await writeFile(path.join(root, "input.json"), JSON.stringify(input))
  await invoke<ArchiveInspection>(root, "create")
  const track = <A>(operation: Promise<A>) => {
    operationVersion++
    operations.add(operation)
    return operation.finally(() => operations.delete(operation))
  }
  const waitForIdle = async () => {
    while (true) {
      const version = operationVersion
      await Promise.allSettled([...operations])
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (operations.size === 0 && operationVersion === version) return
    }
  }
  const dispose = async () => {
    await waitForIdle()
    await remove(root)
  }

  return {
    pageMessages: (sessionID: string, limit: number, before?: string) =>
      track(invoke<Page>(root, "page", sessionID, String(limit), before ?? "")),
    listCatalog: () => track(invoke<{ rows: ArchiveCatalogEntry[]; hasMore: boolean }>(root, "catalog")),
    inspect: () => track(invoke<ArchiveInspection>(root, "inspect", input.session.id)),
    waitForIdle,
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

function invoke<A>(root: string, command: string, ...args: string[]) {
  return new Promise<A>((resolve, reject) => {
    const child = spawn("bun", [worker, command, root, ...args], {
      cwd: path.dirname(worker),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      const result = resultFromWorkerOutput({
        command,
        code,
        output: Buffer.concat(stdout).toString("utf8"),
        errorOutput: Buffer.concat(stderr).toString("utf8"),
      })
      if (result.ok) resolve(result.value as A)
      else reject(result.error)
    })
  })
}

const RESULT_PREFIX = "__OPENCODE_ARCHIVE_RESULT__"

export function resultFromWorkerOutput(input: {
  command: string
  code: number | null
  output: string
  errorOutput: string
}): { ok: true; value: unknown } | { ok: false; error: Error } {
  const marker = input.output.split(/\r?\n/).findLast((line) => line.startsWith(RESULT_PREFIX))
  if (input.code !== 0 || !marker) {
    return {
      ok: false,
      error: new Error(
        `Real archive worker ${input.command} failed (${input.code ?? "no exit"})\n${input.errorOutput}\n${input.output}`,
      ),
    }
  }
  const payload = marker.slice(RESULT_PREFIX.length)
  try {
    return { ok: true, value: JSON.parse(payload) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: new Error(
        `Real archive worker ${input.command} result was incomplete or unparsable (${input.output.length} bytes stdout, ${payload.length} char payload, exit ${input.code}): ${message}\n${outputPreview(input.output)}`,
      ),
    }
  }
}

function outputPreview(output: string) {
  return output.length <= 400 ? output : `${output.slice(0, 200)}…${output.slice(-200)}`
}

function remove(root: string, retries = 30): Promise<void> {
  return rm(root, { recursive: true, force: true }).catch(async (error) => {
    if (
      retries === 0 ||
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["EBUSY", "ENOTEMPTY", "EPERM"].includes(String(error.code))
    )
      throw error
    await new Promise((resolve) => setTimeout(resolve, 100))
    return remove(root, retries - 1)
  })
}
