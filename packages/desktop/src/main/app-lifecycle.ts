import { readFileSync } from "node:fs"
import { join } from "node:path"
import { uptime } from "node:os"

export type LifecycleIdentity = { pid: number; ppid: number; bootId: string }

export type InstalledBuildIdentity =
  | { present: true; buildID: string; channel: string; sourceFingerprint: string; artifactSha256: string; manifestCreatedAt: string }
  | { present: false; manifestPath: string; reason: string }

let cachedIdentity: LifecycleIdentity | undefined

// Approximate boot-session id from process start offset vs OS uptime: every
// process on the same OS boot derives the same second-granular value, which is
// enough to correlate desktop restarts without privileged APIs. pid/ppid are
// constant for the process lifetime, so the whole record is cached.
export function lifecycleIdentity(): LifecycleIdentity {
  if (!cachedIdentity) {
    cachedIdentity = {
      pid: process.pid,
      ppid: process.ppid,
      bootId: String(Math.round((Date.now() - uptime() * 1000) / 1000)),
    }
  }
  return cachedIdentity
}

// Deep links may embed project directories or opaque payloads; lifecycle logs
// keep scheme + path for correlation and drop query/hash entirely.
export function redactDeepLink(url: string) {
  const boundary = url.search(/[?#]/)
  return boundary === -1 ? url : url.slice(0, boundary)
}

// Scheduled-job handoffs carry non-secret run identifiers that make app logs
// correlatable with scheduler logs; everything else in the query stays out.
export function deepLinkCorrelation(urls: readonly string[]) {
  return urls.map((url) => {
    const correlation: Record<string, unknown> = { url: redactDeepLink(url) }
    if (!URL.canParse(url)) return correlation
    const payload = new URL(url).searchParams.get("payload")
    if (!payload) return correlation
    try {
      const parsed: unknown = JSON.parse(payload)
      if (!parsed || typeof parsed !== "object") return correlation
      const record = parsed as Record<string, unknown>
      for (const key of ["scopeId", "slug", "runId"] as const) {
        if (typeof record[key] === "string") correlation[key] = record[key]
      }
    } catch {}
    return correlation
  })
}

export function relaunchRequestedRecord(reason: string) {
  return { reason, ...lifecycleIdentity() }
}

export function quitRequestedRecord(source: string) {
  return { source, ...lifecycleIdentity() }
}

// Reads the immutable build manifest the prod deploy writes next to the
// installed executable. Lifecycle logs must name the build that actually runs;
// the identity fields are either the real installed values or absent with the
// concrete reason. Dev and unpackaged runs get an honest absence record - a
// fingerprint is never synthesized just to make the log look complete.
export function installedBuildIdentity(appRoot: string): InstalledBuildIdentity {
  const manifestPath = join(appRoot, ".opencode-build-manifest.json")
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch (error) {
    return { present: false, manifestPath, reason: error instanceof Error ? error.message : String(error) }
  }
  if (!parsed || typeof parsed !== "object") return { present: false, manifestPath, reason: "manifest is not an object" }
  const manifest = parsed as Record<string, unknown>
  if (manifest.version !== 1) return { present: false, manifestPath, reason: "unsupported manifest version" }
  const buildID = typeof manifest.buildID === "string" ? manifest.buildID : undefined
  const channel = typeof manifest.channel === "string" ? manifest.channel : undefined
  const sourceFingerprint = typeof manifest.sourceFingerprint === "string" ? manifest.sourceFingerprint : undefined
  const artifactSha256 = typeof manifest.artifactSha256 === "string" ? manifest.artifactSha256 : undefined
  const manifestCreatedAt = typeof manifest.createdAt === "string" ? manifest.createdAt : undefined
  if (!buildID || !channel || !sourceFingerprint || !artifactSha256 || !manifestCreatedAt) {
    return { present: false, manifestPath, reason: "manifest is missing build identity fields" }
  }
  return { present: true, buildID, channel, sourceFingerprint, artifactSha256, manifestCreatedAt }
}
