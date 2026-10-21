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

type Args = {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  bodyFile: string
  attachments: string[]
  html: boolean
  richText: boolean
  send: boolean
  draft: boolean
  dryRun: boolean
  showBody: boolean
  credentials: string
}

type MessageBodies = {
  plain: string
  html: string
  encoded: string
  content: "plain" | "html" | "rich-text"
}

const defaultCredentials = process.env.GWS_CREDENTIALS_FILE ?? ""

if (!defaultCredentials) throw new Error("Set GWS_CREDENTIALS_FILE to run the Gmail flow test")

const args = await parseArgs(Bun.argv.slice(2))
const attachments = await Promise.all(args.attachments.map(readAttachment))
const bodies = messageBodies(args)
const mime = buildMime(args, attachments, bodies)
const raw = base64Url(mime)
const bodyHash = await sha256(args.body)
const summary = {
  mode: args.send ? "send" : args.draft ? "draft" : "dry-run",
  to: args.to,
  cc: args.cc,
  bcc: args.bcc,
  subject: args.subject,
  body: {
    chars: args.body.length,
    lines: args.body.split(/\r\n|\r|\n/).length,
    sha256: bodyHash,
    content: bodies.content,
    ...(args.showBody ? { text: args.body } : { preview: args.body.slice(0, 240) }),
    ...(bodies.html ? { htmlSha256: await sha256(bodies.html), htmlPreview: bodies.html.slice(0, 240) } : {}),
  },
  attachments: attachments.map((attachment) => ({
    path: attachment.path,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType,
  })),
  mime: {
    bytes: new TextEncoder().encode(mime).byteLength,
    rawBytes: raw.length,
    containsEncodedBody: mime.replace(/\s/g, "").includes(base64(bodies.encoded).replace(/\s/g, "")),
  },
}

if (!args.send && !args.draft) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

const accessToken = await getAccessToken(args.credentials)
const response = args.draft ? await createDraft(accessToken, raw) : await sendMessage(accessToken, raw)
const messageID = responseMessageID(response, args.draft)
const verification = messageID ? await verifyMessage(accessToken, messageID, args, bodies) : { rawFetched: false, bodyFound: false }

console.log(
  JSON.stringify(
    {
      ...summary,
      gmail: response,
      verification,
    },
    null,
    2,
  ),
)

async function parseArgs(argv: string[]) {
  const parsed: Args = {
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    bodyFile: "",
    attachments: [],
    html: false,
    richText: false,
    send: false,
    draft: false,
    dryRun: false,
    showBody: false,
    credentials: process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE || defaultCredentials,
  }

  for (let index = 0; index < argv.length; index++) {
    const current = argv[index]
    if (current === "--to") parsed.to.push(...splitEmails(requireValue(argv, index, current)))
    if (current === "--cc") parsed.cc.push(...splitEmails(requireValue(argv, index, current)))
    if (current === "--bcc") parsed.bcc.push(...splitEmails(requireValue(argv, index, current)))
    if (current === "--subject") parsed.subject = requireValue(argv, index, current)
    if (current === "--body") parsed.body = requireValue(argv, index, current)
    if (current === "--body-file") parsed.bodyFile = cleanPath(requireValue(argv, index, current))
    if (current === "--attach") parsed.attachments.push(cleanPath(requireValue(argv, index, current)))
    if (current === "--credentials") parsed.credentials = cleanPath(requireValue(argv, index, current))
    if (current === "--html") parsed.html = true
    if (current === "--rich-text") parsed.richText = true
    if (current === "--send") parsed.send = true
    if (current === "--draft") parsed.draft = true
    if (current === "--dry-run") parsed.dryRun = true
    if (current === "--show-body") parsed.showBody = true
    if (current === "--help" || current === "-h") usage(0)
  }

  if (!parsed.to.length) fail("Missing --to")
  if (!parsed.subject.trim()) fail("Missing --subject")
  if (parsed.body && parsed.bodyFile) fail("Use either --body or --body-file, not both")
  if (parsed.bodyFile) parsed.body = await Bun.file(parsed.bodyFile).text()
  if (!parsed.body.trim()) fail("Missing --body or --body-file")
  if (parsed.html && parsed.richText) fail("Use either --html or --rich-text, not both")
  if (parsed.send && parsed.draft) fail("Use either --send or --draft, not both")
  if (parsed.dryRun && (parsed.send || parsed.draft)) fail("Use --dry-run without --send or --draft")
  return parsed
}

function requireValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) fail(`Missing value for ${flag}`)
  argv[index + 1] = ""
  return value
}

function splitEmails(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(safeEmail)
}

function cleanPath(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  return trimmed
}

async function readAttachment(filePath: string): Promise<Attachment> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) fail(`Attachment not found: ${filePath}`)
  return {
    path: filePath,
    name: fileName(filePath),
    size: file.size,
    contentType: contentType(filePath),
    content: foldBase64(Buffer.from(await file.arrayBuffer()).toString("base64")),
  }
}

function messageBodies(parsed: Args): MessageBodies {
  if (parsed.richText) {
    const html = richTextHtml(parsed.body)
    return { plain: plainTextFromHtml(html), html, encoded: html, content: "rich-text" }
  }
  if (parsed.html) return { plain: plainTextFromHtml(parsed.body), html: sanitizeMessageHtml(parsed.body), encoded: sanitizeMessageHtml(parsed.body), content: "html" }
  return { plain: parsed.body, html: "", encoded: parsed.body, content: "plain" }
}

function buildMime(parsed: Args, attachments: Attachment[], bodies: MessageBodies) {
  const headers = [
    `To: ${headerValue("To", parsed.to.join(", "))}`,
    ...headerList("Cc", parsed.cc),
    ...headerList("Bcc", parsed.bcc),
    `Subject: ${encodedHeader(parsed.subject)}`,
    "MIME-Version: 1.0",
  ]

  if (!attachments.length) {
    if (bodies.html) {
      const boundary = `opencode-alt-${crypto.randomUUID()}`
      return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", ...alternativeLines(boundary, bodies)].join("\r\n")
    }
    return [
      ...headers,
      ...contentLines("text/plain", bodies.plain),
    ].join("\r\n")
  }

  const boundary = `opencode-${crypto.randomUUID()}`
  const alternativeBoundary = `opencode-alt-${crypto.randomUUID()}`
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...(bodies.html
      ? [`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`, "", ...alternativeLines(alternativeBoundary, bodies)]
      : contentLines("text/plain", bodies.plain)),
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

function safeEmail(value: string) {
  const safe = headerValue("recipient", value)
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(safe)) fail(`Invalid recipient: ${safe}`)
  return safe
}

function headerValue(name: string, value: string) {
  if (/[\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) fail(`Invalid ${name}: header values cannot contain control characters`)
  return value
}

function headerParamValue(name: string, value: string) {
  return headerValue(name, value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
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

function richTextHtml(value: string) {
  const html = /<\/?(?:a|b|br|div|em|i|li|ol|p|strong|u|ul)\b/i.test(value) ? sanitizeMessageHtml(value) : escapeHtml(value)
  return markdownSyntaxToHtml(html).replace(/\r\n|\r|\n/g, "<br>")
}

function markdownTextToHtml(value: string) {
  return markdownSyntaxToHtml(escapeHtml(value))
    .replace(/\r\n|\r|\n/g, "<br>")
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

function base64UrlDecode(value: string) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
}

function foldBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? ""
}

async function sha256(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function getAccessToken(credentialsPath: string) {
  const credentials = requireCredentials(await Bun.file(credentialsPath).json())
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
  if (!response.ok || !json || typeof json !== "object" || typeof json.access_token !== "string") fail("Failed to refresh Gmail access token")
  return json.access_token
}

function requireCredentials(input: unknown): Credentials {
  if (!input || typeof input !== "object") fail("Invalid credentials file")
  const record = input as Record<string, unknown>
  if (typeof record.client_id !== "string" || typeof record.client_secret !== "string" || typeof record.refresh_token !== "string") fail("Invalid credentials file")
  return {
    client_id: record.client_id,
    client_secret: record.client_secret,
    refresh_token: record.refresh_token,
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

async function verifyMessage(accessToken: string, messageID: string, parsed: Args, bodies: MessageBodies) {
  const message = await gmailFetch(accessToken, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageID}?format=raw`, { method: "GET" })
  const rawMessage = typeof message.raw === "string" ? base64UrlDecode(message.raw) : ""
  const compact = rawMessage.replace(/\s/g, "")
  return {
    rawFetched: !!rawMessage,
    subjectFound: rawMessage.includes(encodedHeader(parsed.subject)) || rawMessage.includes(`Subject: ${parsed.subject}`),
    bodyFound: compact.includes(base64(bodies.encoded).replace(/\s/g, "")),
    attachmentsFound: parsed.attachments.every((attachment) => rawMessage.includes(fileName(attachment))),
  }
}

function responseMessageID(response: Record<string, unknown>, draft: boolean) {
  if (!draft) return typeof response.id === "string" ? response.id : ""
  const message = response.message
  if (!message || typeof message !== "object") return ""
  const record = message as Record<string, unknown>
  return typeof record.id === "string" ? record.id : ""
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
  if (!response.ok) fail(`Gmail API request failed: ${response.status} ${response.statusText}`)
  return json as Record<string, unknown>
}

function usage(code: number) {
  console.log(`Usage: bun run script/gmail-email-flow-test.ts --to EMAIL --subject SUBJECT (--body TEXT | --body-file PATH) [options]

Options:
  --cc EMAILS             Comma-separated CC recipients
  --bcc EMAILS            Comma-separated BCC recipients
  --attach PATH           Attachment path, repeatable
  --html                  Treat body as HTML
  --rich-text             Convert composer rich text / Markdown-ish body to rendered HTML
  --dry-run               Default; validate and print sanitized summary only
  --draft                 Create a Gmail draft through the Gmail API
  --send                  Send through the Gmail API
  --show-body             Include the full body in dry-run output
  --credentials PATH      Defaults to GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE or ${defaultCredentials}`)
  process.exit(code)
}

function fail(message: string): never {
  console.error(message)
  usage(1)
}
