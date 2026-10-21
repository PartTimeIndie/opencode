import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "path"
import { pathToFileURL } from "node:url"
import { MAX_CONTENT_PREVIEW_BYTES, MAX_PERSISTED_CONTENT_PREVIEW_BYTES } from "../src/content-preview"
import { migrateLegacyContent } from "../src/content-migration"
import { decodeStoredEventData, encodeStoredEventData } from "../src/event"

const directories: string[] = []

afterEach(async () => {
  Bun.gc(true)
  await Promise.all(directories.splice(0).map(removeFixture))
}, 10_000)

async function removeFixture(directory: string, attempts = 0): Promise<void> {
  return rm(directory, { recursive: true, force: true }).catch(async (error) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EBUSY" || attempts >= 20) throw error
    await Bun.sleep(250)
    Bun.gc(true)
    return removeFixture(directory, attempts + 1)
  })
}

describe("legacy content migration", () => {
  test("stages deduplicated attachments and structured output without changing the source database", async () => {
    const fixture = await createFixture()
    const sourceHash = await hash(fixture.database)
    const sourceRows = readPayloads(fixture.database)

    const partial = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 2,
      maxRows: 2,
    })
    expect(partial.status).toBe("incomplete")
    expect(partial.report.rowsScanned).toBe(2)

    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 2,
    })

    expect(manifest.status).toBe("quarantined")
    expect(manifest.report.rowsScanned).toBe(4)
    expect(manifest.report.rowsChanged).toBe(4)
    expect(manifest.report.references).toBe(6)
    expect(manifest.report.dataUrls).toBe(4)
    expect(manifest.report.fileUrls).toBe(1)
    expect(manifest.report.structuredOutputs).toBe(1)
    expect(manifest.report.legacyMutationBlobs).toBe(1)
    expect(manifest.report.legacyMutationBytes).toBe(Buffer.byteLength("same-image-bytes"))
    expect(manifest.report.uniqueBlobs).toBe(3)
    expect(manifest.report.duplicateReferences).toBe(4)
    expect(manifest.report.quarantined).toBe(2)
    expect(manifest.quarantine.map((entry) => entry.kind).sort()).toEqual(["data", "file"])
    expect(manifest.report.estimatedDatabaseBytesSaved).toBeGreaterThan(0)
    expect(await hash(fixture.database)).toBe(sourceHash)
    expect(readPayloads(fixture.database)).toEqual(sourceRows)

    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM content_blob").get()?.count,
      ).toBe(3)
      expect(
        candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM attachment").get()?.count,
      ).toBe(6)
      expect(
        candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM session_file_blob").get()?.count,
      ).toBe(0)
      const input = JSON.parse(
        candidate.query<{ readonly prompt: string }, []>("SELECT prompt FROM session_input").get()!.prompt,
      )
      expect(input.files[0].uri).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(input.files[1].uri).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(input.files[2].uri).toBe(fixture.missingURI)
      const message = JSON.parse(
        candidate.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()!.data,
      )
      expect(message.image).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(message.structured.$opencode.type).toBe("content-reference")
      expect(Buffer.byteLength(message.structured.$opencode.preview, "utf8")).toBeLessThanOrEqual(50 * 1024)
      const part = JSON.parse(candidate.query<{ readonly data: string }, []>("SELECT data FROM part").get()!.data)
      expect(part.uri).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(part.invalid).toBe("data:image/png;base64,%%%%")
      const event = candidate.query<{ readonly data: string }, []>("SELECT data FROM event").get()!
      expect((decodeStoredEventData(JSON.parse(event.data)).nested as { uri: string }).uri).toMatch(
        /^attachment:\/\/att_[0-9a-f]{32}$/,
      )
    } finally {
      candidate.close()
    }

    const stagedFiles = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: manifest.blobDirectory, onlyFiles: true }),
    )
    expect(stagedFiles).toHaveLength(3)
    expect(await Bun.file(path.join(fixture.staging, "content-migration-manifest.json")).exists()).toBe(true)
  })

  test("reuses one attachment identity across a projected message and its durable event", async () => {
    const fixture = await createDualWrittenAttachmentFixture()
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })

    expect(manifest.status).toBe("complete")
    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const message = JSON.parse(
        candidate.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()!.data,
      )
      const event = decodeStoredEventData(
        JSON.parse(candidate.query<{ readonly data: string }, []>("SELECT data FROM event").get()!.data),
      )
      expect(message.structured.$opencode.uri).toBe((event.structured as typeof message.structured).$opencode.uri)
      expect(candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM attachment").get()?.count)
        .toBe(1)
      expect(
        candidate.query<{ readonly count: number }, []>(
          "SELECT count(*) AS count FROM _content_migration_occurrence",
        ).get()?.count,
      ).toBe(2)
    } finally {
      candidate.close()
    }
  })

  test("resumes a bounded dry-run from its SQLite journal and leaves source payloads unchanged", async () => {
    const fixture = await createFixture()
    const before = readPayloads(fixture.database)

    const partial = await migrateLegacyContent({
      mode: "dry-run",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      maxRows: 1,
    })
    expect(partial.status).toBe("incomplete")
    expect(partial.report.rowsScanned).toBe(1)

    const complete = await migrateLegacyContent({
      mode: "dry-run",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 1,
    })
    expect(complete.status).toBe("quarantined")
    expect(complete.report.rowsScanned).toBe(4)
    expect(complete.report.references).toBe(6)
    expect(complete.report.uniqueBlobs).toBe(3)
    expect(readPayloads(fixture.database)).toEqual(before)

    const inventory = new Database(complete.stagingDatabase, { readonly: true, strict: true })
    try {
      expect(
        inventory.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_row").get()
          ?.count,
      ).toBe(4)
      expect(
        inventory
          .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_occurrence")
          .get()?.count,
      ).toBe(6)
      expect(
        inventory
          .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_legacy_blob")
          .get()?.count,
      ).toBe(1)
      expect(
        inventory
          .query<{ readonly name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'session_input'")
          .get(),
      ).toBeNull()
    } finally {
      inventory.close()
    }
  })

  test("only treats standalone structurally plausible URLs as attachment candidates", async () => {
    const stacktrace = [
      "file:///C:/GitRepros/opencode/packages/core/example.mjs:1",
      'throw new Error("fixture")',
      "      ^",
      "Error: fixture",
      "    at file:///C:/GitRepros/opencode/packages/core/example.mjs:1:7",
    ].join("\n")
    const attachmentRoot = await mkdtemp(path.join(tmpdir(), "opencode-content-url-candidates-"))
    directories.push(attachmentRoot)
    const existingFile = path.join(attachmentRoot, "existing attachment.txt")
    await Bun.write(existingFile, "standalone file attachment")
    const existingURL = pathToFileURL(existingFile).href
    const missingFile = pathToFileURL(path.join(attachmentRoot, "missing.pdf")).href
    const uppercaseData = `DATA:text/plain;base64,${Buffer.from("standalone attachment").toString("base64")}`
    const invalidData = "data:image/png;base64,%%%%"
    const original = {
      stacktrace,
      fileRegex: "file://|fromUri|fetch\\(|readFile",
      bareData: "data:",
      dataRegex: "data:.*base64|part.uri|ToolResult",
      dataRegexWithComma: "data:[^,]+,.*|part.uri",
      dataCode: "data:image/png;base64",
      uppercaseData,
      uppercaseFile: existingURL.replace(/^file:/, "FILE:"),
      localhostFile: existingURL.replace(/^file:\/\/\//, "file://localhost/"),
      invalidData,
      missingFile,
    }
    const fixture = await createMessageFixture([original])

    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })

    expect(manifest.status).toBe("quarantined")
    expect(manifest.report.rowsScanned).toBe(1)
    expect(manifest.report.rowsChanged).toBe(1)
    expect(manifest.report.references).toBe(3)
    expect(manifest.report.dataUrls).toBe(1)
    expect(manifest.report.fileUrls).toBe(2)
    expect(manifest.report.quarantined).toBe(2)
    expect(manifest.quarantine).toEqual([
      expect.objectContaining({ path: "$/invalidData", kind: "data" }),
      expect.objectContaining({ path: "$/missingFile", kind: "file" }),
    ])

    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const row = candidate.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()!
      const migrated = JSON.parse(row.data)
      expect(migrated).toMatchObject({
        stacktrace,
        fileRegex: original.fileRegex,
        bareData: original.bareData,
        dataRegex: original.dataRegex,
        dataRegexWithComma: original.dataRegexWithComma,
        dataCode: original.dataCode,
        invalidData,
        missingFile,
      })
      expect(migrated.uppercaseData).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(migrated.uppercaseFile).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(migrated.localhostFile).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(migrated.uppercaseFile).toBe(migrated.localhostFile)
    } finally {
      candidate.close()
    }

    expect(await Bun.file(`${manifest.stagingDatabase}-wal`).exists()).toBeFalse()
    expect(await Bun.file(`${manifest.stagingDatabase}-shm`).exists()).toBeFalse()
    const copiedDatabase = path.join(fixture.root, "candidate-copy.db")
    await copyFile(manifest.stagingDatabase, copiedDatabase)
    const copied = new Database(copiedDatabase, { readonly: true, strict: true })
    try {
      const migrated = JSON.parse(
        copied.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()!.data,
      )
      expect(migrated.uppercaseData).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(migrated.uppercaseFile).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(migrated.localhostFile).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)
      expect(migrated.invalidData).toBe(invalidData)
      expect(
        copied.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM attachment").get()?.count,
      ).toBe(2)
    } finally {
      copied.close()
    }

    const source = new Database(fixture.database, { readonly: true, strict: true })
    try {
      expect(
        JSON.parse(source.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()!.data),
      ).toEqual(original)
    } finally {
      source.close()
    }
  })

  test("allows read-only progress observation while committing staging checkpoints", async () => {
    const fixture = await createMessageFixture([{ index: 1 }, { index: 2 }, { index: 3 }])
    const partial = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      maxRows: 1,
    })
    expect(partial.status).toBe("incomplete")

    const observer = new Database(partial.stagingDatabase, { readonly: true, strict: true })
    observer.exec("BEGIN")
    try {
      expect(
        observer.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_row").get()
          ?.count,
      ).toBe(1)
      expect(observer.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "wal",
      )

      const blocked = await migrateLegacyContent({
        mode: "stage",
        sourceDatabase: fixture.database,
        stagingDirectory: fixture.staging,
      })
      expect(blocked.status).toBe("incomplete")
      expect(blocked.report.rowsScanned).toBe(3)
      expect(await Bun.file(`${blocked.stagingDatabase}-wal`).exists()).toBeTrue()
    } finally {
      observer.exec("ROLLBACK")
      observer.close()
    }

    const complete = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })
    expect(complete.status).toBe("complete")
    expect(complete.report.rowsScanned).toBe(3)
    expect(await Bun.file(`${complete.stagingDatabase}-wal`).exists()).toBeFalse()

    const source = new Database(fixture.database, { readonly: true, strict: true })
    try {
      expect(source.query<{ readonly journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "delete",
      )
    } finally {
      source.close()
    }
  })

  test("checkpoints large row scans once per batch instead of once per row", async () => {
    const fixture = await createMessageFixture(Array.from({ length: 250 }, (_, index) => ({ index })))
    const partial = await migrateLegacyContent({
      mode: "dry-run",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 100,
      maxRows: 100,
    })
    expect(partial.status).toBe("incomplete")
    expect(partial.report.rowsScanned).toBe(100)

    const manifest = await migrateLegacyContent({
      mode: "dry-run",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 100,
    })

    expect(manifest.status).toBe("complete")
    expect(manifest.report.rowsScanned).toBe(250)
    expect(manifest.report.checkpointTransactions).toBe(3)
    const inventory = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      expect(
        inventory
          .query<
            { readonly value: string },
            []
          >("SELECT value FROM _content_migration_meta WHERE key = 'row_checkpoint_transactions'")
          .get()?.value,
      ).toBe("3")
    } finally {
      inventory.close()
    }
  })

  test("publishes batch progress, cleans WAL, and defers physical compaction to storage publication", async () => {
    const fixture = await createMessageFixture(
      Array.from({ length: 25 }, (_, index) => ({ index, padding: "x".repeat(8_000) })),
    )
    const observed: number[] = []
    const progress: number[] = []
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 5,
      maxBatchBytes: 64 * 1024,
      onProgress: async (event) => {
        if (event.state !== "checkpointed" || event.table !== "session_message") return
        progress.push(event.rowsScanned)
        const observer = new Database(path.join(fixture.staging, "candidate.db"), { readonly: true, strict: true })
        try {
          observed.push(
            observer
              .query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_row")
              .get()!.count,
          )
        } finally {
          observer.close()
        }
      },
    })

    expect(manifest.status).toBe("complete")
    expect(progress.length).toBeGreaterThan(1)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(observed).toEqual(progress)
    expect(await Bun.file(`${manifest.stagingDatabase}-wal`).exists()).toBeFalse()
    expect(await Bun.file(`${manifest.stagingDatabase}-shm`).exists()).toBeFalse()
    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate
          .query<{ readonly value: string }, []>(
            "SELECT value FROM _content_migration_meta WHERE key = 'complete:vacuum'",
          )
          .get(),
      ).toBeNull()
    } finally {
      candidate.close()
    }
  })

  test("streams final validation and caps accumulated batch memory by bytes", async () => {
    const maxBatchBytes = 100 * 1024
    const fixture = await createMessageFixture(
      Array.from({ length: 120 }, (_, index) => ({ index, padding: "x".repeat(80 * 1024) })),
    )
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 100,
      maxBatchBytes,
    })

    expect(manifest.status).toBe("complete")
    expect(manifest.report.rowsScanned).toBe(120)
    expect(manifest.report.validationRows).toBe(120)
    expect(manifest.report.validationWindowRows).toBe(1)
    expect(manifest.report.peakBatchBytes).toBeLessThanOrEqual(maxBatchBytes)
    expect(manifest.report.checkpointTransactions).toBe(120)
  })

  test("reports the unavoidable single-row working set when a changed row exceeds the batch target", async () => {
    const maxBatchBytes = 16 * 1024
    const fixture = await createMessageFixture([
      {
        image: `data:application/octet-stream;base64,${Buffer.alloc(160 * 1024, 7).toString("base64")}`,
      },
    ])
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      maxBatchBytes,
    })

    expect(manifest.status).toBe("complete")
    expect(manifest.report.rowsChanged).toBe(1)
    expect(manifest.report.peakBatchBytes).toBeGreaterThan(maxBatchBytes)
    expect(manifest.report.largestRowBytes).toBe(manifest.report.peakBatchBytes)
    expect(manifest.report.oversizedRows).toBe(1)
    expect(manifest.report.validationWindowRows).toBe(1)
  })

  test("defers a changed row instead of exceeding the batch target with multiple rows", async () => {
    const payloads = [
      { padding: "x".repeat(8 * 1024) },
      { image: `data:application/octet-stream;base64,${Buffer.alloc(4 * 1024, 7).toString("base64")}` },
    ]
    const fixture = await createMessageFixture(payloads)
    const maxBatchBytes = payloads.reduce(
      (total, payload) => total + Buffer.byteLength(JSON.stringify(payload), "utf8"),
      0,
    )
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      maxBatchBytes,
    })

    expect(manifest.status).toBe("complete")
    expect(manifest.report.rowsScanned).toBe(2)
    expect(manifest.report.checkpointTransactions).toBe(2)
    expect(manifest.report.peakBatchBytes).toBeLessThanOrEqual(maxBatchBytes)
    expect(manifest.report.largestRowBytes).toBeLessThan(maxBatchBytes)
    expect(manifest.report.oversizedRows).toBe(0)
  })

  test("resumes idempotently after a blob publish before the database checkpoint", async () => {
    const fixture = await createMessageFixture([
      { image: `data:text/plain;base64,${Buffer.from("fault-before-commit").toString("base64")}` },
    ])
    await expect(
      migrateLegacyContent({
        mode: "stage",
        sourceDatabase: fixture.database,
        stagingDirectory: fixture.staging,
        testHooks: {
          afterBlobPublish: () => {
            throw new Error("fault after blob publish")
          },
        },
      }),
    ).rejects.toThrow("fault after blob publish")

    const interrupted = new Database(path.join(fixture.staging, "candidate.db"), { readonly: true, strict: true })
    try {
      expect(
        interrupted.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM _content_migration_row").get()
          ?.count,
      ).toBe(0)
    } finally {
      interrupted.close()
    }
    expect(
      await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(fixture.staging, "content"), onlyFiles: true })),
    ).toHaveLength(1)

    const resumed = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })
    expect(resumed.status).toBe("complete")
    expect(resumed.report.rowsScanned).toBe(1)
    expect(resumed.report.references).toBe(1)
  })

  test("resumes without duplicate work after commit and before progress publication", async () => {
    const fixture = await createMessageFixture([
      { image: `data:text/plain;base64,${Buffer.from("fault-after-commit").toString("base64")}` },
    ])
    const progress: number[] = []
    await expect(
      migrateLegacyContent({
        mode: "stage",
        sourceDatabase: fixture.database,
        stagingDirectory: fixture.staging,
        onProgress: (event) => {
          if (event.state === "checkpointed") progress.push(event.rowsScanned)
        },
        testHooks: {
          afterDatabaseCommit: () => {
            throw new Error("fault after database commit")
          },
        },
      }),
    ).rejects.toThrow("fault after database commit")
    expect(progress).toEqual([])

    const resumed = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })
    expect(resumed.status).toBe("complete")
    expect(resumed.report.rowsScanned).toBe(1)
    expect(resumed.report.references).toBe(1)
    expect(resumed.report.checkpointTransactions).toBe(1)
    const candidate = new Database(resumed.stagingDatabase, { readonly: true, strict: true })
    try {
      expect(
        candidate.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM attachment").get()?.count,
      ).toBe(1)
    } finally {
      candidate.close()
    }
  })

  test("caches event session resolution instead of querying once or twice per row", async () => {
    const fixture = await createEventFixture(500)
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
      batchSize: 100,
    })

    expect(manifest.status).toBe("complete")
    expect(manifest.report.rowsScanned).toBe(500)
    expect(manifest.report.sessionResolutionQueries).toBe(2)
  })

  test("allows a non-destructive dry-run against WAL mode but requires offline staging", async () => {
    const fixture = await createFixture()
    const writer = new Database(fixture.database, { strict: true })
    writer.exec("PRAGMA journal_mode = WAL")
    writer.run("UPDATE session SET id = id")
    try {
      const dryRun = await migrateLegacyContent({
        mode: "dry-run",
        sourceDatabase: fixture.database,
        stagingDirectory: fixture.staging,
      })
      expect(dryRun.status).toBe("quarantined")

      await expect(
        migrateLegacyContent({
          mode: "stage",
          sourceDatabase: fixture.database,
          stagingDirectory: path.join(fixture.root, "offline-stage"),
        }),
      ).rejects.toThrow(/WAL|offline/)
    } finally {
      writer.close()
    }
  })

  test("migrates compressed checkpoints and bounded legacy and V2 tool outputs with exact references", async () => {
    const fixture = await createToolOutputFixture()
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })

    expect(manifest.status).toBe("complete")
    expect(manifest.report.rowsScanned).toBe(5)
    expect(manifest.report.rowsChanged).toBe(5)
    expect(manifest.report.structuredOutputs).toBe(7)
    expect(manifest.report.dataUrls).toBe(1)
    expect(manifest.report.references).toBe(8)
    expect(manifest.report.uniqueBlobs).toBe(3)
    expect(manifest.report.duplicateReferences).toBe(5)

    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const legacy = JSON.parse(candidate.query<{ readonly data: string }, []>("SELECT data FROM part").get()!.data)
      const legacyMetadataURI = legacy.state.metadata.$opencode.uri
      const legacyOutputURI = legacy.state.metadata.$opencode.output.uri
      expect(Buffer.byteLength(legacy.state.output, "utf8")).toBeLessThanOrEqual(50 * 1024)
      expect(legacy.state.metadata.$opencode.output).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
        mime: "text/plain",
      })
      expect(legacy.state.metadata.$opencode).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
        mime: "application/json",
      })

      const message = JSON.parse(
        candidate.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()!.data,
      )
      const tool = message.content[0]
      const toolTextURI = tool.state.structured.$opencode.text.uri
      const toolResultURI = tool.state.structured.$opencode.result.uri
      expect(Buffer.byteLength(tool.state.content[0].text, "utf8")).toBeLessThanOrEqual(50 * 1024)
      expect(tool.state.content).toHaveLength(1)
      expect(tool.state.structured.$opencode.text).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
        mime: "text/plain",
      })
      expect(tool.state.result.value).toEqual({ $opencode: { text: tool.state.structured.$opencode.result } })
      expect(tool.state.structured.$opencode.result).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
      })
      expect(toolResultURI).toBe(toolTextURI)
      expect(tool.state.structured.value[5].submatches[0].text).toBe("file://")
      expect(tool.state.structured.value[44].submatches[1].text).toBe("file://")

      const eventRow = candidate.query<{ readonly data: string }, []>("SELECT data FROM event WHERE id = 'evt_tool'").get()!
      const event = decodeStoredEventData(JSON.parse(eventRow.data))
      const eventTextURI = (event.structured as { $opencode: { text: { uri: string } } }).$opencode.text.uri
      const eventResultURI = (event.structured as { $opencode: { result: { uri: string } } }).$opencode.result.uri
      expect(Buffer.byteLength((event.content as Array<{ text: string }>)[0]!.text, "utf8")).toBeLessThanOrEqual(
        50 * 1024,
      )
      expect((event.structured as { $opencode: { text: unknown } }).$opencode.text).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
      })
      expect((event.structured as { $opencode: { result: unknown } }).$opencode.result).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
      })
      expect(event.result).toEqual({
        type: "text",
        value: { $opencode: { text: (event.structured as { $opencode: { result: unknown } }).$opencode.result } },
      })
      expect(eventTextURI).toBe(toolTextURI)
      expect(eventResultURI).toBe(toolResultURI)
      expect(legacyOutputURI).toBe(eventTextURI)
      const metadataEvent = decodeStoredEventData(
        JSON.parse(
          candidate
            .query<{ readonly data: string }, []>("SELECT data FROM event WHERE id = 'evt_legacy_metadata'")
            .get()!.data,
        ),
      )
      expect((metadataEvent.structured as { $opencode: { uri: string } }).$opencode.uri).toBe(
        legacyMetadataURI,
      )
      expect(
        (event.structured as { value: Array<{ submatches?: Array<{ text?: string }> }> }).value[5]!.submatches?.[0]
          ?.text,
      ).toBe("file://")
      expect(
        (event.structured as { value: Array<{ submatches?: Array<{ text?: string }> }> }).value[44]!.submatches?.[1]
          ?.text,
      ).toBe("file://")

      const checkpointRow = candidate.query<{ readonly data: string }, []>("SELECT data FROM event_checkpoint").get()!
      const checkpoint = decodeStoredEventData(JSON.parse(checkpointRow.data))
      expect((checkpoint.baseline as { data: { image: string } }).data.image).toMatch(
        /^attachment:\/\/att_[0-9a-f]{32}$/,
      )
      expect(JSON.stringify(checkpoint)).not.toContain("data:image/png;base64,")

      const occurrencePaths = candidate
        .query<{ readonly json_path: string }, []>(
          "SELECT json_path FROM _content_migration_occurrence ORDER BY table_name, rowid, json_path",
        )
        .all()
        .map((row) => row.json_path)
      expect(occurrencePaths).toContain("$/state/metadata/$opencode/output")
      expect(occurrencePaths).toContain("$/state/metadata")
      expect(occurrencePaths).toContain("$/content/0/state/structured/$opencode/text")
      expect(occurrencePaths).toContain("$/content/0/state/structured/$opencode/result")
      expect(occurrencePaths).toContain("$/structured/$opencode/text")
      expect(occurrencePaths).toContain("$/structured/$opencode/result")
      expect(occurrencePaths).toContain("$/baseline/data/image")
    } finally {
      candidate.close()
    }

    expect(await Bun.file(`${manifest.stagingDatabase}-wal`).exists()).toBeFalse()
    const copiedDatabase = path.join(path.dirname(fixture.staging), "complete-candidate-copy.db")
    await copyFile(manifest.stagingDatabase, copiedDatabase)
    const copied = new Database(copiedDatabase, { readonly: true, strict: true })
    try {
      expect(
        copied.query<{ readonly count: number }, []>("SELECT count(*) AS count FROM attachment").get()?.count,
      ).toBe(3)
      const row = copied.query<{ readonly data: string }, []>("SELECT data FROM event_checkpoint").get()!
      const checkpoint = decodeStoredEventData(JSON.parse(row.data))
      expect((checkpoint.baseline as { data: { image: string } }).data.image).toMatch(
        /^attachment:\/\/att_[0-9a-f]{32}$/,
      )
    } finally {
      copied.close()
    }
  })

  test("externalizes legacy tool text above the provider context preview limit", async () => {
    const fixture = await createToolOutputFixture()
    const text = `medium-${"x".repeat(MAX_CONTENT_PREVIEW_BYTES)}`
    const source = new Database(fixture.database, { strict: true })
    try {
      source.run("INSERT INTO part VALUES (?, ?, ?, ?)", [
        "prt_medium_tool_output",
        "msg_v2",
        "ses_tool",
        JSON.stringify({
          type: "tool",
          callID: "call_medium",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: text,
            title: "Medium output",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        }),
      ])
    } finally {
      source.close()
    }

    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })
    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const row = candidate
        .query<{ readonly data: string }, []>("SELECT data FROM part WHERE id = 'prt_medium_tool_output'")
        .get()!
      const part = JSON.parse(row.data)
      const uri = part.state.metadata.$opencode.output.uri
      expect(Buffer.byteLength(part.state.output, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_CONTENT_PREVIEW_BYTES)
      expect(part.state.metadata.$opencode.output).toMatchObject({
        type: "content-reference",
        uri: expect.stringMatching(/^attachment:\/\/att_[0-9a-f]{32}$/),
        mime: "text/plain",
        sizeBytes: Buffer.byteLength(text, "utf8"),
      })
      expect(typeof uri).toBe("string")
      const attachmentID = uri.slice("attachment://".length)
      const attachment = candidate
        .query<{ readonly storage_path: string }, [string]>("SELECT storage_path FROM attachment WHERE id = ?")
        .get(attachmentID)!
      expect(await Bun.file(path.join(fixture.staging, attachment.storage_path)).text()).toBe(text)
    } finally {
      candidate.close()
    }
  })

  test("deduplicates exact legacy and V2 tool text above the persisted preview limit", async () => {
    const fixture = await createToolOutputFixture()
    const text = `exact-${"x".repeat(MAX_PERSISTED_CONTENT_PREVIEW_BYTES + 4_096)}`
    const source = new Database(fixture.database, { strict: true })
    try {
      source.run("INSERT INTO message VALUES (?, ?, ?)", ["msg_exact", "ses_tool", "{}"])
      source.run("INSERT INTO part VALUES (?, ?, ?, ?)", [
        "prt_exact_tool_output",
        "msg_exact",
        "ses_tool",
        JSON.stringify({
          type: "tool",
          callID: "call_exact",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: text,
            title: "Exact output",
            metadata: { output: text },
            time: { start: 1, end: 2 },
          },
        }),
      ])
      source.run("INSERT INTO session_message VALUES (?, ?, ?)", [
        "msg_exact",
        "ses_tool",
        JSON.stringify({
          content: [
            {
              type: "tool",
              id: "tool_exact",
              name: "bash",
              state: {
                status: "completed",
                input: {},
                content: [{ type: "text", text }],
                structured: {},
                outputPaths: [],
                result: { type: "text", value: text },
              },
            },
            {
              type: "tool",
              id: "tool_exact_output_only",
              name: "bash",
              state: {
                status: "completed",
                input: {},
                content: [{ type: "text", text }],
                structured: { output: text },
                outputPaths: [],
              },
            },
          ],
        }),
      ])
    } finally {
      source.close()
    }

    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })
    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const legacy = JSON.parse(
        candidate
          .query<{ readonly data: string }, []>("SELECT data FROM part WHERE id = 'prt_exact_tool_output'")
          .get()!.data,
      )
      expect(Buffer.byteLength(legacy.state.output, "utf8")).toBeLessThanOrEqual(
        MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
      )
      expect(Buffer.byteLength(legacy.state.metadata.output, "utf8")).toBeLessThanOrEqual(
        MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
      )

      const message = JSON.parse(
        candidate
          .query<{ readonly data: string }, []>("SELECT data FROM session_message WHERE id = 'msg_exact'")
          .get()!.data,
      )
      const tool = message.content[0]
      expect(Buffer.byteLength(tool.state.content[0].text, "utf8")).toBeLessThanOrEqual(
        MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
      )
      expect(tool.state.structured.$opencode.text.uri).toBe(tool.state.structured.$opencode.result.uri)
      expect(tool.state.structured.$opencode.text.uri).toBe(legacy.state.metadata.$opencode.output.uri)
      expect(tool.state.result.value).toEqual({ $opencode: { text: tool.state.structured.$opencode.result } })

      const outputOnly = message.content[1].state
      expect(Buffer.byteLength(outputOnly.content[0].text, "utf8")).toBeLessThanOrEqual(
        MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
      )
      expect(Buffer.byteLength(outputOnly.structured.output, "utf8")).toBeLessThanOrEqual(
        MAX_PERSISTED_CONTENT_PREVIEW_BYTES,
      )
      expect(outputOnly.structured.$opencode.text.uri).toMatch(/^attachment:\/\/att_[0-9a-f]{32}$/)

      const sha256 = createHash("sha256").update(text).digest("hex")
      expect(
        candidate
          .query<{ readonly count: number }, [string]>(
            "SELECT count(*) AS count FROM attachment WHERE blob_sha256 = ?",
          )
          .get(sha256)?.count,
      ).toBe(1)
      const attachment = candidate
        .query<{ readonly storage_path: string }, [string]>(
          "SELECT storage_path FROM attachment WHERE blob_sha256 = ?",
        )
        .get(sha256)!
      expect(await Bun.file(path.join(fixture.staging, attachment.storage_path)).text()).toBe(text)
    } finally {
      candidate.close()
    }
  })

  test("normalizes exact structured output before sharing large legacy and V2 metadata", async () => {
    const fixture = await createToolOutputFixture()
    const text = `structured-${"x".repeat(MAX_PERSISTED_CONTENT_PREVIEW_BYTES + 4_096)}`
    const metadata = { output: text, payload: "large-payload".repeat(24_000) }
    const source = new Database(fixture.database, { strict: true })
    try {
      source.run("INSERT INTO message VALUES (?, ?, ?)", ["msg_exact_structured", "ses_tool", "{}"])
      source.run("INSERT INTO part VALUES (?, ?, ?, ?)", [
        "prt_exact_structured",
        "msg_exact_structured",
        "ses_tool",
        JSON.stringify({
          type: "tool",
          callID: "call_exact_structured",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: text,
            title: "Exact structured output",
            metadata,
            time: { start: 1, end: 2 },
          },
        }),
      ])
      source.run("INSERT INTO session_message VALUES (?, ?, ?)", [
        "msg_exact_structured",
        "ses_tool",
        JSON.stringify({
          content: [
            {
              type: "tool",
              id: "tool_exact_structured",
              name: "bash",
              state: {
                status: "completed",
                input: {},
                content: [{ type: "text", text }],
                structured: metadata,
                outputPaths: [],
                result: { type: "text", value: text },
              },
            },
          ],
        }),
      ])
    } finally {
      source.close()
    }

    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })
    expect(manifest.status).toBe("complete")
    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const legacy = JSON.parse(
        candidate.query<{ readonly data: string }, []>("SELECT data FROM part WHERE id = 'prt_exact_structured'").get()!
          .data,
      )
      const message = JSON.parse(
        candidate
          .query<{ readonly data: string }, []>("SELECT data FROM session_message WHERE id = 'msg_exact_structured'")
          .get()!.data,
      )
      const tool = message.content[0]
      expect(legacy.state.metadata.$opencode.uri).toBe(tool.state.structured.$opencode.uri)
      expect(legacy.state.metadata.$opencode.output.uri).toBe(tool.state.structured.$opencode.text.uri)
      expect(tool.state.structured.$opencode.text.uri).toBe(tool.state.structured.$opencode.result.uri)
      expect(tool.state.result.value).toEqual({ $opencode: { text: tool.state.structured.$opencode.result } })

      const attachmentID = tool.state.structured.$opencode.uri.slice("attachment://".length)
      const attachment = candidate
        .query<{ readonly storage_path: string }, [string]>("SELECT storage_path FROM attachment WHERE id = ?")
        .get(attachmentID)!
      const stored = JSON.parse(await Bun.file(path.join(fixture.staging, attachment.storage_path)).text())
      expect(stored.payload).toBe(metadata.payload)
      expect(Buffer.byteLength(stored.output, "utf8")).toBeLessThanOrEqual(MAX_PERSISTED_CONTENT_PREVIEW_BYTES)
    } finally {
      candidate.close()
    }
  })

  test("keeps malformed checkpoint data URLs quarantined at their exact decoded path", async () => {
    const fixture = await createToolOutputFixture({ malformedCheckpoint: true })
    const manifest = await migrateLegacyContent({
      mode: "stage",
      sourceDatabase: fixture.database,
      stagingDirectory: fixture.staging,
    })

    expect(manifest.status).toBe("quarantined")
    expect(manifest.quarantine).toContainEqual(
      expect.objectContaining({ table: "event_checkpoint", path: "$/baseline/data/image", kind: "data" }),
    )
    const candidate = new Database(manifest.stagingDatabase, { readonly: true, strict: true })
    try {
      const row = candidate.query<{ readonly data: string }, []>("SELECT data FROM event_checkpoint").get()!
      const checkpoint = decodeStoredEventData(JSON.parse(row.data))
      expect((checkpoint.baseline as { data: { image: string } }).data.image).toBe("data:image/png;base64,%%%%")
    } finally {
      candidate.close()
    }
  })
})

async function createToolOutputFixture(options?: { readonly malformedCheckpoint?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-content-output-migration-"))
  directories.push(root)
  const source = path.join(root, "source")
  const staging = path.join(root, "staging")
  await mkdir(source)
  const database = path.join(source, "opencode.db")
  const large = "🙂 tool output line\n".repeat(20_000)
  const largeMetadata = { payload: "legacy structured metadata ".repeat(20_000) }
  const image = options?.malformedCheckpoint
    ? "data:image/png;base64,%%%%"
    : `data:image/png;base64,${Buffer.from("checkpoint-image").toString("base64")}`
  const sqlite = new Database(database, { create: true, strict: true })
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE event_checkpoint (
      aggregate_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      version INTEGER NOT NULL,
      data TEXT NOT NULL,
      time_created INTEGER NOT NULL
    );
  `)
  sqlite.run("INSERT INTO session VALUES (?)", ["ses_tool"])
  sqlite.run("INSERT INTO message VALUES (?, ?, ?)", ["msg_v2", "ses_tool", "{}"])
  sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?)", [
    "prt_tool",
    "msg_v2",
    "ses_tool",
    JSON.stringify({
      type: "tool",
      callID: "call_legacy",
      tool: "bash",
      state: {
        status: "completed",
        input: {},
        output: large,
        title: "Legacy output",
        metadata: largeMetadata,
        time: { start: 1, end: 2 },
      },
    }),
  ])
  sqlite.run("INSERT INTO session_message VALUES (?, ?, ?)", [
    "msg_v2",
    "ses_tool",
    JSON.stringify({
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      content: [
        {
          type: "tool",
          id: "tool_v2",
          name: "bash",
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: large.slice(0, 180_000) },
              { type: "text", text: large.slice(180_000) },
            ],
            structured: { value: searchSubmatches() },
            outputPaths: [],
            result: { type: "text", value: large },
          },
          time: { created: 1, ran: 1, completed: 2 },
        },
      ],
      time: { created: 1, completed: 2 },
    }),
  ])
  sqlite.run("INSERT INTO event_sequence VALUES (?, ?, NULL)", ["ses_tool", 0])
  sqlite.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", [
    "evt_tool",
    "ses_tool",
    0,
    "session.next.tool.success.1",
    JSON.stringify(
      encodeStoredEventData({
        timestamp: 1,
        sessionID: "ses_tool",
        assistantMessageID: "msg_v2",
        callID: "call_event",
        structured: { value: searchSubmatches() },
        content: [{ type: "text", text: large }],
        result: { type: "text", value: large },
      }),
    ),
  ])
  sqlite.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", [
    "evt_legacy_metadata",
    "ses_tool",
    1,
    "session.next.tool.success.1",
    JSON.stringify(
      encodeStoredEventData({
        timestamp: 2,
        sessionID: "ses_tool",
        assistantMessageID: "msg_v2",
        callID: "call_legacy",
        structured: largeMetadata,
        content: [{ type: "text", text: "done" }],
        result: { type: "text", value: "done" },
      }),
    ),
  ])
  sqlite.run("INSERT INTO event_checkpoint VALUES (?, ?, ?, ?, ?)", [
    "ses_tool",
    0,
    2,
    JSON.stringify(
      encodeStoredEventData({
        baseline: { adapter: "session-projection", version: 1, data: { image, padding: "x".repeat(8_000) } },
        baselineHash: "baseline",
        eventHash: "events",
      }),
    ),
    Date.now(),
  ])
  sqlite.close()
  return { database, staging }
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-content-migration-"))
  directories.push(root)
  const source = path.join(root, "source")
  const staging = path.join(root, "staging")
  await mkdir(source)
  const database = path.join(source, "opencode.db")
  const file = path.join(root, "source-attachment.txt")
  await Bun.write(file, "immutable file attachment")
  const missingURI = pathToFileURL(path.join(root, "missing.pdf")).href
  const data = `data:image/png;base64,${Buffer.from("same-image-bytes").toString("base64")}`
  const sqlite = new Database(database, { create: true, strict: true })
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE session_input (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, prompt TEXT NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE session_file_blob (sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content BLOB NOT NULL);
    CREATE TABLE session_file_mutation (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      before_sha256 TEXT,
      after_sha256 TEXT
    );
  `)
  sqlite.run("INSERT INTO session VALUES (?)", ["ses_one"])
  sqlite.run("INSERT INTO message VALUES (?, ?, ?)", ["msg_legacy", "ses_one", "{}"])
  sqlite.run("INSERT INTO session_input VALUES (?, ?, ?)", [
    "msg_input",
    "ses_one",
    JSON.stringify({
      files: [
        { uri: data, mime: "image/png", name: "image.png" },
        { uri: pathToFileURL(file).href, mime: "text/plain", name: "source.txt" },
        { uri: missingURI, mime: "application/pdf", name: "missing.pdf" },
      ],
    }),
  ])
  sqlite.run("INSERT INTO session_message VALUES (?, ?, ?)", [
    "msg_v2",
    "ses_one",
    JSON.stringify({ image: data, structured: { text: "large structured output ".repeat(20_000) } }),
  ])
  sqlite.run("INSERT INTO part VALUES (?, ?, ?, ?)", [
    "prt_one",
    "msg_legacy",
    "ses_one",
    JSON.stringify({ uri: data, invalid: "data:image/png;base64,%%%%" }),
  ])
  sqlite.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", [
    "evt_one",
    "ses_one",
    0,
    "message.part.updated.1",
    JSON.stringify({ sessionID: "ses_one", nested: { uri: data } }),
  ])
  const mutation = Buffer.from("same-image-bytes")
  const mutationHash = createHash("sha256").update(mutation).digest("hex")
  sqlite.run("INSERT INTO session_file_blob VALUES (?, ?, ?)", [mutationHash, mutation.byteLength, mutation])
  sqlite.run("INSERT INTO session_file_mutation VALUES (?, ?, ?, ?)", [
    "mutation_one",
    "ses_one",
    mutationHash,
    mutationHash,
  ])
  sqlite.close()
  return { root, database, staging, missingURI }
}

async function createDualWrittenAttachmentFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-content-dual-write-"))
  directories.push(root)
  const source = path.join(root, "source")
  await mkdir(source)
  const database = path.join(source, "opencode.db")
  const staging = path.join(root, "staging")
  const sqlite = new Database(database, { create: true, strict: true })
  sqlite.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
    INSERT INTO session VALUES ('ses_dual_write');
  `)
  const structured = { text: "shared structured output ".repeat(20_000) }
  sqlite.run("INSERT INTO session_message VALUES (?, ?, ?)", [
    "msg_dual_write",
    "ses_dual_write",
    JSON.stringify({ structured }),
  ])
  sqlite.run("INSERT INTO event VALUES (?, ?, ?, ?, ?)", [
    "evt_dual_write",
    "ses_dual_write",
    0,
    "session.next.tool.success.1",
    JSON.stringify(
      encodeStoredEventData({ sessionID: "ses_dual_write", assistantMessageID: "msg_dual_write", structured }),
    ),
  ])
  sqlite.close()
  return { database, staging }
}

async function createMessageFixture(payloads: ReadonlyArray<unknown>) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-content-candidate-migration-"))
  directories.push(root)
  const source = path.join(root, "source")
  const staging = path.join(root, "staging")
  await mkdir(source)
  const database = path.join(source, "opencode.db")
  const sqlite = new Database(database, { create: true, strict: true })
  sqlite.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
    INSERT INTO session VALUES ('ses_candidates');
  `)
  const insert = sqlite.prepare("INSERT INTO session_message VALUES (?, 'ses_candidates', ?)")
  sqlite.transaction(() =>
    payloads.forEach((payload, index) => insert.run(`msg_${String(index).padStart(4, "0")}`, JSON.stringify(payload))),
  )()
  sqlite.close()
  return { root, database, staging }
}

async function createEventFixture(count: number) {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-content-event-migration-"))
  directories.push(root)
  const source = path.join(root, "source")
  const staging = path.join(root, "staging")
  await mkdir(source)
  const database = path.join(source, "opencode.db")
  const sqlite = new Database(database, { create: true, strict: true })
  sqlite.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL
    );
    INSERT INTO session VALUES ('ses_event_cache');
  `)
  const insert = sqlite.prepare("INSERT INTO event VALUES (?, 'ses_event_cache', ?, 'fixture', ?)")
  sqlite.transaction(() =>
    Array.from({ length: count }, (_, index) =>
      insert.run(`evt_${String(index).padStart(4, "0")}`, index, JSON.stringify({ index })),
    ),
  )()
  sqlite.close()
  return { root, database, staging }
}

function searchSubmatches() {
  return Array.from({ length: 45 }, (_, index) =>
    index === 5
      ? { submatches: [{ text: "file://" }] }
      : index === 44
        ? { submatches: [{ text: "unrelated" }, { text: "file://" }] }
        : {},
  )
}

function readPayloads(filename: string) {
  const database = new Database(filename, { readonly: true, strict: true })
  try {
    return [
      database.query<{ readonly prompt: string }, []>("SELECT prompt FROM session_input").get()?.prompt,
      database.query<{ readonly data: string }, []>("SELECT data FROM session_message").get()?.data,
      database.query<{ readonly data: string }, []>("SELECT data FROM part").get()?.data,
      database.query<{ readonly data: string }, []>("SELECT data FROM event").get()?.data,
      database.query<{ readonly content: Uint8Array }, []>("SELECT content FROM session_file_blob").get()?.content,
    ]
  } finally {
    database.close()
  }
}

async function hash(filename: string) {
  return createHash("sha256")
    .update(Buffer.from(await Bun.file(filename).arrayBuffer()))
    .digest("hex")
}
