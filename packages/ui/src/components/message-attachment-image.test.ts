import { expect, test } from "bun:test"
import path from "node:path"

test("timeline attachment image component renders only the bounded preview URL", async () => {
  const source = await Bun.file(path.join(import.meta.dir, "message-attachment-image.tsx")).text()
  const messagePart = await Bun.file(path.join(import.meta.dir, "message-part.tsx")).text()

  expect(source).toContain('data.resolveMediaUrl?.(part, "preview") ?? previewUrl(part)')
  expect(source).not.toContain("contentUrl")
  expect(messagePart.match(/<MessageAttachmentImage/g)).toHaveLength(2)
  expect(messagePart).toContain('data.resolveMediaUrl?.(part, "content") ?? contentUrl(part)')
  expect(messagePart).toContain('data-slot="user-message-attachment-video"')
  expect(messagePart).toContain('data-slot="user-message-attachment-audio"')
  expect(messagePart).toContain('data-slot="user-message-attachment-file"')
})
