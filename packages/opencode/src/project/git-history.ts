export * as GitHistory from "./git-history"

/**
 * Pure contracts and helpers for branch-filtered, paginated Git history.
 *
 * The Effect orchestration lives in `project/vcs.ts`; everything here is
 * deterministic and testable without spawning Git. The history page walk is
 * anchored: continuation cursors freeze immutable root OIDs, traversal mode,
 * page geometry and the shallow boundary so appended pages stay stable while
 * refs move.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const HISTORY_PAGE_LIMIT_MAX = 1000
export const HISTORY_BODY_PREVIEW_BYTES = 16 * 1024
export const HISTORY_SUBJECT_MAX_BYTES = 2 * 1024
export const HISTORY_IDENTITY_MAX_BYTES = 1024
export const HISTORY_OBJECT_KEEP_BYTES = 64 * 1024
export const HISTORY_MESSAGE_CHUNK_BYTES = 16 * 1024
export const HISTORY_CURSOR_MAX_BYTES = 1024 * 1024
export const HISTORY_BATCH_HEADER_MAX_BYTES = 512

export type HistorySelector = "all" | "head" | "branch"
export type HistoryRecovery = "refresh" | "retry" | "change-selection" | "none"
export type HistoryErrorCode =
  | "invalid_ref"
  | "invalid_cursor"
  | "history_unavailable"
  | "shallow_changed"
  | "output_limit"
  | "process_failed"

export type HistoryFailure = {
  code: HistoryErrorCode
  message: string
  recovery: HistoryRecovery
}

export type HistoryCursorPayload = {
  v: 1
  repo: string
  kind: "page" | "message"
  mode?: HistorySelector
  firstParent?: boolean
  roots?: string[]
  pageSize?: number
  offset?: number
  shallow?: string
  oid?: string
  byteOffset?: number
}

const FULL_OID = /^[0-9a-f]{40}$/

const integrityKey = () => randomBytes(32)
let processKey: Buffer | undefined
const key = () => {
  processKey ??= integrityKey()
  return processKey
}

export const historyFailure = (
  code: HistoryErrorCode,
  message: string,
  recovery?: HistoryRecovery,
): HistoryFailure => ({
  code,
  message,
  recovery:
    recovery ??
    (code === "invalid_cursor" || code === "shallow_changed" || code === "history_unavailable" || code === "output_limit"
      ? "refresh"
      : "retry"),
})

export const encodeHistoryCursor = (payload: HistoryCursorPayload): string | HistoryFailure => {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  if (body.length > HISTORY_CURSOR_MAX_BYTES) {
    return historyFailure("history_unavailable", "History cursor exceeds the supported size", "refresh")
  }
  const mac = createHmac("sha256", key()).update(body).digest()
  return `${body.toString("base64url")}.${mac.toString("base64url")}`
}

export type CursorDecode =
  | { ok: true; payload: HistoryCursorPayload }
  | { ok: false; failure: HistoryFailure }

export const decodeHistoryCursor = (
  token: string,
  expected: { repo: string; kind: "page" | "message" },
): CursorDecode => {
  if (typeof token !== "string" || token.length > HISTORY_CURSOR_MAX_BYTES * 2) {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor is invalid", "refresh") }
  }
  const dot = token.indexOf(".")
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor is malformed", "refresh") }
  }
  const bodyPart = token.slice(0, dot)
  const macPart = token.slice(dot + 1)
  let body: Buffer
  let mac: Buffer
  try {
    body = Buffer.from(bodyPart, "base64url")
    mac = Buffer.from(macPart, "base64url")
  } catch {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor is not decodable", "refresh") }
  }
  if (body.length === 0 || body.length > HISTORY_CURSOR_MAX_BYTES || mac.length !== 32) {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor has invalid length", "refresh") }
  }
  const expectedMac = createHmac("sha256", key()).update(body).digest()
  if (!timingSafeEqual(mac, expectedMac)) {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor failed integrity check", "refresh") }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString("utf8"))
  } catch {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor payload is not valid JSON", "refresh") }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor payload is malformed", "refresh") }
  }
  const payload = parsed as Record<string, unknown>
  if (payload.v !== 1 || payload.repo !== expected.repo || payload.kind !== expected.kind) {
    return { ok: false, failure: historyFailure("invalid_cursor", "History cursor does not match this view", "refresh") }
  }
  if (expected.kind === "page") {
    if (
      payload.mode !== "all" &&
      payload.mode !== "head" &&
      payload.mode !== "branch"
    ) {
      return { ok: false, failure: historyFailure("invalid_cursor", "History cursor mode is invalid", "refresh") }
    }
    if (
      typeof payload.firstParent !== "boolean" ||
      typeof payload.pageSize !== "number" ||
      !Number.isInteger(payload.pageSize) ||
      payload.pageSize < 1 ||
      payload.pageSize > HISTORY_PAGE_LIMIT_MAX ||
      typeof payload.offset !== "number" ||
      !Number.isInteger(payload.offset) ||
      payload.offset < 0 ||
      typeof payload.shallow !== "string"
    ) {
      return { ok: false, failure: historyFailure("invalid_cursor", "History cursor geometry is invalid", "refresh") }
    }
    const roots = payload.roots
    if (!Array.isArray(roots) || roots.length === 0 || !roots.every((root) => typeof root === "string" && FULL_OID.test(root))) {
      return { ok: false, failure: historyFailure("invalid_cursor", "History cursor roots are invalid", "refresh") }
    }
  } else {
    if (typeof payload.oid !== "string" || !FULL_OID.test(payload.oid)) {
      return { ok: false, failure: historyFailure("invalid_cursor", "Commit text cursor is invalid", "refresh") }
    }
    if (typeof payload.byteOffset !== "number" || !Number.isInteger(payload.byteOffset) || payload.byteOffset < 0) {
      return { ok: false, failure: historyFailure("invalid_cursor", "Commit text offset is invalid", "refresh") }
    }
  }
  return { ok: true, payload: payload as unknown as HistoryCursorPayload }
}

const utf8SequenceLength = (byte: number): number => {
  if (byte < 0x80) return 1
  if (byte < 0xc0) return 0
  if (byte < 0xe0) return 2
  if (byte < 0xf0) return 3
  return 4
}

export const truncateUtf8Safe = (
  bytes: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } => {
  const safeEnd = maxBytes >= bytes.length ? bytes.length : utf8SafeByteCount(bytes.subarray(0, maxBytes))
  if (safeEnd >= bytes.length) return { text: bytes.toString("utf8"), truncated: false }
  return { text: bytes.subarray(0, safeEnd).toString("utf8"), truncated: true }
}

/**
 * Largest byte offset at a UTF-8 character boundary (for chunked reads).
 * A trailing lead byte or continuation run whose sequence extends beyond the
 * buffer is excluded so the withheld bytes can be re-read losslessly.
 */
export const utf8SafeByteCount = (bytes: Buffer): number => {
  const len = bytes.length
  if (len === 0) return 0
  const last = utf8SequenceLength(bytes[len - 1])
  if (last === 1) return len
  if (last > 1) return len - 1
  let start = len - 1
  while (start > 0 && utf8SequenceLength(bytes[start]) === 0) start--
  const lead = utf8SequenceLength(bytes[start])
  if (lead === 0) return 0
  return start + lead > len ? start : len
}

/**
 * Slice one char-safe chunk out of a byte range so consecutive chunks
 * concatenate losslessly: bytes that belong to a split multibyte character are
 * withheld and the caller resumes from the returned next offset.
 */
export const sliceMessageChunk = (
  bytes: Buffer,
  byteOffset: number,
  maxBytes = HISTORY_MESSAGE_CHUNK_BYTES,
): { text: string; truncated: boolean; nextOffset: number } => {
  if (byteOffset >= bytes.length) return { text: "", truncated: false, nextOffset: byteOffset }
  let end = Math.min(byteOffset + maxBytes, bytes.length)
  if (end < bytes.length) {
    while (end > byteOffset && utf8SequenceLength(bytes[end]) === 0) end--
  }
  return { text: bytes.subarray(byteOffset, end).toString("utf8"), truncated: end < bytes.length, nextOffset: end }
}

export const formatIsoStrict = (seconds: number, tz: string): string => {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(tz)
  const sign = match?.[1] === "-" ? -1 : 1
  const offsetMinutes = match ? sign * (Number(match[2]) * 60 + Number(match[3])) : 0
  const shifted = new Date((seconds + offsetMinutes * 60) * 1000)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  const tzLabel = match ? `${match[1]}${match[2]}:${match[3]}` : "+00:00"
  return `${date}T${time}${tzLabel}`
}

export const parsePersonLine = (
  line: string,
): { name: string; email: string; seconds: number; tz: string } | undefined => {
  const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(line)
  if (!match) return undefined
  return { name: match[1], email: match[2], seconds: Number(match[3]), tz: match[4] }
}

export type ParsedCommitObject = {
  parents: string[]
  author: { name: string; email: string; date: string } | undefined
  committer: { name: string; email: string; date: string } | undefined
  messageStart: number
  headerOverflow: boolean
}

/**
 * Byte-exact commit object header parser. Continuation header lines (for
 * example `gpgsig`) start with a space and are skipped. Message boundaries are
 * located by index so callers can window into the message without keeping the
 * whole object in memory.
 */
export const parseCommitObject = (bytes: Buffer, keepLimit = HISTORY_OBJECT_KEEP_BYTES): ParsedCommitObject => {
  let cursor = 0
  const parents: string[] = []
  let author: ParsedCommitObject["author"]
  let committer: ParsedCommitObject["committer"]
  let messageStart = -1
  let headerOverflow = false
  while (cursor < bytes.length) {
    const lineEnd = bytes.indexOf(0x0a, cursor)
    if (lineEnd === -1) {
      headerOverflow = true
      break
    }
    if (lineEnd === cursor) {
      messageStart = cursor + 1
      break
    }
    const line = bytes.subarray(cursor, lineEnd).toString("utf8")
    if (line.startsWith(" ")) {
      cursor = lineEnd + 1
      continue
    }
    if (line.startsWith("parent ")) {
      const parent = line.slice("parent ".length)
      if (FULL_OID.test(parent)) parents.push(parent)
    } else if (line.startsWith("author ")) {
      const parsed = parsePersonLine(line.slice("author ".length))
      if (parsed) {
        const { text } = truncateUtf8Safe(Buffer.from(parsed.name, "utf8"), HISTORY_IDENTITY_MAX_BYTES)
        const email = truncateUtf8Safe(Buffer.from(parsed.email, "utf8"), HISTORY_IDENTITY_MAX_BYTES).text
        author = { name: text, email, date: formatIsoStrict(parsed.seconds, parsed.tz) }
      }
    } else if (line.startsWith("committer ")) {
      const parsed = parsePersonLine(line.slice("committer ".length))
      if (parsed) {
        const { text } = truncateUtf8Safe(Buffer.from(parsed.name, "utf8"), HISTORY_IDENTITY_MAX_BYTES)
        const email = truncateUtf8Safe(Buffer.from(parsed.email, "utf8"), HISTORY_IDENTITY_MAX_BYTES).text
        committer = { name: text, email, date: formatIsoStrict(parsed.seconds, parsed.tz) }
      }
    }
    cursor = lineEnd + 1
    if (cursor > keepLimit) {
      headerOverflow = true
      break
    }
  }
  return {
    parents,
    author,
    committer,
    messageStart,
    headerOverflow: headerOverflow || (messageStart === -1 && bytes.length > keepLimit),
  }
}

export const splitCommitMessage = (
  bytes: Buffer,
  messageStart: number,
): { subject: string; bodyStart: number } => {
  const rest = bytes.subarray(messageStart)
  const paragraphEnd = rest.indexOf("\n\n")
  const subjectBytes = paragraphEnd === -1 ? rest : rest.subarray(0, paragraphEnd)
  const subject = truncateUtf8Safe(
    Buffer.from(subjectBytes.toString("utf8").replace(/\n/g, " ").trim(), "utf8"),
    HISTORY_SUBJECT_MAX_BYTES,
  ).text
  return { subject, bodyStart: paragraphEnd === -1 ? messageStart + rest.length : messageStart + paragraphEnd + 2 }
}

export type WalkRecord = {
  hash: string
  short: string
  logParents: string[]
  authorName: string
  authorEmail: string
  authorDate: string
}

const WALK_FIELD_COUNT = 6

export const parseWalkRecords = (text: string): { ok: true; records: WalkRecord[] } | { ok: false; failure: HistoryFailure } => {
  const records: WalkRecord[] = []
  for (const record of text.split("\x1e")) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const fields = trimmed.split("\x1f")
    if (fields.length !== WALK_FIELD_COUNT) {
      return {
        ok: false,
        failure: historyFailure("process_failed", "History record is malformed; refusing to guess commit boundaries", "retry"),
      }
    }
    const [hash, short, parentList, authorName, authorEmail, authorDate] = fields
    if (!FULL_OID.test(hash)) {
      return { ok: false, failure: historyFailure("process_failed", "History record has an invalid commit id", "retry") }
    }
    records.push({
      hash,
      short,
      logParents: parentList.split(" ").filter((item) => FULL_OID.test(item)),
      authorName,
      authorEmail,
      authorDate,
    })
  }
  return { ok: true, records }
}

export const buildWalkArgs = (input: { firstParent: boolean; offset: number; limit: number }): string[] => [
  "--no-replace-objects",
  "log",
  "--topo-order",
  "--no-decorate",
  ...(input.firstParent ? ["--first-parent"] : []),
  `--skip=${input.offset}`,
  `--max-count=${input.limit + 1}`,
  "--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%ad%x1e",
  "--stdin",
]

export const buildBatchArgs = (): string[] => ["--no-replace-objects", "cat-file", "--batch", "--buffer"]

export const buildBatchCheckArgs = (): string[] => ["--no-replace-objects", "cat-file", "--batch-check", "--buffer"]

export const buildRefListArgs = (): string[] =>
  ["--no-replace-objects", "for-each-ref", "--format=%(refname)%09%(symref)%09%(objectname)", "refs/heads", "refs/remotes"]

export const GIT_LAZY_FETCH_GUARD = { GIT_NO_LAZY_FETCH: "1" } as const

export type BatchObject = { oid: string; type: string; size: number; kept: Buffer }

type BatchParserState = {
  phase: "header" | "content" | "separator"
  header: Buffer
  oid: string
  type: string
  size: number
  kept: Buffer
  consumed: number
  objects: BatchObject[]
  failed: string | undefined
}

export const createBatchContentParser = (
  keepLimit = HISTORY_OBJECT_KEEP_BYTES,
): { feed: (chunk: Uint8Array) => void; objects: BatchObject[]; failed: string | undefined } => {
  const state: BatchParserState = {
    phase: "header",
    header: Buffer.alloc(0),
    oid: "",
    type: "",
    size: 0,
    kept: Buffer.alloc(0),
    consumed: 0,
    objects: [],
    failed: undefined,
  }
  const parseHeaderLine = (): void => {
    const line = state.header.toString("utf8")
    const missing = /^(\S+) missing$/.exec(line)
    if (missing) {
      state.failed = `git cat-file reported missing object ${missing[1]}`
      return
    }
    const match = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(line)
    if (!match) {
      state.failed = `git cat-file framing is invalid: ${JSON.stringify(line.slice(0, 80))}`
      return
    }
    state.oid = match[1]
    state.type = match[2]
    state.size = Number(match[3])
    state.kept = Buffer.alloc(0)
    state.consumed = 0
    state.phase = "content"
  }
  const finishObject = (): void => {
    state.objects.push({ oid: state.oid, type: state.type, size: state.size, kept: state.kept })
    state.header = Buffer.alloc(0)
    state.phase = "header"
  }
  const feed = (chunk: Uint8Array): void => {
    if (state.failed) return
    let view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    while (view.length > 0 && !state.failed) {
      if (state.phase === "header") {
        const lineEnd = view.indexOf(0x0a)
        if (lineEnd === -1) {
          state.header = Buffer.concat([state.header, view])
          if (state.header.length > HISTORY_BATCH_HEADER_MAX_BYTES) {
            state.failed = "git cat-file header line exceeds the supported length"
          }
          return
        }
        state.header = Buffer.concat([state.header, view.subarray(0, lineEnd)])
        view = view.subarray(lineEnd + 1)
        parseHeaderLine()
        continue
      }
      if (state.phase === "content") {
        const take = Math.min(state.size - state.consumed, view.length)
        const piece = view.subarray(0, take)
        if (state.kept.length < keepLimit) {
          const room = keepLimit - state.kept.length
          state.kept = Buffer.concat([state.kept, piece.subarray(0, Math.min(room, piece.length))])
        }
        state.consumed += take
        view = view.subarray(take)
        if (state.consumed === state.size) state.phase = "separator"
        continue
      }
      if (view[0] !== 0x0a) {
        state.failed = "git cat-file object terminator is missing"
        return
      }
      view = view.subarray(1)
      finishObject()
    }
  }
  return { feed, get objects() { return state.objects }, get failed() { return state.failed } }
}

export type BatchCheckEntry = { type: string; size: number } | "missing"

export const parseBatchCheck = (text: string): { ok: true; entries: Map<string, BatchCheckEntry> } | { ok: false; failure: HistoryFailure } => {
  const entries = new Map<string, BatchCheckEntry>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const missing = /^(\S+) missing$/.exec(trimmed)
    if (missing) {
      entries.set(missing[1], "missing")
      continue
    }
    const match = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(trimmed)
    if (!match) {
      return { ok: false, failure: historyFailure("process_failed", "git cat-file --batch-check framing is invalid", "retry") }
    }
    entries.set(match[1], { type: match[2], size: Number(match[3]) })
  }
  return { ok: true, entries }
}

/**
 * Single-pass windowed commit message reader: parses the batch header, locates
 * the commit header/message boundary, discards bytes before the requested
 * offset and keeps at most `maxBytes` bytes of the window. Enables complete
 * long commit texts through bounded repeated reads.
 */
export const createMessageWindowParser = (input: { byteOffset: number; maxBytes: number }) => {
  let state: "header" | "findmsg" | "window" | "sep" | "done" = "header"
  let buf = Buffer.alloc(0)
  // Absolute content offset of buf[0]; content offsets count bytes of the
  // current object after the batch header line.
  let bufStart = 0
  let oid = ""
  let type = ""
  let size = 0
  let messageStartAbs = -1
  let skip = input.byteOffset
  let collected = Buffer.alloc(0)
  let failed: string | undefined
  const feed = (chunk: Uint8Array): void => {
    if (failed || state === "done") return
    buf = Buffer.concat([buf, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)])
    for (;;) {
      if (failed || state === "done") return
      if (state === "header") {
        const lineEnd = buf.indexOf(0x0a)
        if (lineEnd === -1) {
          if (buf.length > HISTORY_BATCH_HEADER_MAX_BYTES) failed = "git cat-file header line exceeds the supported length"
          return
        }
        const line = buf.subarray(0, lineEnd).toString("utf8")
        buf = buf.subarray(lineEnd + 1)
        bufStart += lineEnd + 1
        if (/^\S+ missing$/.test(line)) {
          failed = `git cat-file reported missing object ${line.split(" ")[0]}`
          return
        }
        const match = /^([0-9a-f]{40}) ([a-z]+) (\d+)$/.exec(line)
        if (!match) {
          failed = `git cat-file framing is invalid: ${JSON.stringify(line.slice(0, 80))}`
          return
        }
        oid = match[1]
        type = match[2]
        size = Number(match[3])
        // Bytes before this point were the batch header line, not object
        // content: restart the content-relative offset at zero.
        bufStart = 0
        state = "findmsg"
        continue
      }
      if (state === "findmsg") {
        const blankIndex = buf.indexOf(Buffer.from("\n\n", "utf8"))
        if (blankIndex === -1) {
          if (buf.length > HISTORY_OBJECT_KEEP_BYTES) failed = "commit header exceeds the supported size"
          return
        }
        messageStartAbs = bufStart + blankIndex + 2
        const consumed = blankIndex + 2
        buf = buf.subarray(consumed)
        bufStart += consumed
        state = "window"
        continue
      }
      if (state === "window") {
        // bufStart is content-relative: bytes from bufStart to `size` are the
        // remaining object content; the message starts at messageStartAbs.
        const contentLeft = size - bufStart
        if (contentLeft <= 0) {
          state = "sep"
          continue
        }
        const take = Math.min(buf.length, contentLeft)
        if (take === 0) return
        const piece = buf.subarray(0, take)
        const skipInPiece = Math.min(Math.max(skip, 0), take)
        const collectSource = piece.subarray(skipInPiece)
        const want = Math.min(input.maxBytes - collected.length, collectSource.length)
        if (want > 0) collected = Buffer.concat([collected, collectSource.subarray(0, want)])
        skip -= skipInPiece + want
        if (skip < 0) skip = 0
        buf = buf.subarray(take)
        bufStart += take
        if (size - bufStart <= 0) state = "sep"
        continue
      }
      if (state === "sep") {
        if (buf.length === 0) return
        if (buf[0] !== 0x0a) {
          failed = "git cat-file object terminator is missing"
          return
        }
        buf = buf.subarray(1)
        bufStart += 1
        state = "done"
      }
    }
  }
  return {
    feed,
    get failed() {
      return failed
    },
    get oid() {
      return oid
    },
    get type() {
      return type
    },
    get collected() {
      return collected
    },
    get messageStartAbs() {
      return messageStartAbs
    },
    get size() {
      return size
    },
    get complete() {
      return state === "done"
    },
  }
}

export const computeShallowFingerprint = (content: string | undefined): string => {
  if (!content) return "none"
  return createHash("sha256").update(content, "utf8").digest("hex")
}

export type HistoryRequestInput = {
  selector?: HistorySelector
  ref?: string
  firstParent?: boolean
  limit?: number
  cursor?: string
}

export type ValidatedHistoryRequest = {
  selector: HistorySelector
  ref: string | undefined
  firstParent: boolean
  limit: number
}

export const validateHistoryRequest = (
  input: HistoryRequestInput | undefined,
): { ok: true; value: ValidatedHistoryRequest } | { ok: false; failure: HistoryFailure } => {
  const selector = input?.selector ?? "head"
  if (selector !== "all" && selector !== "head" && selector !== "branch") {
    return { ok: false, failure: historyFailure("invalid_ref", "Unknown history selector", "change-selection") }
  }
  if (selector === "all" && (input?.firstParent ?? false)) {
    return {
      ok: false,
      failure: historyFailure("invalid_ref", "First-parent mode is not available for 'All branches'", "change-selection"),
    }
  }
  const ref = input?.ref
  if (selector === "branch") {
    if (
      typeof ref !== "string" ||
      !/^refs\/(heads|remotes)\/\S+$/.test(ref) ||
      ref.includes("..") ||
      /[\s\x00-\x1f\x7f]/.test(ref) ||
      /(^|\/)[.~^:?\*[\\]/.test(ref.slice("refs/".length)) ||
      /\/$/.test(ref) ||
      ref.endsWith(".lock")
    ) {
      return { ok: false, failure: historyFailure("invalid_ref", "Branch reference is invalid", "change-selection") }
    }
  }
  const rawLimit = input?.limit ?? 200
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > HISTORY_PAGE_LIMIT_MAX) {
    return { ok: false, failure: historyFailure("invalid_ref", `History page size must be 1-${HISTORY_PAGE_LIMIT_MAX}`, "change-selection") }
  }
  return { ok: true, value: { selector, ref: selector === "branch" ? ref : undefined, firstParent: input?.firstParent ?? false, limit: rawLimit } }
}

export const validateMessageRequest = (
  input: { hash?: string; cursor?: string } | undefined,
): { ok: true; value: { hash?: string; cursor?: string } } | { ok: false; failure: HistoryFailure } => {
  const hasHash = typeof input?.hash === "string" && input.hash.length > 0
  const hasCursor = typeof input?.cursor === "string" && input.cursor.length > 0
  if (hasHash === hasCursor) {
    return { ok: false, failure: historyFailure("invalid_cursor", "Provide either a commit hash or a text cursor", "retry") }
  }
  if (hasHash && !FULL_OID.test(input.hash!)) {
    return { ok: false, failure: historyFailure("invalid_cursor", "Commit hash is invalid", "retry") }
  }
  return { ok: true, value: { hash: input?.hash, cursor: input?.cursor } }
}

export const historyRefLabel = (fullRef: string): string => {
  if (fullRef.startsWith("refs/heads/")) return fullRef.slice("refs/heads/".length)
  if (fullRef.startsWith("refs/remotes/")) return fullRef.slice("refs/remotes/".length)
  return fullRef.slice("refs/".length)
}

export const isValidFullOid = (value: string): boolean => FULL_OID.test(value)
