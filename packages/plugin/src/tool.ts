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
  /** Host-confirmed, activity-bound activation; never model tool arguments. */
  explicitInvocation?: { command: string; inputID: string; activityID: string }
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: AskInput): Promise<void>
  customPart(input: CustomPartInput): Promise<void>
  /** Host-owned, session-bound state. Values are read from durable host storage, never model input. */
  sessionContext: {
    planDocument(): Promise<SessionPlanDocument | undefined>
    actionInvocations(): Promise<SessionActionInvocation[]>
  }
  /**
   * Host bridge that runs one caller-bound assignment as a native task inside
   * another physical checkout and reads its durable evidence. A "main" job
   * still requires the user's single-use task_main_write consent there.
   * Absent when the host provides no Location map.
   */
  nativeJob?: {
    dispatch(input: { checkout: string; job: NativeJobInput }): Promise<{
      checkout: string
      binding: string
      attempt: number
      hostSessionID: string
      inputID: string
      created: boolean
    }>
    observe(input: { checkout: string; binding: string; attempt: number }): Promise<NativeJobObservation>
  }
}

export type NativeJobInput = {
  version: 1
  /** Caller-owned SHA-256 binding; one durable host Session per binding. */
  binding: string
  /** Append-only attempt number; each attempt is one durable native input. */
  attempt: number
  title: string
  prompt: string
  agent: string
}

export type NativeJobChild = { sessionID: string; inputID: string; dispatchDigest: string; placementIdentity: string }

export type NativeJobObservation =
  | { state: "missing" }
  | { state: "admitted"; hostSessionID: string; inputID: string }
  | { state: "unsettled"; hostSessionID: string; inputID: string; reason: string }
  | { state: "running"; hostSessionID: string; inputID: string; activityID: string; status: string; questions: ReadonlyArray<{ id: string; state: string }>; child?: NativeJobChild }
  | {
      state: "terminal"
      hostSessionID: string
      inputID: string
      activityID: string
      status: "completed" | "failed" | "interrupted"
      child?: NativeJobChild
      tool: { status: "completed"; report: string } | { status: "error"; error: string } | undefined
      lastError: string | null
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
  /** Hide the tool until a leading /command (or listed alias) receives single-use host activation consent. */
  explicitInvocation?: string | ReadonlyArray<string>
  budgetCategory?: "read" | "poll" | "other"
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}
tool.schema = z

export type ToolDefinition = ReturnType<typeof tool>
