import { App } from "@slack/bolt"
import { createOpencode, type OpencodeClient, type SessionMessage } from "@opencode-ai/sdk/v2"
import { isAllowedSender, senderUserId } from "./allow-list"

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

const allowedUsers = (process.env.OPENCODE_SLACK_ALLOW_USERS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
const autoShare = process.env.OPENCODE_SLACK_SHARE === "1"

console.log("🔧 Bot configuration:")
console.log("- Bot token present:", !!process.env.SLACK_BOT_TOKEN)
console.log("- Signing secret present:", !!process.env.SLACK_SIGNING_SECRET)
console.log("- App token present:", !!process.env.SLACK_APP_TOKEN)

console.log("🚀 Starting opencode server...")
const opencode = await createOpencode({
  port: 0,
})
console.log("✅ Opencode server ready")

const sessions = new Map<string, { client: OpencodeClient; sessionId: string; channel: string; thread: string }>()

app.use(async ({ next, context }) => {
  console.log("📡 Slack event:", context.teamId ?? "unknown-team", context.userId ?? "unknown-user")
  await next()
})

app.message(async ({ message, say }) => {
  const userId = senderUserId(message)
  console.log(
    "📨 Message event:",
    message.channel,
    "user",
    userId,
    "length",
    "text" in message ? message.text?.length : 0,
  )

  if (!isAllowedSender(userId, allowedUsers)) {
    console.log("⏭️ Skipping message from non-allowlisted user")
    return
  }

  if (message.subtype || !("text" in message) || !message.text) {
    console.log("⏭️ Skipping message - no text or has subtype")
    return
  }

  console.log("✅ Processing message:", message.text)

  const channel = message.channel
  const thread = "thread_ts" in message && typeof message.thread_ts === "string" ? message.thread_ts : message.ts
  const sessionKey = `${channel}-${thread}`

  let session = sessions.get(sessionKey)

  if (!session) {
    console.log("🆕 Creating new opencode session...")
    const client = opencode.client

    const createResult = await client.v2.session.create()

    if (createResult.error) {
      console.error("❌ Failed to create session:", createResult.error)
      await say({
        text: "Sorry, I had trouble creating a session. Please try again.",
        thread_ts: thread,
      })
      return
    }

    const sessionId = createResult.data?.data.id
    if (!sessionId) {
      console.error("❌ Failed to create session:", createResult)
      await say({
        text: "Sorry, I had trouble creating a session. Please try again.",
        thread_ts: thread,
      })
      return
    }

    console.log("✅ Created opencode session:", sessionId)

    session = { client, sessionId, channel, thread }
    sessions.set(sessionKey, session)

    // Sharing publishes the full transcript under a public URL; keep it
    // opt-in instead of exposing every conversation by default.
    if (autoShare) {
      const shareResult = await client.session.share({ sessionID: sessionId })
      if (!shareResult.error && shareResult.data) {
        const sessionUrl = shareResult.data.share?.url
        console.log("🔗 Session shared:", sessionUrl)
        await app.client.chat.postMessage({ channel, thread_ts: thread, text: sessionUrl })
      }
    }
  }

  console.log("📝 Sending to opencode:", message.text)
  const result = await session.client.v2.session.prompt({
    sessionID: session.sessionId,
    prompt: { text: message.text },
  })

  console.log("📤 Opencode response status:", result.error ? "error" : "ok")

  if (result.error) {
    console.error("❌ Failed to send message:", result.error)
    await say({
      text: "Sorry, I had trouble processing your message. Please try again.",
      thread_ts: thread,
    })
    return
  }

  const waitResult = await session.client.v2.session.wait({ sessionID: session.sessionId })
  if (waitResult.error) {
    console.error("❌ Failed to wait for response:", waitResult.error)
    await say({
      text: "Sorry, I had trouble processing your message. Please try again.",
      thread_ts: thread,
    })
    return
  }

  const messagesResult = await session.client.v2.session.messages({
    sessionID: session.sessionId,
    order: "desc",
    limit: 20,
  })
  if (messagesResult.error) {
    console.error("❌ Failed to load response:", messagesResult.error)
    await say({
      text: "Sorry, I had trouble loading the response. Please try again.",
      thread_ts: thread,
    })
    return
  }

  const responseText = latestAssistantText(messagesResult.data?.data ?? [])

  console.log("💬 Sending response:", responseText)

  await say({ text: responseText, thread_ts: thread })
})

function latestAssistantText(messages: Array<SessionMessage>) {
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant) return "I received your message but didn't have a response."
  const text = assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  return text || "I received your message but didn't have a response."
}

app.command("/test", async ({ command, ack, say }) => {
  await ack()
  console.log("🧪 Test command received:", JSON.stringify(command, null, 2))
  await say("🤖 Bot is working! I can hear you loud and clear.")
})

await app.start()
console.log("⚡️ Slack bot is running!")
