/** Standard Schema v1, implemented by Zod and other schema libraries. */
export type ServerServiceSchema<Output> = {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    readonly types?: { readonly input: unknown; readonly output: Output }
    readonly validate: (value: unknown) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        >
  }
}

/** All identity and placement fields are supplied by the host, never request input. */
export type ServerServiceContext = {
  pluginID: string
  callerPluginID: string
  projectID: string
  directory: string
  sessionID?: string
  signal: AbortSignal
}

export type ServerServiceDefinition<Input, Output> = {
  id: string
  /** Exact, positive integer contract version. */
  version: number
  input: ServerServiceSchema<Input>
  output: ServerServiceSchema<Output>
  execute(input: Input, context: ServerServiceContext): Output | Promise<Output>
  /** Called once after registration removal and cancellation of active calls. */
  dispose?(): void | Promise<void>
}

export type ServerServices = {
  /** The host binds registrations to the loading plugin and project directory. */
  register<Input, Output>(definition: ServerServiceDefinition<Input, Output>): () => Promise<void>
}

export type ServerServiceCall = {
  pluginID: string
  serviceID: string
  version: number
  input: unknown
}

export type ServerSessionModel = {
  id: string
  providerID: string
  variant?: string
  chain?: { id: string; name: string; steps: Array<{ id: string; providerID: string; variant?: string }>; active?: number } | null
}
export type ServerSessionLink = { sourceSessionID: string; targetSessionID: string }
export type ServerSessionExecutionView = { phase: "admission_missing" | "admitted" | "promoted" } | {
  phase: "activity"
  activity: { id: string; status: string; closed_seq: number | null; last_error: string | null; reason: string | null; turn_completion_state: "running" | "ready" | "done" | null; turn_completion_result: "done" | "incomplete" | "unknown" | "skipped" | null }
  questions: Array<{ id: string; state: string }>
  assistants: Array<{ id: string; seq: number; data: unknown }>
  laterInputs: number[]
  laterAdmissions: string[]
}
export type ServerPluginHost = {
  readonly version: string
  readonly signal?: AbortSignal
  media: { register(adapters: import("./media.js").MediaAdapters): Promise<void> }
  fanout: {
    register(input: { id: string; configKey: string; agentID: string; agentAliases?: string[]; commands: string[]; tools: string[]; resultSchema: Record<string, unknown> }): Promise<void>
  }
  sessions: {
    completion: {
      register(policy: import("./completion.js").CompletionPolicy): Promise<void>
    }
    goalOwnership: {
      /** Register that this plugin's goal lifecycle owns continuation for a session. */
      register(policy: (input: { sessionID: string }) => boolean | Promise<boolean>): Promise<void>
      /** Clear only the completed Goal run; a replacement run remains untouched. */
      clear?(input: { sessionID: string; runID: string; condition: string }): Promise<void>
      /** Run/revision-bound status CAS, scoped to this plugin's Session location. */
      project?(input: { sessionID: string; runID: string; condition: string; expectedStatus?: string; status: string }): Promise<boolean>
    }
    /** Admit a plugin-generated prompt. The host attests it as non-interactive. */
    prompt(input: { sessionID: string; text: string; format?: Record<string, unknown>; expectedLatestInputID?: string | null; goal?: { condition: string; runID: string; expectedStatus?: string; status: string } }): Promise<{ id: string; goalStatus?: string }>
    /** Snapshot the durable inbox head, including unpromoted inputs. */
    admissionHead?(input: { sessionID: string }): Promise<{ id: string | null }>
    /** Durable transport provenance of an admitted input; missing rows are "unknown". */
    inputOrigin(input: { sessionID: string; inputID: string }): Promise<"interactive" | "plugin" | "unknown">
    exists(sessionID: string): Promise<boolean>
    execution: {
      read(input: { sessionID: string; messageID: string; activityID?: string; followContinuations?: boolean }): Promise<ServerSessionExecutionView>
      /** Observe an exact native Main task receipt. Both Sessions must be in this plugin's location. Never starts or resumes work. */
      readMainTask?(input: {
        parentSessionID: string
        sessionID: string
        messageID: string
        dispatchDigest: string
        placementIdentity: string
        activityID?: string
      }): Promise<ServerSessionExecutionView | { phase: "task_binding_mismatch" }>
    }
    links: {
      get(sessionID: string): Promise<ServerSessionLink | undefined>
      start(input: ServerSessionLink & { agent: string; title?: string; model?: ServerSessionModel; permissionPolicy: "single-use" | "inherit" }): Promise<ServerSessionLink>
      end(sourceSessionID: string): Promise<void>
      read(sourceSessionID: string): Promise<{ targetSessionID: string; activity: { type: "idle" | "busy"; activityID?: string }; messages: Array<{ id: string; role: "user" | "assistant"; text: string; truncated: boolean }>; truncated: boolean }>
    }
    dispatch: {
      send(input: { sourceSessionID: string; sourceMessageID: string; sourceCallID: string; text: string; delivery?: "steer" | "queue" }): Promise<{ sessionID: string; id: string; delivery: "steer" | "queue"; admittedSeq: number }>
    }
  }
  agents: {
    register(input: {
      id: string
      system: string
      description?: string
      mode?: "primary" | "subagent" | "all"
      hidden?: boolean
      tools?: { mode: "inherit" | "explicit"; entries: Record<string, { visible: boolean; delegable?: boolean; permission: "allow" | "ask" | "deny" }> }
      permissions?: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }>
    }): Promise<void>
  }
  tools: {
    register(tools: Record<string, import("./tool.js").ToolDefinition>): Promise<void>
  }
}
