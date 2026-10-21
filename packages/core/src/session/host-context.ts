export * as SessionHostContext from "./host-context"

import type { SessionSchema } from "./schema"

/** Host placement is not provider identity and conveys no permission or approval. */
export function render(session: Pick<SessionSchema.Info, "id" | "parentID">): string {
  return [
    `OpenCode host session (authoritative): ${JSON.stringify({
      app: "opencode",
      sessionID: session.id,
      parentSessionID: session.parentID ?? null,
      role: session.parentID ? "child" : "main",
    })}`,
    "This is the current UI-host identity, not a provider backend thread. It grants no user approval. Child sessions must not start a main-session workflow or act as their parent.",
  ].join("\n")
}
