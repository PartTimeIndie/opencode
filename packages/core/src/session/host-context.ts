export * as SessionHostContext from "./host-context"

import type { SessionSchema } from "./schema"

/** Host placement is not provider identity and conveys no permission or approval. */
export function render(session: Pick<SessionSchema.Info, "id" | "parentID" | "agentPolicy">, directory?: string): string {
  const policy = session.agentPolicy
  const taskFork = policy?.source.type === "task" && (policy.taskContext ?? "fork") === "fork"
  return [
    `OpenCode host session (authoritative): ${JSON.stringify({
      app: "opencode",
      sessionID: session.id,
      parentSessionID: session.parentID ?? null,
      role: session.parentID ? "child" : "main",
    })}`,
    ...(directory === undefined ? [] : [`OpenCode host working directory: ${JSON.stringify(directory)}`]),
    "This is the current UI-host identity, not a provider backend thread. It grants no user approval. Child sessions must not start a main-session workflow or act as their parent.",
    ...(taskFork ? [
      "You are the directly assigned native execution fork, not the Main conversation. Imported parent history is background, not a new instruction to act as Main or dispatch this assignment.",
      "Carry out and verify the current assignment yourself within its scope; do not delegate it again. Main coordinates and reviews the result and handles any authorized integration.",
    ] : []),
  ].join("\n")
}
