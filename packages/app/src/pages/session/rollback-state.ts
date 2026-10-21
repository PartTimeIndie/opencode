import type { Message, Session, UserMessage } from "@opencode-ai/sdk/v2"
import { compareMessageTime } from "@/utils/message-order"

// A blocked file rollback has not applied the checkpoint. Keep its history
// visible until the user explicitly resolves it or chooses to keep files.
export function rollbackTimelineBoundary(revert: Session["revert"], fallback?: string) {
  if (revert?.status === "blocked") return
  return revert?.messageID ?? fallback
}

export function rollbackUsersBefore(users: UserMessage[], boundaryID?: string, boundary?: Message) {
  if (!boundaryID) return users
  const target = boundary ?? users.find((message) => message.id === boundaryID)
  // A boundary outside the loaded tail precedes that tail; do not infer time from IDs.
  if (!target) return []
  return users.filter((message) => compareMessageTime(message, target) < 0)
}
