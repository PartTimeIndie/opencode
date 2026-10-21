import { z } from "zod"

export type ToolContext = {
  sessionID: string
  messageID: string
  /** Durable host tool-call identity, suitable for idempotent dispatch. */
  callID: string
  agent: string
  /**
   * Current project directory for this session.
   * Prefer this over process.cwd() when resolving relative paths.
   */
  directory: string
  /**
   * Project worktree root for this session.
   * Useful for generating stable relative paths (e.g. path.relative(worktree, absPath)).
   */
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
  customPart(input: CustomPartInput): Promise<void>
  /** Host-owned, session-bound state. Values are read from durable host storage, never model input. */
  sessionContext: {
    planDocument(): Promise<SessionPlanDocument | undefined>
    actionInvocations(): Promise<SessionActionInvocation[]>
  }
}

export type SessionPlanDocument = {
  markdown: string
  revision: number
  updatedAt: number
}

export type SessionActionInvocation = {
  invocation: {
    id: string
    target: { kind: "request" | "tool"; id: string; revision: number }
    actionID: string
    source?: string
    state: "pending" | "completed" | "failed"
    result?: unknown
    error?: string
    time: { created: number; updated: number }
  }
  request?: {
    id: string
    sessionID: string
    revision: number
    mode: "blocking" | "interactive" | "passive"
    tool?: {
      name?: string
      confirmationToken?: string
      purpose?: "daily_review_implementation"
      planDocument?: { revision: number; updatedAt: number }
      messageID: string
      callID: string
    }
    surface?: unknown
  }
}

export type CustomPartInput = {
  kind: string
  data: unknown
  title?: string
  fallback?: string
  metadata?: Record<string, unknown>
  time?: {
    start: number
    end?: number
  }
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: { [key: string]: any }
}

export type ToolAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: { [key: string]: any }
      attachments?: ToolAttachment[]
    }

export function tool<Args extends z.ZodRawShape>(input: {
  description: string
  alwaysVisible?: boolean
  /**
   * Contract marker that scopes this tool to turns whose current prompt carries
   * the marker (for example `opencode.scheduled-job-result/v1`). The tool stays
   * registered for scheduled runs but is hidden from ordinary chat turns.
   */
  contractMarker?: string
  budgetCategory?: "read" | "poll" | "other"
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
