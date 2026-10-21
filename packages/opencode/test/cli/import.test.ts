import { test, expect } from "bun:test"
import {
  parseShareUrl,
  persistImportedSession,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ExportData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { ContentStore } from "@opencode-ai/core/content-store"
import { ContentBlobTable, AttachmentTable } from "@opencode-ai/core/attachment.sql"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Exit, Layer } from "effect"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})

test("externalizes imported legacy images with session binding and blob deduplication", async () => {
  await using tmp = await tmpdir()
  const database = Database.layerFromPath(path.join(tmp.path, "import.sqlite")).pipe(Layer.fresh)
  const global = Global.layerWith({ data: tmp.path })
  const content = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(global),
  )
  const sessionID = SessionSchema.ID.make("ses_import_attachments")
  const bytes = Buffer.from("same imported image")
  const dataURI = `data:image/png;base64,${bytes.toString("base64")}`

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject(tmp.path)
      yield* persistImportedSession(importData(sessionID, [dataURI, dataURI], dataURI), {
        projectID: Project.ID.global,
        directory: tmp.path,
        worktree: tmp.path,
      })

      const parts = yield* db.select().from(PartTable).orderBy(PartTable.id).all()
      expect(parts).toHaveLength(2)
      expect(
        parts.every(
          (part) =>
            part.data.type === "file" &&
            "url" in part.data &&
            typeof part.data.url === "string" &&
            part.data.url.startsWith("attachment://"),
        ),
      ).toBe(true)
      expect(JSON.stringify(parts)).not.toContain("data:image/png;base64,")
      const messages = yield* db.select().from(MessageTable).orderBy(MessageTable.id).all()
      expect(messages).toHaveLength(2)
      expect(JSON.stringify(messages)).not.toContain("data:image/png;base64,")
      expect(JSON.stringify(messages)).toContain("attachment://")
      expect(yield* db.select().from(ContentBlobTable).all()).toHaveLength(1)
      const attachments = yield* db.select().from(AttachmentTable).orderBy(AttachmentTable.id).all()
      expect(attachments).toHaveLength(3)
      expect(attachments.every((attachment) => attachment.session_id === sessionID)).toBe(true)
      expect(new Set(attachments.map((attachment) => attachment.blob_sha256))).toEqual(
        new Set([attachments[0]!.blob_sha256]),
      )
      const first = parts[0]!.data
      if (!("url" in first) || typeof first.url !== "string") throw new Error("expected imported file part")
      const resolved = yield* (yield* ContentStore.Service).resolve({ uri: first.url, sessionID })
      expect(resolved?.bytes).toEqual(new Uint8Array(bytes))
    }).pipe(Effect.provide(Layer.mergeAll(database, content))),
  )
})

test("rejects a missing imported file before writing legacy session rows", async () => {
  await using tmp = await tmpdir()
  const database = Database.layerFromPath(path.join(tmp.path, "missing.sqlite")).pipe(Layer.fresh)
  const global = Global.layerWith({ data: tmp.path })
  const content = ContentStore.layer.pipe(
    Layer.provide(database),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(global),
  )
  const sessionID = SessionSchema.ID.make("ses_import_missing")

  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seedProject(tmp.path)
      const exit = yield* Effect.exit(
        persistImportedSession(importData(sessionID, [pathToFileURL(path.join(tmp.path, "missing.png")).href]), {
          projectID: Project.ID.global,
          directory: tmp.path,
          worktree: tmp.path,
        }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* db.select().from(SessionTable).all()).toHaveLength(0)
      expect(yield* db.select().from(MessageTable).all()).toHaveLength(0)
      expect(yield* db.select().from(PartTable).all()).toHaveLength(0)
      expect(yield* db.select().from(AttachmentTable).all()).toHaveLength(0)
      expect(yield* db.select().from(ContentBlobTable).all()).toHaveLength(0)
    }).pipe(Effect.provide(Layer.mergeAll(database, content))),
  )
})

function seedProject(directory: string) {
  return Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({
        id: Project.ID.global,
        worktree: AbsolutePath.make(directory),
        sandboxes: [],
        time_created: 0,
        time_updated: 0,
      })
      .run(),
  )
}

function importData(sessionID: SessionSchema.ID, uris: string[], messageURI?: string) {
  return {
    info: {
      id: sessionID,
      slug: sessionID,
      projectID: Project.ID.global,
      directory: "C:/source",
      title: "Imported attachments",
      version: "test",
      time: { created: 1, updated: 1 },
    },
    messages: [
      {
        info: {
          id: "msg_import_attachments",
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5.6" },
        },
        parts: uris.map((url, index) => ({
          id: `prt_import_${index}`,
          sessionID,
          messageID: "msg_import_attachments",
          type: "file",
          mime: "image/png",
          filename: `image-${index}.png`,
          url,
        })),
      },
      ...(messageURI
        ? [
            {
              info: {
                id: "msg_import_assistant",
                sessionID,
                role: "assistant",
                time: { created: 2, completed: 2 },
                parentID: "msg_import_attachments",
                modelID: "gpt-5.6",
                providerID: "openai",
                mode: "build",
                agent: "build",
                path: { cwd: "C:/source", root: "C:/source" },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                structured: { image: { uri: messageURI, mime: "image/png" } },
              },
              parts: [],
            },
          ]
        : []),
    ],
  } as unknown as ExportData
}
