import { ContentStore } from "@opencode-ai/core/content-store"
import { Global } from "@opencode-ai/core/global"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { randomFillSync } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"
import { AttachmentPreview } from "../../src/attachment/preview"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>
const storedPaths = new Set<string>()

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  await Promise.all(Array.from(storedPaths, (item) => rm(item, { force: true })))
  storedPaths.clear()
})

describe("attachment content HttpApi", () => {
  test("streams session-bound managed content with range support", async () => {
    const sessionID = SessionV2.ID.make("ses_http_attachment")
    const messageID = SessionMessage.ID.make("msg_http_attachment")
    const create = await HttpApiApp.webHandler().handler(
      new Request("http://localhost/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: sessionID, location: { directory: process.cwd() } }),
      }),
      context,
    )
    expect({ status: create.status, type: create.headers.get("content-type"), body: await create.clone().text() }).toEqual(
      expect.objectContaining({ status: 200, type: expect.stringContaining("application/json") }),
    )
    const prompt = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: messageID,
          prompt: {
            text: "attachment",
            files: [{ uri: "data:text/plain;base64,aGVsbG8=", mime: "text/plain", name: "hello.txt" }],
          },
          resume: false,
        }),
      }),
      context,
    )
    expect({ status: prompt.status, type: prompt.headers.get("content-type"), body: await prompt.clone().text() }).toEqual(
      expect.objectContaining({ status: 200, type: expect.stringContaining("application/json") }),
    )
    const sha256 = new Bun.CryptoHasher("sha256").update("hello").digest("hex")
    const id =
      "att_" +
      new Bun.CryptoHasher("sha256")
        .update([sessionID, messageID, "0", sha256].join("\0"))
        .digest("hex")
        .slice(0, 32)
    storedPaths.add(path.join(Global.Path.data, ContentStore.MANAGED_DIRECTORY, sha256.slice(0, 2), sha256))
    const route = `/app/attachment/content/${encodeURIComponent(id)}?sessionID=${encodeURIComponent(sessionID)}`

    const full = await HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`), context)
    expect({ status: full.status, body: full.status === 200 ? undefined : await full.text() }).toEqual({
      status: 200,
      body: undefined,
    })
    expect(full.headers.get("accept-ranges")).toBe("bytes")
    expect(full.headers.get("content-type")).toStartWith("text/plain")
    expect(await full.text()).toBe("hello")

    const range = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${route}`, { headers: { range: "bytes=1-3" } }),
      context,
    )
    expect(range.status).toBe(206)
    expect(range.headers.get("content-range")).toBe("bytes 1-3/5")
    expect(await range.text()).toBe("ell")

    const otherSession = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost/app/attachment/content/${id}?sessionID=ses_other`),
      context,
    )
    expect(otherSession.status).toBe(404)

    const invalid = await HttpApiApp.webHandler().handler(
      new Request(`http://localhost${route}`, { headers: { range: "bytes=10-20" } }),
      context,
    )
    expect(invalid.status).toBe(416)
    expect(invalid.headers.get("content-range")).toBe("bytes */5")
  }, { timeout: 30_000 })

  test(
    "serves real bounded image thumbnails without exposing another session",
    async () => {
      expect(() => AttachmentPreview.cachePath("../outside", "image/png")).toThrow()
      const sessionID = SessionV2.ID.make("ses_http_image_preview")
      const messageID = SessionMessage.ID.make("msg_http_image_preview")
      const photon = await import("@silvia-odwyer/photon-node")
      const pixels = new Uint8Array(720 * 720 * 4)
      randomFillSync(pixels)
      const source = new photon.PhotonImage(pixels, 720, 720)
      const bytes = new Uint8Array(source.get_bytes())
      source.free()
      expect(bytes.byteLength).toBeGreaterThan(AttachmentPreview.MAX_BYTES)
      await submitFiles(sessionID, messageID, [
        { uri: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`, mime: "image/png", name: "large.png" },
      ])
      const attachment = managedAttachment(sessionID, messageID, 0, bytes)
      storedPaths.add(attachment.path)
      storedPaths.add(AttachmentPreview.cachePath(attachment.sha256, "image/png"))
      storedPaths.add(AttachmentPreview.cachePath(attachment.sha256, "image/jpeg"))
      const route = `/app/attachment/preview/${attachment.id}?sessionID=${sessionID}`

      const response = await HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`), context)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toMatch(/^image\/(?:png|jpeg)$/)
      expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable")
      expect(response.headers.get("x-opencode-attachment-mime")).toBe("image/png")
      expect(response.headers.get("x-opencode-attachment-size")).toBe(String(bytes.byteLength))
      expect(response.headers.get("x-opencode-preview-representation")).toBe("thumbnail")
      expect(response.headers.get("x-opencode-preview-truncated")).toBe("true")
      const preview = new Uint8Array(await response.arrayBuffer())
      expect(preview.byteLength).toBeLessThanOrEqual(AttachmentPreview.MAX_BYTES)
      expect(preview.byteLength).toBeLessThan(bytes.byteLength)
      const decoded = photon.PhotonImage.new_from_byteslice(preview)
      expect(decoded.get_width()).toBeLessThanOrEqual(512)
      expect(decoded.get_height()).toBeLessThanOrEqual(512)
      decoded.free()

      const otherSession = await HttpApiApp.webHandler().handler(
        new Request(`http://localhost/app/attachment/preview/${attachment.id}?sessionID=ses_other`),
        context,
      )
      expect(otherSession.status).toBe(404)

      const fullRange = await HttpApiApp.webHandler().handler(
        new Request(`http://localhost/app/attachment/content/${attachment.id}?sessionID=${sessionID}`, {
          headers: { range: "bytes=0-31" },
        }),
        context,
      )
      expect(fullRange.status).toBe(206)
      expect(new Uint8Array(await fullRange.arrayBuffer())).toEqual(bytes.slice(0, 32))
    },
    { timeout: 60_000 },
  )

  test(
    "bounds large text and PDF previews while full content remains range-addressable",
    async () => {
      const sessionID = SessionV2.ID.make("ses_http_file_preview")
      const messageID = SessionMessage.ID.make("msg_http_file_preview")
    const textBytes = new TextEncoder().encode("x".repeat(AttachmentPreview.MAX_BYTES * 4 + 17))
    const pdfBytes = new TextEncoder().encode(`%PDF-1.7\n${"0".repeat(AttachmentPreview.MAX_BYTES * 2)}\n%%EOF`)
      await submitFiles(sessionID, messageID, [
        {
          uri: `data:text/plain;base64,${Buffer.from(textBytes).toString("base64")}`,
          mime: "text/plain",
          name: "large.txt",
        },
        {
          uri: `data:application/pdf;base64,${Buffer.from(pdfBytes).toString("base64")}`,
          mime: "application/pdf",
          name: "large.pdf",
        },
      ])

      for (const [ordinal, bytes, mime] of [
        [0, textBytes, "text/plain"],
        [1, pdfBytes, "application/pdf"],
      ] as const) {
        const attachment = managedAttachment(sessionID, messageID, ordinal, bytes)
        storedPaths.add(attachment.path)
        const preview = await HttpApiApp.webHandler().handler(
          new Request(`http://localhost/app/attachment/preview/${attachment.id}?sessionID=${sessionID}`),
          context,
        )
        expect(preview.status).toBe(200)
        expect(preview.headers.get("content-type")).toStartWith(mime)
        expect(preview.headers.get("x-opencode-preview-source-range")).toBe(
          `bytes 0-${AttachmentPreview.MAX_BYTES - 1}/${bytes.byteLength}`,
        )
        expect(preview.headers.get("x-opencode-preview-representation")).toBe("prefix")
        expect((await preview.arrayBuffer()).byteLength).toBe(AttachmentPreview.MAX_BYTES)

        const tail = await HttpApiApp.webHandler().handler(
          new Request(`http://localhost/app/attachment/content/${attachment.id}?sessionID=${sessionID}`, {
            headers: { range: `bytes=${bytes.byteLength - 16}-${bytes.byteLength - 1}` },
          }),
          context,
        )
        expect(tail.status).toBe(206)
        expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(-16))
      }
    },
    { timeout: 30_000 },
  )
})

async function submitFiles(
  sessionID: SessionV2.ID,
  messageID: SessionMessage.ID,
  files: Array<{ readonly uri: string; readonly mime: string; readonly name: string }>,
) {
  const create = await HttpApiApp.webHandler().handler(
    new Request("http://localhost/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sessionID, location: { directory: process.cwd() } }),
    }),
    context,
  )
  expect(create.status).toBe(200)
  const prompt = await HttpApiApp.webHandler().handler(
    new Request(`http://localhost/api/session/${sessionID}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: messageID, prompt: { text: "attachment", files }, resume: false }),
    }),
    context,
  )
  expect({ status: prompt.status, body: prompt.status === 200 ? undefined : await prompt.text() }).toEqual({
    status: 200,
    body: undefined,
  })
}

function managedAttachment(sessionID: string, messageID: string, ordinal: number, bytes: Uint8Array) {
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  return {
    id:
      "att_" +
      new Bun.CryptoHasher("sha256")
        .update([sessionID, messageID, String(ordinal), sha256].join("\0"))
        .digest("hex")
        .slice(0, 32),
    sha256,
    path: path.join(Global.Path.data, ContentStore.MANAGED_DIRECTORY, sha256.slice(0, 2), sha256),
  }
}
