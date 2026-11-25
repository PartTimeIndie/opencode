import type { KnownEventFromType } from "@slack/bolt"

// Bolt hands app.message listeners every "message" subtype. The union also
// covers message_changed / message_deleted / message_replied events, which have
// no top-level `user`, and bot messages, where it is optional. Narrow instead
// of reading `user` directly, and treat anything but a string as unknown.
export function senderUserId(message: KnownEventFromType<"message">) {
  return "user" in message && typeof message.user === "string" ? message.user : undefined
}

// An empty list admits everyone. Otherwise an unknown or unlisted user is rejected.
export function isAllowedSender(userId: string | undefined, allowedUsers: string[]) {
  if (allowedUsers.length === 0) return true
  return userId !== undefined && allowedUsers.includes(userId)
}
