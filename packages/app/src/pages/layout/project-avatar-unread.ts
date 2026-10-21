export function sessionTabUnread(input: {
  active: boolean
  hasPermissions: boolean
  hasQuestions: boolean
  notificationUnread: boolean
}) {
  return input.hasPermissions || input.hasQuestions || (!input.active && input.notificationUnread)
}

export function sessionTabStatus(input: {
  active: boolean
  unread: boolean
  hasQuestions: boolean
  resolved: "running" | "attention" | "done" | "incomplete" | "unknown" | undefined
}) {
  if (input.hasQuestions || input.resolved === "attention") return "question" as const
  if (input.active || !input.unread) return
  if (input.resolved === "done" || input.resolved === "incomplete" || input.resolved === "unknown") {
    return input.resolved
  }
}
