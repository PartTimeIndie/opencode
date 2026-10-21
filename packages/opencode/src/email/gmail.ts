import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

type Credentials = {
  client_id: string
  client_secret: string
  refresh_token: string
}

type Attachment = {
  path: string
  name: string
  size: number
  contentType: string
  content: string
}

type MessageBodies = {
  plain: string
  html: string
  encoded: string
}

type GmailMessage = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  attachments: string[]
}

type RecipientCache = {
  version: 1
  updatedAt: number
  recipients: RecipientCacheEntry[]
}

type RecipientCacheEntry = {
  email: string
  name?: string
  count: number
  lastSeen: number
}

export type GmailFormMode = "send" | "draft"
export type GmailSendPhase = "preflight" | "unknown"

const defaultCredentials = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE ?? path.join(homedir(), ".config", "gws", "credentials-export.json")
const recipientCacheMaxAge = 12 * 60 * 60 * 1000
const sentScanLimit = 1000

// "preflight" failures happen strictly before any provider call: fixing the
// inputs and sending again cannot duplicate the message. "unknown" failures
// happen at or after the provider call: the message may or may not exist, so
// callers must never automatically retry.
export class GmailActionError extends Error {
  readonly phase: GmailSendPhase
  constructor(phase: GmailSendPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "GmailActionError"
    this.phase = phase
  }
}

export async function executeGmailFormAction(input: { mode: GmailFormMode; values: Record<string, unknown>; credentials?: string }) {
  const prepared = await prepareGmailMessage(input).catch((cause: unknown) => Promise.reject(new GmailActionError("preflight", cause)))
  return deliverGmailMessage(prepared, input.credentials).catch((cause: unknown) =>
    Promise.reject(cause instanceof GmailActionError ? cause : new GmailActionError("unknown", cause)),
  )
}

// Freezes the final submitted values: attachments are read and the MIME
// message is built exactly once, before any provider interaction. Later form
// edits cannot change what this preparation will deliver.
export async function prepareGmailMessage(input: { mode: GmailFormMode; values: Record<string, unknown> }) {
  const message = formMessage(input.values)
  const attachments = await Promise.all(message.attachments.map(readAttachment))
  const html = richTextHtml(message.body)
  const bodies = { plain: plainTextFromHtml(html), html, encoded: html }
  const raw = base64Url(buildMime(message, attachments, bodies))
  return { mode: input.mode, raw, message, attachments }
}

export type PreparedGmailMessage = Awaited<ReturnType<typeof prepareGmailMessage>>

export async function deliverGmailMessage(prepared: PreparedGmailMessage, credentialsPath?: string) {
  // A token refresh failure still means nothing was sent, so it stays a
  // preflight failure even though it performs network IO.
  const accessToken = await getAccessToken(credentialsPath ?? defaultCredentials).catch(
    (cause: unknown) => Promise.reject(new GmailActionError("preflight", cause)),
  )
  const response =
    prepared.mode === "draft"
      ? await createDraft(accessToken, prepared.raw)
      : await sendMessage(accessToken, prepared.raw)
  const messageID = responseMessageID(response, prepared.mode === "draft")
  return {
    mode: prepared.mode,
    messageID,
    draftID: prepared.mode === "draft" ? stringValue(response.id) : undefined,
    to: prepared.message.to,
    cc: prepared.message.cc,
    bcc: prepared.message.bcc,
    subject: prepared.message.subject,
    attachments: prepared.attachments.map((attachment) => ({
      path: attachment.path,
      name: attachment.name,
      size: attachment.size,
      contentType: attachment.contentType,
    })),
  }
}

export async function suggestGmailRecipients(input: { query: string; refresh?: boolean; credentials?: string }) {
  const cache = await loadRecipientCache(input)
  const query = input.query.trim().toLowerCase()
  const tokens = query.split(/\s+/).filter(Boolean)
  return cache.recipients
    .map((recipient) => ({ recipient, score: recipientScore(recipient, tokens) }))
    .filter((item) => (tokens.length ? item.score > 0 : true))
    .sort((a, b) => b.score - a.score || b.recipient.lastSeen - a.recipient.lastSeen || a.recipient.email.localeCompare(b.recipient.email))
    .slice(0, 8)
    .map((item) => item.recipient)
}

function formMessage(values: Record<string, unknown>): GmailMessage {
  return {
    to: requiredEmailList(values.to, "to"),
    cc: emailList(values.cc, "cc"),
    bcc: emailList(values.bcc, "bcc"),
    subject: requiredHeaderText(values.subject, "subject"),
    body: requiredText(values.body, "body"),
    attachments: stringList(values.attachments),
  }
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`)
  return value
}

function requiredHeaderText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing ${field}`)
  return headerValue(field, value)
}

function requiredEmailList(value: unknown, field: string) {
  const list = emailList(value, field)
  if (!list.length) throw new Error(`Missing ${field}`)
  return list
}

function emailList(value: unknown, field: string) {
  return stringList(value)
    .flatMap((item) => item.split(/[;,]/))
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => safeEmail(item, field))
}

function stringList(value: unknown) {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string" && value.trim()) return [value]
  return []
}

async function readAttachment(filePath: string): Promise<Attachment> {
  const file = await stat(filePath).catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return undefined
    throw error
  })
  if (!file?.isFile()) throw new Error(`Attachment not found: ${filePath}`)
  return {
    path: filePath,
    name: fileName(filePath),
    size: file.size,
    contentType: contentType(filePath),
    content: foldBase64((await readFile(filePath)).toString("base64")),
  }
}

function buildMime(message: GmailMessage, attachments: Attachment[], bodies: MessageBodies) {
  const headers = [
    `To: ${headerValue("To", message.to.join(", "))}`,
    ...headerList("Cc", message.cc),
    ...headerList("Bcc", message.bcc),
    `Subject: ${encodedHeader(message.subject)}`,
    "MIME-Version: 1.0",
  ]

  if (!attachments.length) {
    const boundary = `opencode-alt-${crypto.randomUUID()}`
    return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", ...alternativeLines(boundary, bodies)].join("\r\n")
  }

  const boundary = `opencode-${crypto.randomUUID()}`
  const alternativeBoundary = `opencode-alt-${crypto.randomUUID()}`
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    "",
    ...alternativeLines(alternativeBoundary, bodies),
    ...attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${headerParamValue("attachment name", attachment.name)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${headerParamValue("attachment name", attachment.name)}"`,
      "",
      attachment.content,
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n")
}

function alternativeLines(boundary: string, bodies: MessageBodies) {
  return [
    `--${boundary}`,
    ...contentLines("text/plain", bodies.plain),
    `--${boundary}`,
    ...contentLines("text/html", bodies.html),
    `--${boundary}--`,
  ]
}

function contentLines(contentType: "text/plain" | "text/html", body: string) {
  return [`Content-Type: ${contentType}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", foldBase64(base64(body))]
}

function headerList(name: string, values: string[]) {
  return values.length ? [`${name}: ${headerValue(name, values.join(", "))}`] : []
}

function encodedHeader(value: string) {
  headerValue("Subject", value)
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${base64(value)}?=`
}

function safeEmail(value: string, field: string) {
  const safe = headerValue(field, value)
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(safe)) throw new Error(`Invalid recipient: ${safe}`)
  return safe
}

function headerValue(name: string, value: string) {
  if (/[\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) throw new Error(`Invalid ${name}: header values cannot contain control characters`)
  return value
}

function headerParamValue(name: string, value: string) {
  return headerValue(name, value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function richTextHtml(value: string) {
  const html = hasRichTextMarkup(value) ? sanitizeMessageHtml(value) : escapeHtml(value)
  return markdownSyntaxToHtml(html).replace(/\r\n|\r|\n/g, "<br>")
}

function hasRichTextMarkup(value: string) {
  if (/<\/?(?:a|b|br|div|em|i|li|ol|p|strong|u|ul)\b/i.test(value)) return true
  return /&(?:[a-z][a-z0-9]+|#[0-9]+|#x[0-9a-f]+);/i.test(value)
}

function markdownSyntaxToHtml(value: string) {
  return value
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
}

function sanitizeMessageHtml(value: string) {
  const allowed = new Set(["a", "b", "br", "div", "em", "i", "li", "ol", "p", "strong", "u", "ul"])
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name: string, attrs: string) => {
      const tagName = name.toLowerCase()
      if (!allowed.has(tagName)) return escapeHtml(tag)
      if (tag.startsWith("</")) return `</${tagName}>`
      if (tagName !== "a") return tagName === "br" ? "<br>" : `<${tagName}>`
      const href = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i)
      const url = href?.[2] ?? href?.[3] ?? href?.[4] ?? ""
      if (!safeUrl(url)) return "<a>"
      return `<a href="${escapeHtmlAttribute(url)}">`
    })
}

function plainTextFromHtml(value: string) {
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\s*\/\s*(div|p|li|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
}

function safeUrl(value: string) {
  return /^(https?:|mailto:)/i.test(value.trim())
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;")
}

function base64(value: string) {
  return Buffer.from(value, "utf8").toString("base64")
}

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function foldBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? ""
}

function fileName(filePath: string) {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "attachment"
}

function contentType(filePath: string) {
  const extension = fileName(filePath).toLowerCase().split(".").at(-1)
  if (extension === "png") return "image/png"
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg"
  if (extension === "gif") return "image/gif"
  if (extension === "pdf") return "application/pdf"
  if (extension === "txt") return "text/plain"
  return "application/octet-stream"
}

async function getAccessToken(credentialsPath: string) {
  const credentials = requireCredentials(JSON.parse(await readFile(credentialsPath, "utf8")) as unknown)
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    }),
  })
  const json = await response.json()
  if (!response.ok || !isRecord(json) || typeof json.access_token !== "string") throw new Error("Failed to refresh Gmail access token")
  return json.access_token
}

function requireCredentials(input: unknown): Credentials {
  if (!isRecord(input)) throw new Error("Invalid credentials file")
  if (typeof input.client_id !== "string" || typeof input.client_secret !== "string" || typeof input.refresh_token !== "string") throw new Error("Invalid credentials file")
  return {
    client_id: input.client_id,
    client_secret: input.client_secret,
    refresh_token: input.refresh_token,
  }
}

async function sendMessage(accessToken: string, rawMessage: string) {
  return gmailFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: rawMessage }),
  })
}

async function createDraft(accessToken: string, rawMessage: string) {
  return gmailFetch(accessToken, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw: rawMessage } }),
  })
}

function responseMessageID(response: Record<string, unknown>, draft: boolean) {
  if (!draft) return stringValue(response.id) ?? ""
  const message = response.message
  if (!isRecord(message)) return ""
  return stringValue(message.id) ?? ""
}

async function gmailFetch(accessToken: string, url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`Gmail API request failed: ${response.status} ${response.statusText}`)
  if (!isRecord(json)) return {}
  return json
}

async function loadRecipientCache(input: { refresh?: boolean; credentials?: string }) {
  const cached = input.refresh ? undefined : await readRecipientCache()
  if (cached && Date.now() - cached.updatedAt < recipientCacheMaxAge) return cached
  try {
    const fresh = await fetchSentRecipientCache(input.credentials ?? defaultCredentials)
    await writeRecipientCache(fresh)
    return fresh
  } catch (error) {
    if (cached) return cached
    throw error
  }
}

async function readRecipientCache(): Promise<RecipientCache | undefined> {
  const text = await readFile(recipientCacheFile(), "utf8").catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") return undefined
    throw error
  })
  if (!text) return
  const data = parseJson(text)
  if (!isRecord(data) || data.version !== 1 || typeof data.updatedAt !== "number" || !Array.isArray(data.recipients)) return
  return {
    version: 1,
    updatedAt: data.updatedAt,
    recipients: data.recipients.filter(isRecipientCacheEntry),
  }
}

async function writeRecipientCache(cache: RecipientCache) {
  await mkdir(path.dirname(recipientCacheFile()), { recursive: true })
  await writeFile(recipientCacheFile(), `${JSON.stringify(cache, null, 2)}\n`)
}

function recipientCacheFile() {
  return path.join(Global.Path.state, "gmail", "recipient-cache.json")
}

async function fetchSentRecipientCache(credentials: string): Promise<RecipientCache> {
  const accessToken = await getAccessToken(credentials)
  const recipients = new Map<string, RecipientCacheEntry>()
  let pageToken: string | undefined
  let scanned = 0

  while (scanned < sentScanLimit) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages")
    url.searchParams.set("labelIds", "SENT")
    url.searchParams.set("maxResults", "100")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const list = await gmailFetch(accessToken, url.toString(), { method: "GET" })
    const ids = messageIDs(list).slice(0, Math.max(0, sentScanLimit - scanned))
    for (const chunk of chunks(ids, 20)) {
      const messages = await Promise.all(chunk.map((id) => fetchMessageMetadata(accessToken, id)))
      messages.forEach((message) => collectRecipients(message, recipients))
    }
    scanned += ids.length
    pageToken = stringValue(list.nextPageToken)
    if (!pageToken || ids.length === 0) break
  }

  return {
    version: 1,
    updatedAt: Date.now(),
    recipients: Array.from(recipients.values()).sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen),
  }
}

async function fetchMessageMetadata(accessToken: string, id: string) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)
  url.searchParams.set("format", "metadata")
  url.searchParams.append("metadataHeaders", "To")
  url.searchParams.append("metadataHeaders", "Cc")
  url.searchParams.append("metadataHeaders", "Bcc")
  return gmailFetch(accessToken, url.toString(), { method: "GET" })
}

function messageIDs(value: Record<string, unknown>) {
  const messages = value.messages
  if (!Array.isArray(messages)) return []
  return messages.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []))
}

function collectRecipients(message: Record<string, unknown>, recipients: Map<string, RecipientCacheEntry>) {
  const headers = recordValue(message.payload)?.headers
  const lastSeen = Number(stringValue(message.internalDate)) || Date.now()
  if (!Array.isArray(headers)) return
  headers
    .filter(isRecord)
    .filter((header) => ["to", "cc", "bcc"].includes(String(header.name ?? "").toLowerCase()))
    .flatMap((header) => parseAddressList(String(header.value ?? "")))
    .forEach((address) => recordRecipient(recipients, address, lastSeen))
}

function parseAddressList(value: string) {
  return splitAddressHeader(value)
    .map((part) => {
      const angle = part.match(/^(.*)<([^<>\s,;]+@[^<>\s,;]+)>$/)
      if (angle) return { name: cleanName(angle[1]), email: angle[2].trim() }
      const email = part.match(/[^\s,;<>"']+@[^\s,;<>"']+/)?.[0] ?? ""
      return { name: undefined, email: email.trim() }
    })
    .filter((item) => item.email)
}

function splitAddressHeader(value: string) {
  const result: string[] = []
  let current = ""
  let quoted = false
  let depth = 0

  for (const char of value) {
    if (char === '"') quoted = !quoted
    if (!quoted && char === "<") depth++
    if (!quoted && char === ">") depth = Math.max(0, depth - 1)
    if (!quoted && depth === 0 && (char === "," || char === ";")) {
      if (current.trim()) result.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (current.trim()) result.push(current.trim())
  return result
}

function cleanName(value: string | undefined) {
  const name = value?.replace(/\\"/g, '"').replace(/^"|"$/g, "").trim()
  return name || undefined
}

function recordRecipient(recipients: Map<string, RecipientCacheEntry>, address: { email: string; name?: string }, lastSeen: number) {
  const email = address.email.toLowerCase()
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return
  const current = recipients.get(email)
  recipients.set(email, {
    email,
    name: address.name ?? current?.name,
    count: (current?.count ?? 0) + 1,
    lastSeen: Math.max(current?.lastSeen ?? 0, lastSeen),
  })
}

function recipientScore(recipient: RecipientCacheEntry, tokens: string[]) {
  const haystack = `${recipient.name ?? ""} ${recipient.email}`.toLowerCase()
  if (!tokens.every((token) => haystack.includes(token))) return 0
  const prefixBoost = tokens.some((token) => recipient.email.startsWith(token) || recipient.name?.toLowerCase().startsWith(token)) ? 100 : 0
  const frequencyBoost = Math.min(recipient.count, 50)
  const recencyBoost = Math.max(0, 30 - Math.floor((Date.now() - recipient.lastSeen) / (30 * 24 * 60 * 60 * 1000)))
  return prefixBoost + frequencyBoost + recencyBoost
}

function chunks(values: string[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size))
}

function isRecipientCacheEntry(value: unknown): value is RecipientCacheEntry {
  return isRecord(value) && typeof value.email === "string" && typeof value.count === "number" && typeof value.lastSeen === "number"
}

function recordValue(value: unknown) {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function nodeErrorCode(error: unknown) {
  if (!isRecord(error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
