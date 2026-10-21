import { load } from "@opencode-ai/core/mail/accounts"
import { deliver, preview, status } from "@opencode-ai/core/mail/delivery"
import type { Outgoing } from "@opencode-ai/core/mail/message"

export function gmxFormMessage(from: string, values: Record<string, unknown>): Outgoing {
  const addresses = (key: string) => {
    const value = values[key]
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Invalid ${key}`)
    return value
  }
  if (typeof values.subject !== "string" || typeof values.body !== "string") throw new Error("Missing subject or body")
  return {
    from,
    to: addresses("to"),
    cc: addresses("cc"),
    bcc: addresses("bcc"),
    subject: values.subject,
    text: values.body,
    attachments: addresses("attachments"),
  }
}

export async function executeGmxFormAction(input: { account: string; mode: "send" | "draft"; values: Record<string, unknown> }) {
  const account = (await load()).accounts.find((item) => item.id === input.account && item.enabled)
  if (!account) throw new Error("GMX account not configured or disabled")
  // Never accept the sender or account from editable values. Only the authored
  // host step may select an account; the backend derives the From address.
  const message = gmxFormMessage(account.email, input.values)
  const checked = await preview(account, message)
  const requestID = crypto.randomUUID()
  try {
    return await deliver({ account, message, intent: input.mode, requestID, expectedHash: checked.hash })
  } catch {
    // A provider error may have occurred after SMTP acceptance. Never retry.
    const recorded = await status(requestID).catch(() => undefined)
    if (recorded && typeof recorded === "object" && "state" in recorded && recorded.state === "provider_accepted") return recorded
    throw new Error(`GMX outcome uncertain; check request ${requestID} before any new send`)
  }
}
