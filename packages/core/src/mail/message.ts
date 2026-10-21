import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import MailComposer from "nodemailer/lib/mail-composer"

export type Outgoing = {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  html?: string
  attachments?: string[]
  inReplyTo?: string
  references?: string[]
}

const maxMessageBytes = 20 * 1024 * 1024

export async function prepare(message: Outgoing) {
  if (!message.from || !message.to.length || !message.subject.trim() || !message.text.trim())
    throw new Error("Sender, recipient, subject and body are required")
  if ([message.from, ...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].some((address) => !validEmail(address)))
    throw new Error("Invalid email address")
  if ([message.subject, message.inReplyTo ?? "", ...(message.references ?? [])].some((header) => /[\r\n]/.test(header)))
    throw new Error("Invalid mail header")
  if (Buffer.byteLength(message.text) + Buffer.byteLength(message.html ?? "") > maxMessageBytes / 2)
    throw new Error("Mail body exceeds the size limit")

  const paths = message.attachments ?? []
  if (paths.length > 30) throw new Error("Too many attachments")
  const sizes = await Promise.all(paths.map(async (filename) => {
    const info = await stat(filename)
    if (!info.isFile()) throw new Error("Attachment is not a file")
    return info.size
  }))
  if (sizes.reduce((total, size) => total + size, 0) > maxMessageBytes / 2) throw new Error("Attachments exceed the size limit")
  const files = await Promise.all(paths.map(async (filename, index) => {
    const content = await readBounded(filename, sizes[index]!)
    return { filename: basename(filename), path: filename, content, hash: createHash("sha256").update(content).digest("hex") }
  }))
  const id = `<${crypto.randomUUID()}@opencode.local>`
  const composer = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    // The SMTP envelope contains Bcc, but the message given to recipients must not.
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: files.map((file) => ({ filename: file.filename, content: file.content })),
    messageId: id,
    inReplyTo: message.inReplyTo,
    references: message.references,
  })
  const raw = await new Promise<Buffer>((resolve, reject) => composer.compile().build((error, content) =>
    error ? reject(error) : resolve(content),
  ))
  if (raw.byteLength > maxMessageBytes) throw new Error("Mail exceeds the 20 MiB encoded size limit")
  return {
    raw,
    messageID: id,
    envelope: { from: message.from, to: [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])] },
    files: files.map((file) => ({ path: file.path, name: file.filename, size: file.content.byteLength, hash: file.hash })),
  }
}

export async function verifyFiles(files: Awaited<ReturnType<typeof prepare>>["files"]) {
  return Promise.all(files.map(async (file) => {
    const info = await stat(file.path)
    if (!info.isFile() || info.size !== file.size) throw new Error(`Attachment changed: ${file.name}`)
    const content = await readBounded(file.path, file.size)
    if (content.byteLength !== file.size || createHash("sha256").update(content).digest("hex") !== file.hash)
      throw new Error(`Attachment changed: ${file.name}`)
  }))
}

export async function readBounded(filename: string, limit: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of createReadStream(filename, { highWaterMark: 64 * 1024 })) {
    bytes += chunk.byteLength
    if (bytes > limit) throw new Error("Attachment changed or exceeds the size limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, bytes)
}

function validEmail(value: string) {
  return value.trim() === value && !/[\r\n\s<>]/.test(value) && /^[^@]+@[^@]+\.[^@]+$/.test(value)
}
