import { describe, expect, test } from "bun:test"
import * as GitHistory from "@/project/git-history"

const repo = "C:/repo"

function encode(payload: Partial<GitHistory.HistoryCursorPayload> & { repo?: string; kind?: "page" | "message" }) {
  return GitHistory.encodeHistoryCursor({
    v: 1,
    repo: payload.repo ?? repo,
    kind: payload.kind ?? "page",
    mode: payload.mode,
    firstParent: payload.firstParent,
    roots: payload.roots,
    pageSize: payload.pageSize,
    offset: payload.offset,
    shallow: payload.shallow,
    oid: payload.oid,
    byteOffset: payload.byteOffset,
  })
}

describe("history cursor", () => {
  test("round-trips a page payload", () => {
    const token = encode({
      mode: "branch",
      firstParent: true,
      roots: ["a".repeat(40)],
      pageSize: 200,
      offset: 400,
      shallow: "abc",
    })
    expect(typeof token).toBe("string")
    const decoded = GitHistory.decodeHistoryCursor(token as string, { repo, kind: "page" })
    expect(decoded.ok).toBe(true)
    if (decoded.ok) {
      expect(decoded.payload.mode).toBe("branch")
      expect(decoded.payload.firstParent).toBe(true)
      expect(decoded.payload.offset).toBe(400)
      expect(decoded.payload.pageSize).toBe(200)
      expect(decoded.payload.shallow).toBe("abc")
    }
  })

  test("rejects tampered payloads", () => {
    const token = encode({ roots: ["a".repeat(40)], pageSize: 10, offset: 0, shallow: "none" }) as string
    const body = token.slice(0, token.indexOf("."))
    const decodedBody = Buffer.from(body, "base64url")
    decodedBody[decodedBody.length - 1] ^= 0x01
    const tampered = `${decodedBody.toString("base64url")}.${token.slice(token.indexOf(".") + 1)}`
    const decoded = GitHistory.decodeHistoryCursor(tampered, { repo, kind: "page" })
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.failure.code).toBe("invalid_cursor")
  })

  test("binds the cursor to one repository", () => {
    const token = encode({ roots: ["a".repeat(40)], pageSize: 10, offset: 0, shallow: "none" }) as string
    const decoded = GitHistory.decodeHistoryCursor(token, { repo: "C:/other", kind: "page" })
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.failure.code).toBe("invalid_cursor")
  })

  test("rejects a message cursor in the page channel", () => {
    const token = encode({ kind: "message", oid: "b".repeat(40), byteOffset: 16 })
    const decoded = GitHistory.decodeHistoryCursor(token as string, { repo, kind: "page" })
    expect(decoded.ok).toBe(false)
  })

  test("validates page geometry fields", () => {
    const token = encode({ roots: ["a".repeat(40)], pageSize: 0, offset: 0, shallow: "none" }) as string
    const decoded = GitHistory.decodeHistoryCursor(token, { repo, kind: "page" })
    expect(decoded.ok).toBe(false)
  })
})

describe("utf8 truncation", () => {
  test("keeps complete characters when truncating", () => {
    const bytes = Buffer.from("aäöü€".repeat(50), "utf8")
    const result = GitHistory.truncateUtf8Safe(bytes, 17)
    expect(result.truncated).toBe(true)
    expect(Buffer.from(result.text, "utf8").length).toBeLessThanOrEqual(17)
    // Decoding must not contain the replacement character at the end.
    expect(result.text.endsWith("�")).toBe(false)
  })

  test("returns the full text below the limit", () => {
    const bytes = Buffer.from("hällo", "utf8")
    const result = GitHistory.truncateUtf8Safe(bytes, 64)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe("hällo")
  })

  test("utf8 boundary detection withholds incomplete trailing sequences", () => {
    // "€" is a 3-byte sequence; a cut inside it must withhold the whole
    // character instead of decoding a replacement char, and the withheld
    // bytes re-read from nextOffset must complete the text losslessly.
    const bytes = Buffer.from("ab€cd", "utf8")
    for (let cut = 1; cut <= bytes.length + 1; cut++) {
      const result = GitHistory.truncateUtf8Safe(bytes, cut)
      expect(result.text).not.toContain("�")
      const chunk = GitHistory.sliceMessageChunk(bytes, 0, cut)
      expect(chunk.text).not.toContain("�")
      const reassembled = chunk.text + bytes.subarray(chunk.nextOffset).toString("utf8")
      expect(reassembled).toBe("ab€cd")
    }
    // 3- and 4-byte sequences directly at the cut.
    const emoji = Buffer.concat([Buffer.from("ab", "utf8"), Buffer.from("🎉", "utf8")])
    const result = GitHistory.truncateUtf8Safe(emoji, 4)
    expect(result.text).toBe("ab")
  })

  test("char-safe chunk boundaries concatenate losslessly", () => {
    const bytes = Buffer.from("äöü ".repeat(100), "utf8")
    let offset = 0
    let text = ""
    while (offset < bytes.length) {
      const chunk = GitHistory.sliceMessageChunk(bytes, offset, 7)
      text += chunk.text
      offset = chunk.nextOffset
    }
    expect(text).toBe(bytes.toString("utf8"))
  })

  test("message window reassembly across the chunk boundary with multibyte characters", () => {
    const oid = "d".repeat(40)
    const longBody = `${"ä".repeat(6000)}🎉${"🎉".repeat(50)}`
    const message = `subject\n\n${longBody}`
    const content = Buffer.concat([Buffer.from("tree 1\nparent 2\n\n", "utf8"), Buffer.from(message, "utf8")])
    const stream = Buffer.concat([Buffer.from(`${oid} commit ${content.length}\n`, "utf8"), content, Buffer.from("\n")])
    const raw = new Uint8Array(stream)
    let text = ""
    let offset = 0
    let guard = 0
    for (;;) {
      const parser = GitHistory.createMessageWindowParser({ byteOffset: offset, maxBytes: GitHistory.HISTORY_MESSAGE_CHUNK_BYTES })
      for (let i = 0; i < raw.length; i += 5) parser.feed(raw.subarray(i, i + 5))
      expect(parser.failed).toBeUndefined()
      const safeEnd = GitHistory.utf8SafeByteCount(parser.collected)
      const collectedLength = parser.collected.length
      text += parser.collected.subarray(0, safeEnd).toString("utf8")
      const exhausted = collectedLength < GitHistory.HISTORY_MESSAGE_CHUNK_BYTES && offset + collectedLength >= message.length
      if (exhausted && safeEnd === collectedLength) break
      offset += safeEnd
      if (offset >= message.length) break
      if (++guard > 500) throw new Error("chunk loop did not terminate")
    }
    expect(text).toBe(message)
  })
})

describe("commit object parsing", () => {
  const buildCommit = (message: string, extra = "") =>
    Buffer.concat([
      Buffer.from(`tree ${"1".repeat(40)}\n`, "utf8"),
      Buffer.from(`parent ${"2".repeat(40)}\n`, "utf8"),
      Buffer.from(`author A U Thor <author@example.com> 1700000000 +0100\n`, "utf8"),
      Buffer.from(`committer C O Mitter <committer@example.com> 1700000001 -0500\n`, "utf8"),
      Buffer.from(extra, "utf8"),
      Buffer.from("\n", "utf8"),
      Buffer.from(message, "utf8"),
    ])

  test("parses headers, parents and iso dates", () => {
    const parsed = GitHistory.parseCommitObject(buildCommit("subject line\n\nbody text\n"))
    expect(parsed.parents).toEqual(["2".repeat(40)])
    expect(parsed.headerOverflow).toBe(false)
    expect(parsed.author?.name).toBe("A U Thor")
    expect(parsed.author?.email).toBe("author@example.com")
    expect(parsed.author?.date).toBe("2023-11-14T23:13:20+01:00")
    expect(parsed.committer?.date).toBe("2023-11-14T17:13:21-05:00")
    expect(parsed.messageStart).toBeGreaterThan(0)
    const { subject, bodyStart } = GitHistory.splitCommitMessage(buildCommit("subject line\n\nbody text\n"), parsed.messageStart)
    expect(subject).toBe("subject line")
    expect(bodyStart).toBe(parsed.messageStart + "subject line\n\n".length)
  })

  test("skips continuation header lines like gpgsig", () => {
    const sig = "gpgsig -----BEGIN PGP SIGNATURE-----\n line one\n line two\n -----END PGP SIGNATURE-----\n"
    const parsed = GitHistory.parseCommitObject(buildCommit("msg\n", sig))
    expect(parsed.parents).toEqual(["2".repeat(40)])
    expect(parsed.headerOverflow).toBe(false)
  })

  test("flags oversized bodies as truncated for preview", () => {
    const big = `${"x".repeat(GitHistory.HISTORY_BODY_PREVIEW_BYTES + 500)}\n`
    const bytes = buildCommit(`subject\n\n${big}`)
    const parsed = GitHistory.parseCommitObject(bytes)
    const { bodyStart } = GitHistory.splitCommitMessage(bytes, parsed.messageStart)
    const preview = GitHistory.truncateUtf8Safe(bytes.subarray(bodyStart), GitHistory.HISTORY_BODY_PREVIEW_BYTES)
    const fullBodyBytes = bytes.length - bodyStart
    expect(fullBodyBytes > Buffer.byteLength(preview.text, "utf8")).toBe(true)
    expect(preview.text.length).toBeLessThan(big.length)
  })
})

describe("walk record parsing", () => {
  const sep = "\x1e"
  const field = "\x1f"

  test("parses well-formed records", () => {
    const record = ["a".repeat(40), "abc1234", `${"b".repeat(40)} ${"c".repeat(40)}`, "Author", "a@example.com", "2024-01-01T00:00:00+00:00"].join(field)
    const parsed = GitHistory.parseWalkRecords(`${record}${sep}`)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.records).toHaveLength(1)
      expect(parsed.records[0].logParents).toEqual(["b".repeat(40), "c".repeat(40)])
    }
  })

  test("rejects records with injected separators instead of guessing", () => {
    const hostile = ["a".repeat(40), "abc1234", "", `Na${field}me`, "a@example.com", "date"].join(field)
    const parsed = GitHistory.parseWalkRecords(`${hostile}${sep}`)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.failure.code).toBe("process_failed")
  })
})

describe("cat-file batch parser", () => {
  const header = (oid: string, size: number) => Buffer.from(`${oid} commit ${size}\n`, "utf8")

  test("parses objects across chunk boundaries byte-exactly", () => {
    const oidA = "a".repeat(40)
    const oidB = "b".repeat(40)
    const contentA = Buffer.from("tree 1\n\nmessage A\n", "utf8")
    const contentB = Buffer.from("tree 2\nparent x\n\nB\n", "utf8")
    const stream = Buffer.concat([header(oidA, contentA.length), contentA, Buffer.from("\n"), header(oidB, contentB.length), contentB, Buffer.from("\n")])
    const parser = GitHistory.createBatchContentParser()
    for (const byte of stream) parser.feed(new Uint8Array([byte]))
    expect(parser.failed).toBeUndefined()
    expect(parser.objects).toHaveLength(2)
    expect(parser.objects[0].oid).toBe(oidA)
    expect(parser.objects[0].kept.toString("utf8")).toBe("tree 1\n\nmessage A\n")
    expect(parser.objects[1].oid).toBe(oidB)
  })

  test("reports missing objects instead of fabricating history", () => {
    const parser = GitHistory.createBatchContentParser()
    parser.feed(new TextEncoder().encode(`${"a".repeat(40)} missing\n`))
    expect(parser.failed).toContain("missing")
  })

  test("caps kept bytes but consumes the whole object", () => {
    const oid = "a".repeat(40)
    const message = "y".repeat(GitHistory.HISTORY_OBJECT_KEEP_BYTES * 2)
    const content = Buffer.from(`tree 1\n\n${message}\n`, "utf8")
    const stream = Buffer.concat([header(oid, content.length), content, Buffer.from("\n")])
    const parser = GitHistory.createBatchContentParser()
    parser.feed(new Uint8Array(stream))
    expect(parser.failed).toBeUndefined()
    expect(parser.objects).toHaveLength(1)
    expect(parser.objects[0].size).toBe(content.length)
    expect(parser.objects[0].kept.length).toBe(GitHistory.HISTORY_OBJECT_KEEP_BYTES)
  })
})

describe("message window parser", () => {
  const oid = "c".repeat(40)
  const buildStream = (message: string) => {
    const content = Buffer.concat([Buffer.from(`tree 1\nparent 2\n\n`, "utf8"), Buffer.from(message, "utf8")])
    return Buffer.concat([Buffer.from(`${oid} commit ${content.length}\n`, "utf8"), content, Buffer.from("\n")])
  }

  test("collects the requested window and completes", () => {
    const message = "first\n\nsecond chunk with äöü\n"
    const parser = GitHistory.createMessageWindowParser({ byteOffset: message.indexOf("second"), maxBytes: 8 })
    parser.feed(new Uint8Array(buildStream(message)))
    expect(parser.failed).toBeUndefined()
    expect(parser.complete).toBe(true)
    expect(parser.collected.toString("utf8")).toBe("second c")
  })

  test("skips bytes before the offset across chunk boundaries", () => {
    const message = `${"z".repeat(5000)}\n\nTAIL\n`
    const offset = message.indexOf("TAIL")
    const parser = GitHistory.createMessageWindowParser({ byteOffset: offset, maxBytes: 64 })
    const stream = new Uint8Array(buildStream(message))
    for (let i = 0; i < stream.length; i += 3) parser.feed(stream.subarray(i, i + 3))
    expect(parser.failed).toBeUndefined()
    expect(parser.collected.toString("utf8")).toBe("TAIL\n")
  })
})

describe("input validation", () => {
  test("rejects first-parent combined with all", () => {
    const result = GitHistory.validateHistoryRequest({ selector: "all", firstParent: true })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe("invalid_ref")
  })

  test("rejects non-canonical refs", () => {
    expect(GitHistory.validateHistoryRequest({ selector: "branch", ref: "main" }).ok).toBe(false)
    expect(GitHistory.validateHistoryRequest({ selector: "branch", ref: "refs/heads/..evil" }).ok).toBe(false)
    expect(GitHistory.validateHistoryRequest({ selector: "branch", ref: "-webhook" }).ok).toBe(false)
    expect(GitHistory.validateHistoryRequest({ selector: "branch", ref: "refs/heads/topic/HEAD" }).ok).toBe(true)
  })

  test("defaults to head with bounded page size", () => {
    const result = GitHistory.validateHistoryRequest(undefined)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.selector).toBe("head")
      expect(result.value.limit).toBe(200)
      expect(result.value.firstParent).toBe(false)
    }
    expect(GitHistory.validateHistoryRequest({ limit: 1001 }).ok).toBe(false)
  })

  test("commit message requests need exactly one anchor", () => {
    expect(GitHistory.validateMessageRequest(undefined).ok).toBe(false)
    expect(GitHistory.validateMessageRequest({ hash: "a".repeat(40), cursor: "x" }).ok).toBe(false)
    expect(GitHistory.validateMessageRequest({ hash: "nope" }).ok).toBe(false)
    expect(GitHistory.validateMessageRequest({ hash: "a".repeat(40) }).ok).toBe(true)
    expect(GitHistory.validateMessageRequest({ cursor: "x" }).ok).toBe(true)
  })
})

describe("ref labels and failure hints", () => {
  test("ref labels use display names", () => {
    expect(GitHistory.historyRefLabel("refs/heads/release")).toBe("release")
    expect(GitHistory.historyRefLabel("refs/remotes/origin/main")).toBe("origin/main")
    expect(GitHistory.historyRefLabel("refs/heads/topic/HEAD")).toBe("topic/HEAD")
  })

  test("output_limit suggests refresh, process_failed suggests retry", () => {
    const limit = GitHistory.historyFailure("output_limit", "budget")
    expect(limit.recovery).toBe("refresh")
    const process = GitHistory.historyFailure("process_failed", "git failed")
    expect(process.recovery).toBe("retry")
  })
})

describe("shallow fingerprint", () => {
  test("distinguishes absent and changed boundaries", () => {
    expect(GitHistory.computeShallowFingerprint(undefined)).toBe("none")
    const a = GitHistory.computeShallowFingerprint("abc\n")
    const b = GitHistory.computeShallowFingerprint("abcd\n")
    expect(a).not.toBe("none")
    expect(a).not.toBe(b)
  })
})

describe("walk argv", () => {
  test("builds a fixed, stdin-fed walk", () => {
    const args = GitHistory.buildWalkArgs({ firstParent: true, offset: 400, limit: 199 })
    expect(args[0]).toBe("--no-replace-objects")
    expect(args).toContain("--topo-order")
    expect(args).toContain("--first-parent")
    expect(args).toContain("--skip=400")
    expect(args).toContain("--max-count=200")
    expect(args.at(-1)).toBe("--stdin")
  })
})
