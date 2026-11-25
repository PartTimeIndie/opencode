import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { ContextItem, Prompt } from "@/context/prompt"
import { ServerScope } from "@/utils/server-scope"
import { finishSessionActivity, startSessionActivity, updateSessionActivity } from "@/utils/session-activity"

let createPromptSubmit: typeof import("./submit").createPromptSubmit
let sendFollowupDraft: typeof import("./submit").sendFollowupDraft
let clearPromptSubmitState: typeof import("./submit-state").clearPromptSubmitState

const createdClients: string[] = []
const createdSessions: string[] = []
const createPayloads: Array<{
  id: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  location?: { directory: string }
}> = []
const createdSessionInfo = new Map<
  string,
  {
    id: string
    title: string
    projectID: string
    directory: string
    version: string
    time: { created: number; updated: number }
  }
>()
const enabledAutoAccept: Array<{ sessionID: string; directory: string }> = []
const syncedAccessControl: Array<{ sessionID: string; directory: string }> = []
const eventOrder: string[] = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string; metadata?: Record<string, unknown> }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const promotedDrafts: Array<{
  draftID: string
  tab: { server: string; dirBase64: string; sessionId: string; createdEmpty?: boolean }
}> = []
const addedSessionTabs: Array<{ server: string; dirBase64: string; sessionId: string; createdEmpty?: boolean }> = []
const activatedSessionTabs: Array<{ server: string; dirBase64: string; sessionId: string; createdEmpty?: boolean }> = []
const sentShell: string[] = []
const sentShellAgents: Array<string | undefined> = []
const sentCommands: Array<{
  directory: string
  sessionID: string
  messageID?: string
  command: string
  arguments: string
  agent?: string
  model?: string
  variant?: string
  modelSnapshot?: {
    providerID: string
    id: string
    variant?: string
    chain?: {
      id: string
      name: string
      active: number
      steps: { providerID: string; id: string; variant?: string }[]
    }
  }
}> = []
type SentPromptPart = { type: string; text?: string; filename?: string; name?: string; source?: unknown }
const sentPrompts: Array<{
  directory: string
  sessionID: string
  messageID?: string
  agent?: string
  model?: string | { providerID: string; modelID: string; variant?: string }
  variant?: string
  parts?: SentPromptPart[]
  prompt?: {
    text: string
    files?: Array<{ uri: string; mime: string; name?: string; source?: unknown }>
    agents?: Array<{ name: string; source?: unknown }>
  }
  system?: string
  delivery?: "steer" | "queue"
}> = []
const admittedPrompts: Array<{
  directory: string
  sessionID: string
  id?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  system?: string
  prompt?: { text: string }
  delivery?: "steer" | "queue"
}> = []
const syncedDirectories: string[] = []
const aborted: string[] = []
const sessionStatusUpdates: Array<{ directory: string; sessionID: string; type: string }> = []
const toasts: Array<{ title?: string; description?: string }> = []
const waitedSessions: string[] = []
const activityReads: string[] = []
const promptSets: Prompt[] = []
const promptResets: true[] = []
const transferredPrompts: Array<{
  prompt: Prompt
  cursor?: number
  scope: { dir: string; id?: string }
}> = []
const transferredContexts: Array<{
  item: ContextItem
  scope: { dir: string; id?: string }
}> = []
const configuredCommands: Array<{
  name: string
  description?: string
  source?: string
  agent?: string
  model?: string
  variant?: string
}> = []

let params: { id?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let activeTab: { type: "draft"; draftID: string } | { type: "session"; sessionId: string } | undefined
let accessControlSyncPromise: Promise<void> | undefined
let selectionPersistencePromise: Promise<void> | undefined
let sessionCreatePromise: Promise<void> | undefined
let promptAdmissionPromise: Promise<void> | undefined
let commandAdmissionPromise: Promise<void> | undefined
let shellAdmissionPromise: Promise<void> | undefined
let interruptError: Error | undefined
let interruptGate: Promise<void> | undefined
let interruptReads = 0
let interruptStatus: "busy" | "idle" | undefined
let statusError: Error | undefined
let statusGate: Promise<void> | undefined
let statusReads = 0
let followupMode: "queue" | "steer" = "queue"
let optimizationProfile: "off" | "safe" = "safe"
let compactVerifierContext = true
let selectedModel: { id: string; provider: { id: string } } | undefined = {
  id: "model",
  provider: { id: "provider" },
}
let selectedModelKey: { providerID: string; modelID: string } | undefined = {
  providerID: "provider",
  modelID: "model",
}
let selectedAgent: { name: string } | undefined = { name: "agent" }
let sessionID = 0
let messageID = 0

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
let promptCursor = 0
let resetClearsPrompt = false
let promptContextItems: Array<ContextItem & { key: string }> = []
const prompt = {
  ready: () => Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => promptCursor,
  dirty: () => true,
  reset: () => {
    promptResets.push(true)
    if (resetClearsPrompt) {
      promptValue = []
      promptCursor = 0
    }
  },
  set: (value: Prompt, cursor?: number, scope?: { dir: string; id?: string } | { draftID: string }) => {
    if (scope && "dir" in scope) {
      transferredPrompts.push({ prompt: value, cursor, scope })
      return
    }
    promptSets.push(value)
    promptValue = value
    promptCursor = cursor ?? promptCursor
  },
  context: {
    add: (item: ContextItem, scope?: { dir: string; id?: string } | { draftID: string }) => {
      if (scope && "dir" in scope) {
        transferredContexts.push({ item, scope })
        return
      }
      const key = `${item.type}:${item.path}:${item.commentID ?? ""}`
      if (promptContextItems.some((candidate) => candidate.key === key)) return
      promptContextItems.push({ ...item, key })
    },
    remove: (key: string) => {
      promptContextItems = promptContextItems.filter((item) => item.key !== key)
    },
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => promptContextItems,
  },
}

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    session: {
      get: async (input: { sessionID: string }) => ({ data: createdSessionInfo.get(input.sessionID) }),
      status: async () => {
        statusReads += 1
        if (statusGate) await statusGate
        if (statusError) throw statusError
        return { data: interruptStatus && params.id ? { [params.id]: { type: interruptStatus } } : {} }
      },
      prompt: async () => ({ data: undefined }),
      command: async (input: {
        sessionID: string
        command: string
        arguments: string
        agent?: string
        model?: string
        variant?: string
      }) => {
        sentCommands.push({ directory, ...input })
        return { data: undefined }
      },
      abort: async () => {
        aborted.push(directory)
        return { data: undefined }
      },
    },
    v2: {
      session: {
        create: async (input: {
          id: string
          agent?: string
          model?: { providerID: string; id: string; variant?: string }
          location?: { directory: string }
        }) => {
          createdSessions.push(directory)
          createPayloads.push(input)
          eventOrder.push("session.create")
          createdSessionInfo.set(input.id, {
            id: input.id,
            title: `New session ${createdSessions.length}`,
            projectID: "project",
            directory,
            version: "dev",
            time: { created: 1, updated: 1 },
          })
          if (sessionCreatePromise) await sessionCreatePromise
          return { data: { data: createdSessionInfo.get(input.id) } }
        },
        prompt: async (input: {
          sessionID: string
          id?: string
          agent?: string
          model?: {
            providerID: string
            id: string
            variant?: string
            chain?: {
              id: string
              name: string
              active: number
              steps: { providerID: string; id: string; variant?: string }[]
            }
          }
          system?: string
          prompt?: {
            text: string
            files?: Array<{ uri: string; mime: string; name?: string; source?: unknown }>
            agents?: Array<{ name: string; source?: unknown }>
          }
          delivery?: "steer" | "queue"
        }) => {
          eventOrder.push("v2.session.prompt")
          sentPrompts.push({
            directory,
            sessionID: input.sessionID,
            messageID: input.id,
            agent: input.agent,
            model: input.model
              ? { providerID: input.model.providerID, modelID: input.model.id, variant: input.model.variant }
              : undefined,
            variant: input.model?.variant,
            prompt: input.prompt,
            parts: [
              ...(input.prompt?.text ? [{ type: "text", text: input.prompt.text }] : []),
              ...(input.prompt?.files ?? []).map((file) => ({
                type: "file",
                filename: file.name,
                source: file.source,
              })),
              ...(input.prompt?.agents ?? []).map((agent) => ({
                type: "agent",
                name: agent.name,
                source: agent.source,
              })),
            ],
            system: input.system,
            delivery: input.delivery,
          })
          if (promptAdmissionPromise) await promptAdmissionPromise
          return { data: { sessionID: input.sessionID, messageID: input.id, admittedSeq: 1 } }
        },
        wait: async (input: { sessionID: string }) => {
          waitedSessions.push(input.sessionID)
          return { data: undefined }
        },
        activity: async (input: { sessionID: string }) => {
          activityReads.push(input.sessionID)
          return { data: { data: { type: "idle" as const } } }
        },
        command: async (input: {
          sessionID: string
          id?: string
          command?: string
          arguments?: string
          agent?: string
          model?: { providerID: string; id: string; variant?: string }
        }) => {
          eventOrder.push("v2.session.command")
          sentCommands.push({
            directory,
            sessionID: input.sessionID,
            messageID: input.id,
            command: input.command ?? "",
            arguments: input.arguments ?? "",
            agent: input.agent,
            model: input.model ? `${input.model.providerID}/${input.model.id}` : undefined,
            variant: input.model?.variant,
            modelSnapshot: input.model,
          })
          if (commandAdmissionPromise) await commandAdmissionPromise
          return { data: undefined }
        },
        interrupt: async () => {
          aborted.push(directory)
          interruptReads += 1
          if (interruptGate) await interruptGate
          if (interruptError) throw interruptError
          return { data: undefined }
        },
        shell: async (input: { agent?: string }) => {
          eventOrder.push("v2.session.shell")
          sentShell.push(directory)
          sentShellAgents.push(input.agent)
          if (shellAdmissionPromise) await shellAdmissionPromise
          return { data: undefined }
        },
      },
    },
    worktree: {
      create: async () => ({ data: { directory: `${directory}/new` } }),
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    showToast: (toast: { title?: string; description?: string }) => {
      toasts.push(toast)
      return 0
    },
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    base64Decode: (value: string) => value,
  }))

  mock.module("@/utils/id", () => ({
    Identifier: {
      ascending: (prefix: string) => {
        if (prefix === "session") return `session-${++sessionID}`
        if (prefix === "message") return `message-${++messageID}`
        return `${prefix}-1`
      },
      descending: (prefix: string) => `${prefix}-1`,
    },
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => selectedModel,
        selected: () => selectedModelKey,
        variant: { current: () => variant },
      },
      agent: {
        current: () => selectedAgent,
      },
      session: {
        settled: async () => selectionPersistencePromise,
        promote(directory: string, sessionID: string) {
          eventOrder.push("local.session.promote")
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      general: {
        followup: () => followupMode,
      },
      optimizations: {
        optimizationProfile: () => optimizationProfile,
        externalContextReduction: () => true,
        sourceTestContextPack: () => true,
        compactVerifierContext: () => compactVerifierContext,
        selfTestPolicy: () => true,
        toolContextCompression: () => true,
        readDeduplication: () => true,
        coreSearchLimits: () => true,
        stableToolOutputPreview: () => true,
        toolMaterializationCache: () => false,
        runnerRequestMetrics: () => true,
        deferredToolDiscovery: () => false,
        compactToolSchemas: () => true,
        patchVerifyTool: () => true,
        batchCoreTools: () => false,
        sessionTabPrefetch: () => true,
      },
    }),
  }))

  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      enableAutoAccept(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
      applyAccessControlDefault(sessionID: string, directory: string) {
        enabledAutoAccept.push({ sessionID, directory })
      },
      accessControlProfile() {
        return {
          mode: "approve_for_me",
          safety_review: { model: "opencode/deepseek-v4-flash-free" },
        }
      },
      sessionProfileMetadata(profile: Record<string, unknown>, metadata?: Record<string, unknown>) {
        return {
          ...(metadata ?? {}),
          access_control: profile,
        }
      },
      async syncAccessControlProfile(sessionID: string, directory: string) {
        eventOrder.push("access-control.sync")
        syncedAccessControl.push({ sessionID, directory })
        if (accessControlSyncPromise) await accessControlSyncPromise
      },
    }),
  }))

  mock.module("@/context/server", () => ({
    ServerConnection: {
      Key: { make: (value: string) => value },
      key: (value: { key?: string }) => value.key ?? "server-key",
      local: () => true,
    },
    useServer: () => ({ key: "server-key", current: undefined, list: [] }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      promoteDraft: (
        draftID: string,
        tab: { server: string; dirBase64: string; sessionId: string; createdEmpty?: boolean },
      ) => {
        eventOrder.push("tabs.promoteDraft")
        promotedDrafts.push({ draftID, tab })
      },
      openSessionTab: (
        tab: { server: string; dirBase64: string; sessionId: string; createdEmpty?: boolean },
        options?: { activate?: boolean },
      ) => (options?.activate === false ? addedSessionTabs.push(tab) : activatedSessionTabs.push(tab)),
      markSessionUsed: () => undefined,
      active: () => activeTab,
    }),
  }))

  mock.module("@/context/prompt", () => ({
    isPromptEqual: (a: Prompt, b: Prompt) => JSON.stringify(a) === JSON.stringify(b),
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        url: "http://localhost:4096",
        createClient(opts: { directory: string }) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: configuredCommands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    createServerSyncContext: () => undefined,
    useServerSync: () => () => ({
      todo: { set: () => undefined },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] === "session_status" && typeof args[1] === "string") {
              sessionStatusUpdates.push({
                directory,
                sessionID: args[1],
                type: (args[2] as { type: string }).type,
              })
              return
            }
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
  sendFollowupDraft = mod.sendFollowupDraft
  clearPromptSubmitState = (await import("./submit-state")).clearPromptSubmitState
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  createPayloads.length = 0
  createdSessionInfo.clear()
  enabledAutoAccept.length = 0
  syncedAccessControl.length = 0
  eventOrder.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  addedSessionTabs.length = 0
  activatedSessionTabs.length = 0
  params = {}
  sentShell.length = 0
  sentShellAgents.length = 0
  sentCommands.length = 0
  sentPrompts.length = 0
  admittedPrompts.length = 0
  configuredCommands.length = 0
  syncedDirectories.length = 0
  aborted.length = 0
  sessionStatusUpdates.length = 0
  toasts.length = 0
  waitedSessions.length = 0
  activityReads.length = 0
  promptSets.length = 0
  promptResets.length = 0
  transferredPrompts.length = 0
  transferredContexts.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  promptCursor = 0
  resetClearsPrompt = false
  promptContextItems = []
  selected = "/repo/worktree-a"
  variant = undefined
  activeTab = { type: "draft", draftID: "draft-1" }
  accessControlSyncPromise = undefined
  selectionPersistencePromise = undefined
  sessionCreatePromise = undefined
  promptAdmissionPromise = undefined
  commandAdmissionPromise = undefined
  shellAdmissionPromise = undefined
  interruptError = undefined
  interruptGate = undefined
  interruptReads = 0
  interruptStatus = undefined
  statusError = undefined
  statusGate = undefined
  statusReads = 0
  followupMode = "queue"
  optimizationProfile = "safe"
  compactVerifierContext = true
  selectedModel = { id: "model", provider: { id: "provider" } }
  selectedModelKey = { providerID: "provider", modelID: "model" }
  selectedAgent = { name: "agent" }
  sessionID = 0
  messageID = 0
  clearPromptSubmitState()
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

describe("prompt submit worktree selection", () => {
  const createDockedDraftSubmit = (
    editor: () => HTMLDivElement | undefined = () => undefined,
    options?: {
      mode?: "normal" | "shell"
      worktree?: () => string
      onWorktreeReset?: () => void
    },
  ) =>
    createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => options?.mode ?? "normal",
      working: () => false,
      editor,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      draftID: () => "draft-1",
      newSessionWorktree: options?.worktree ?? (() => "main"),
      onNewSessionWorktreeReset: options?.onWorktreeReset ?? (() => undefined),
      onSubmit: () => undefined,
    })

  const createExistingSessionSubmit = (options?: {
    beforeSubmit?: Parameters<typeof createPromptSubmit>[0]["beforeSubmit"]
    working?: () => boolean
    forceSteer?: () => boolean
    shouldQueue?: () => boolean
    onQueue?: Parameters<typeof createPromptSubmit>[0]["onQueue"]
    info?: () => {
      id: string
      agent?: string
      model?: { id: string; providerID: string; variant?: string }
    }
  }) =>
    createPromptSubmit({
      beforeSubmit: options?.beforeSubmit,
      prompt,
      info: options?.info ?? (() => ({ id: "session-1" })),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: options?.working ?? (() => false),
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      forceSteer: options?.forceSteer,
      shouldQueue: options?.shouldQueue,
      onQueue: options?.onQueue,
      onSubmit: () => undefined,
    })

  test("waits for a manual agent switch to settle before admitting the prompt", async () => {
    let release!: () => void
    selectionPersistencePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const submission = createDockedDraftSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    await Promise.resolve()
    expect(createdSessions).toEqual([])

    release()
    await submission
    expect(createdSessions).toHaveLength(1)
  })

  test("uses the stored session selection while agent and model catalogs hydrate", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    selectedModel = undefined
    selectedModelKey = undefined
    selectedAgent = undefined

    const submit = createExistingSessionSubmit({
      info: () => ({
        id: "session-1",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5.6-sol", variant: "high" },
      }),
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.at(-1)).toMatchObject({
      sessionID: "session-1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
    })
    expect(toasts).toEqual([])
  })

  test("does not submit when an explicit model selection can no longer be resolved", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    selectedModel = undefined
    selectedModelKey = { providerID: "missing", modelID: "removed" }

    await createExistingSessionSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts).toHaveLength(0)
    expect(toasts).toEqual([
      {
        title: "prompt.toast.modelUnavailable.title",
        description: "prompt.toast.modelUnavailable.description",
      },
    ])
  })

  test("leaves optimistic busy state to authoritative lifecycle events after admission", async () => {
    const status: string[] = []
    const client = clientFor("/repo/main")

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: {
        data: { command: [] },
        session: { optimistic: { add: () => undefined, remove: () => undefined } },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
      serverSync: {
        child: () => [
          undefined,
          (_key: string, _sessionID: string, value: { type: string }) => status.push(value.type),
        ],
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        prompt: [{ type: "text", content: "hello", start: 0, end: 5 }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
      },
      optimisticBusy: true,
    })
    expect(waitedSessions).toEqual([])
    expect(activityReads).toEqual([])
    expect(status).toEqual(["busy"])
  })

  test("awaits an asynchronous composer callback and honors cancellation without a form", async () => {
    params = { id: "session-1" }
    const started = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<boolean>()
    const submit = createExistingSessionSubmit({
      beforeSubmit: async (context) => {
        expect(context.sessionID).toBe("session-1")
        started.resolve()
        return decision.promise
      },
    })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await started.promise
    expect(sentPrompts).toHaveLength(0)
    decision.resolve(false)
    await sending
    expect(sentPrompts).toHaveLength(0)
  })

  test("applies the amended draft after an asynchronous composer callback", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "fix bug", start: 0, end: 7 }]
    const submit = createExistingSessionSubmit({
      beforeSubmit: async () => {
        await Promise.resolve()
        const content = "fix the failing login test"
        prompt.set([{ type: "text", content, start: 0, end: content.length }], content.length)
        return true
      },
    })
    await submit.handleSubmit({ preventDefault() {} } as Event)
    await Promise.resolve()
    expect(sentPrompts[0]?.parts?.[0]).toMatchObject({ type: "text", text: "fix the failing login test" })
  })

  test("does not submit into another session after an asynchronous callback", async () => {
    params = { id: "session-1" }
    const started = Promise.withResolvers<void>()
    const decision = Promise.withResolvers<boolean>()
    const submit = createExistingSessionSubmit({
      beforeSubmit: () => {
        started.resolve()
        return decision.promise
      },
    })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await started.promise
    params = { id: "session-2" }
    decision.resolve(true)
    await sending
    expect(sentPrompts).toHaveLength(0)
  })

  test("commits toolbar receipt only after durable manual prompt admission", async () => {
    params = { id: "session-1" }
    const gate = Promise.withResolvers<void>()
    promptAdmissionPromise = gate.promise
    let committed = 0
    const submit = createExistingSessionSubmit({ beforeSubmit: async (context) => {
      expect(context.standardAppend).toBe(true)
      return { commit() { committed++ } }
    } })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(committed).toBe(0)
    await submit.handleSubmit({ preventDefault() {} } as Event)
    expect(sentPrompts).toHaveLength(1)
    gate.resolve()
    await sending
    expect(committed).toBe(1)
  })

  test("failed admission and late selection failure never commit toolbar receipt", async () => {
    params = { id: "session-1" }
    let committed = 0
    const gate = Promise.withResolvers<void>()
    promptAdmissionPromise = gate.promise
    const submit = createExistingSessionSubmit({ beforeSubmit: async () => ({ commit() { committed++ } }) })
    const sending = submit.handleSubmit({ preventDefault() {} } as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    gate.reject(new Error("admission rejected"))
    await sending
    expect(committed).toBe(0)
    promptAdmissionPromise = undefined
    selectionPersistencePromise = Promise.reject(new Error("selection rejected"))
    await submit.handleSubmit({ preventDefault() {} } as Event)
    expect(committed).toBe(0)
  })

  test("explicit local Queue accepts the receipt without changing delivery", async () => {
    params = { id: "session-1" }
    let committed = 0
    let queued = 0
    const submit = createExistingSessionSubmit({
      working: () => true,
      shouldQueue: () => true,
      onQueue() { queued++ },
      beforeSubmit: async () => ({ commit() { committed++ } }),
    })
    await submit.handleSubmit({ preventDefault() {} } as Event)
    expect(queued).toBe(1)
    expect(committed).toBe(1)
    expect(admittedPrompts).toHaveLength(0)
  })

  test("Resume excludes standard append and programmatic submit skips the hook", async () => {
    params = { id: "session-1" }
    const eligible: boolean[] = []
    const submit = createExistingSessionSubmit({ beforeSubmit: async (context) => {
      eligible.push(context.standardAppend)
      return true
    } })
    await submit.handleSubmit({ preventDefault() {} } as Event, { resume: true })
    await submit.submitText({ text: "Continue", delivery: "steer" })
    expect(eligible).toEqual([false])
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sentShell).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("applies access-control defaults to newly created sessions", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(enabledAutoAccept).toEqual([{ sessionID: "session-1", directory: "/repo/worktree-a" }])
    expect(createPayloads[0]).toEqual({
      id: "session-1",
      agent: "agent",
      model: { providerID: "provider", id: "model" },
      location: { directory: "/repo/worktree-a" },
    })
  })

  test("sends the spawn-new-agent skill prompt to the current session", async () => {
    params = { id: "session-current" }
    variant = "high"
    const text = "/spawn-new-agent run in a separate agent"
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    configuredCommands.push({ name: "spawn-new-agent", description: "Spawn new agent", source: "skill" })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(createdSessions).toEqual([])
    expect(promoted).toEqual([])
    expect(addedSessionTabs).toEqual([])
    expect(activatedSessionTabs).toEqual([])
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-current",
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
        parts: [{ type: "text", text }],
      },
    ])
  })

  test("opens spawn-new-agent from a draft as a normal promoted session", async () => {
    const text = "/spawn-new-agent run from draft"
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    configuredCommands.push({ name: "spawn-new-agent", description: "Spawn new agent", source: "skill" })

    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      draftID: () => "draft-1",
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(promotedDrafts).toEqual([
      {
        draftID: "draft-1",
        tab: { server: "server-key", dirBase64: "/repo/main", sessionId: "session-1", createdEmpty: false },
      },
    ])
    expect(addedSessionTabs).toEqual([])
    expect(activatedSessionTabs).toEqual([
      { server: "server-key", dirBase64: "/repo/main", sessionId: "session-1", createdEmpty: false },
    ])
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        parts: [{ type: "text", text }],
      },
    ])
  })

  test("does not treat the old root slash command as a new-session command", async () => {
    params = { id: "session-current" }
    promptValue = [{ type: "text", content: "/root run the smoke test", start: 0, end: 24 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(createdSessions).toEqual([])
    expect(addedSessionTabs).toEqual([])
    expect(activatedSessionTabs).toEqual([])
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-current",
        parts: [{ type: "text", text: "/root run the smoke test" }],
      },
    ])
  })

  test("does not spawn without the spawn-new-agent skill being available", async () => {
    params = { id: "session-current" }
    const text = "/spawn-new-agent run the smoke test"
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(createdSessions).toEqual([])
    expect(addedSessionTabs).toEqual([])
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-current",
        parts: [{ type: "text", text }],
      },
    ])
  })

  test("preserves structured prompt parts when sending the skill command", async () => {
    params = { id: "session-current" }
    promptValue = [
      { type: "text", content: "/spawn-new-agent inspect ", start: 0, end: 25 },
      { type: "file", content: "@src/app.ts", start: 25, end: 36, path: "src/app.ts" },
      { type: "text", content: " with ", start: 36, end: 42 },
      { type: "agent", content: "@reviewer", start: 42, end: 51, name: "reviewer" },
    ]
    configuredCommands.push({ name: "spawn-new-agent", description: "Spawn new agent", source: "skill" })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(sentPrompts[0]?.parts).toMatchObject([
      { type: "text", text: "/spawn-new-agent inspect @src/app.ts with @reviewer" },
      {
        type: "file",
        filename: "app.ts",
        source: { text: "@src/app.ts", start: 25, end: 36 },
      },
      { type: "agent", name: "reviewer", source: { text: "@reviewer", start: 42, end: 51 } },
    ])
  })

  test("durably queues spawn-new-agent submits into a busy current session", async () => {
    params = { id: "session-current" }
    const text = "/spawn-new-agent continue elsewhere"
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    configuredCommands.push({ name: "spawn-new-agent", description: "Spawn new agent", source: "skill" })
    const queued: unknown[] = []

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-current" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: (draft) => queued.push(draft),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(queued).toEqual([])
    expect(createdSessions).toEqual([])
    expect(addedSessionTabs).toEqual([])
    expect(activatedSessionTabs).toEqual([])
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]).toMatchObject({
      sessionID: "session-current",
      delivery: "queue",
      parts: [{ type: "text", text }],
    })
  })

  test("sends busy followup with delivery=queue when followup setting is queue and shouldQueue is bypassed", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "while you are working", start: 0, end: 22 }]
    followupMode = "queue"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => false,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.delivery).toBe("queue")
  })

  test("sends busy followup with default steer when followup setting is steer", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "steer this", start: 0, end: 11 }]
    followupMode = "steer"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => false,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]?.delivery).toBeUndefined()
  })

  test("submits standalone host text as steer without changing the composer draft", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "keep this draft", start: 0, end: 15 }]
    let beforeSubmitCalls = 0
    const result = await createExistingSessionSubmit({
      working: () => true,
      beforeSubmit: async () => {
        beforeSubmitCalls++
        return false
      },
    }).submitText({ text: "Continue", delivery: "steer" })
    expect(result).toEqual({ ok: true })
    expect(beforeSubmitCalls).toBe(0)
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0]).toMatchObject({ sessionID: "session-1", prompt: { text: "Continue" }, delivery: "steer" })
    expect(promptValue).toEqual([{ type: "text", content: "keep this draft", start: 0, end: 15 }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
  })

  test("sends prompts when route has a session id before session info syncs", async () => {
    params = { id: "session-1" }

    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(createdSessions).toEqual([])
    expect(sentPrompts).toMatchObject([{ directory: "/repo/main", sessionID: "session-1" }])
  })

  test("adds optimization guidance to normal prompt requests without changing visible text", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "fix the failing test", start: 0, end: 20 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(eventOrder).toEqual(["access-control.sync", "v2.session.prompt"])
    expect(syncedAccessControl).toEqual([{ sessionID: "session-1", directory: "/repo/main" }])
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0].parts?.[0]).toMatchObject({ type: "text", text: "fix the failing test" })
    expect(sentPrompts[0].system).toContain("OpenCode optimization profile enabled")
    expect(sentPrompts[0].system).toContain("Self-test policy")
  })

  test("does not block prompt submission indefinitely when access-control sync hangs", async () => {
    params = { id: "session-1" }
    accessControlSyncPromise = new Promise(() => {})

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(eventOrder).toEqual(["access-control.sync", "v2.session.prompt"])
    expect(sentPrompts).toHaveLength(1)
  })

  test("deduplicates overlapping submits while admission is pending", async () => {
    params = { id: "session-1" }
    let release: () => void = () => undefined
    accessControlSyncPromise = new Promise<void>((resolve) => {
      release = resolve
    })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    const second = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()
    release()
    await Promise.all([first, second])

    expect(sentPrompts).toHaveLength(1)
  })

  test("sets the visible goal and sends the task as a normal prompt", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/goal ship it", start: 0, end: 13 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    const visibleGoals: Array<{ sessionID: string; sessionDirectory: string; goal: string }> = []

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onGoal: (input) => visibleGoals.push(input),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(visibleGoals).toEqual([{ sessionID: "session-1", sessionDirectory: "/repo/main", goal: "ship it" }])
    expect(sentCommands).toEqual([])
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        prompt: { text: "ship it" },
      },
    ])
  })

  test.each([
    "add second goal",
    "edit revised goal",
    "sisyphus first; second\nthird",
    "ADD\tsecond goal",
    "EDIT\nrevised goal",
    "SiSyPhUs\tfirst; second",
    "focus\tgoal-2",
  ])("sends goal plugin control %j unchanged without pinning a goal", async (args) => {
    params = { id: "session-1" }
    const text = `/goal ${args}`
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    const visibleGoals: Array<{ sessionID: string; sessionDirectory: string; goal: string }> = []

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onGoal: (input) => visibleGoals.push(input),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentCommands).toMatchObject([{ command: "goal", arguments: args }])
    expect(sentCommands).toHaveLength(1)
    expect(sentPrompts).toEqual([])
    expect(visibleGoals).toEqual([])
  })

  test("a later normal prompt after a goal pin is not sent as another goal command", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/goal ship it", start: 0, end: 13 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    const visibleGoals: Array<{ sessionID: string; sessionDirectory: string; goal: string }> = []

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onGoal: (input) => visibleGoals.push(input),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    promptValue = [{ type: "text", content: "now implement it", start: 0, end: 16 }]
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentCommands).toEqual([])
    expect(visibleGoals).toHaveLength(1)
    expect(sentPrompts.map((item) => item.prompt?.text)).toEqual(["ship it", "now implement it"])
  })

  test("queues a goal task instead of starting another command turn while working", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/goal ship it", start: 0, end: 13 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    const visibleGoals: Array<{ sessionID: string; sessionDirectory: string; goal: string }> = []
    const queued: Array<{ prompt: Prompt }> = []
    resetClearsPrompt = true

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      shouldQueue: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onGoal: (input) => visibleGoals.push(input),
      onQueue: (draft) => queued.push(draft),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(sentCommands).toEqual([])
    expect(sentPrompts).toEqual([])
    expect(visibleGoals).toEqual([{ sessionID: "session-1", sessionDirectory: "/repo/main", goal: "ship it" }])
    expect(queued).toHaveLength(1)
    expect(queued[0]?.prompt).toEqual([{ type: "text", content: "ship it", start: 0, end: 7 }])
    expect(promptResets).toHaveLength(1)
    expect(promptValue).toEqual([])
  })

  test("sends goal control arguments as a slash command without starting a task prompt", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "/goal clear", start: 0, end: 11 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    const visibleGoals: Array<{ sessionID: string; sessionDirectory: string; goal: string }> = []

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onGoal: (input) => visibleGoals.push(input),
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts).toEqual([])
    expect(visibleGoals).toEqual([{ sessionID: "session-1", sessionDirectory: "/repo/main", goal: "" }])
    expect(sentCommands).toMatchObject([{ command: "goal", arguments: "clear" }])
  })

  test("admits a draft goal before promoting the draft", async () => {
    promptValue = [{ type: "text", content: "/goal ship it", start: 0, end: 13 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      draftID: () => "draft-goal",
      newSessionWorktree: () => "main",
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([])
    expect(sentPrompts).toMatchObject([{ prompt: { text: "ship it" } }])
    expect(promotedDrafts).toHaveLength(1)
    expect(eventOrder.indexOf("v2.session.prompt")).toBeLessThan(eventOrder.indexOf("tabs.promoteDraft"))
    expect(eventOrder.indexOf("v2.session.prompt")).toBeLessThan(eventOrder.indexOf("local.session.promote"))
  })

  test("keeps an unavailable draft goal without creating or promoting a session", async () => {
    promptValue = [{ type: "text", content: "/goal keep this", start: 0, end: 15 }]
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      draftID: () => "draft-goal-missing",
      newSessionWorktree: () => "main",
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createdSessions).toEqual([])
    expect(sentCommands).toEqual([])
    expect(promotedDrafts).toEqual([])
    expect(promptResets).toEqual([])
    expect(toasts).toHaveLength(1)
  })

  test("sends skill slash commands as prompt references", async () => {
    params = { id: "session-1" }
    const text = "/visual-qa-testing verify the turn completion badge"
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    configuredCommands.push({ name: "visual-qa-testing", description: "Visual QA", source: "skill" })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(sentCommands).toHaveLength(0)
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        parts: [{ type: "text", text }],
      },
    ])
  })

  test("sends the full model chain with slash command followups", async () => {
    const text = "/review inspect the chain"
    const client = clientFor("/repo/main")
    configuredCommands.push({ name: "review", description: "Review" })

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: {
        data: { command: configuredCommands },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
      serverSync: {
        child: () => [undefined, () => undefined],
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        messageID: "message-chain-slash",
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
        chain: {
          id: "chain-1",
          name: "Review chain",
          steps: [
            { providerID: "provider-a", modelID: "model-a", variant: "low" },
            { providerID: "provider-b", modelID: "model-b", variant: "high" },
          ],
        },
      },
      messageID: "message-chain-slash",
      delivery: "steer",
    })

    expect(sentCommands).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        messageID: "message-chain-slash",
        command: "review",
        arguments: "inspect the chain",
        modelSnapshot: {
          providerID: "provider",
          id: "model",
          variant: "high",
          chain: {
            id: "chain-1",
            name: "Review chain",
            active: 0,
            steps: [
              { providerID: "provider-a", id: "model-a", variant: "low" },
              { providerID: "provider-b", id: "model-b", variant: "high" },
            ],
          },
        },
      },
    ])
  })

  test("sends drained queued slash followups through the active prompt path", async () => {
    const text = "/visual-qa-testing verify the queued followup"
    const client = clientFor("/repo/main")
    configuredCommands.push({ name: "visual-qa-testing", description: "Visual QA", source: "skill" })

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: {
        data: { command: configuredCommands },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
      serverSync: {
        child: () => [undefined, () => undefined],
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        messageID: "message-queued-slash",
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
      messageID: "message-queued-slash",
      queued: true,
      delivery: "queue",
    })

    expect(sentCommands).toHaveLength(0)
    expect(admittedPrompts).toHaveLength(0)
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        messageID: "message-queued-slash",
        delivery: "queue",
        parts: [{ type: "text", text }],
      },
    ])
  })

  test("sends queued followups through the active prompt path", async () => {
    const text = "run after the active turn"
    const client = clientFor("/repo/main")

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: {
        data: { command: configuredCommands },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
      serverSync: {
        child: () => [undefined, () => undefined],
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        messageID: "message-manual-busy-followup",
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
      messageID: "message-manual-busy-followup",
      queued: true,
      delivery: "queue",
    })

    expect(admittedPrompts).toHaveLength(0)
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        messageID: "message-manual-busy-followup",
        delivery: "queue",
        parts: [{ type: "text", text }],
      },
    ])
  })

  test("sends optimized queued followups through the active prompt path", async () => {
    const text = "long verifier output"
    const client = clientFor("/repo/main")

    await sendFollowupDraft({
      client: client as unknown as Parameters<typeof sendFollowupDraft>[0]["client"],
      sync: {
        data: { command: configuredCommands },
        session: {
          optimistic: {
            add: () => undefined,
            remove: () => undefined,
          },
        },
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["sync"],
      serverSync: {
        child: () => [undefined, () => undefined],
      } as unknown as Parameters<typeof sendFollowupDraft>[0]["serverSync"],
      draft: {
        sessionID: "session-1",
        sessionDirectory: "/repo/main",
        messageID: "message-optimized-followup",
        prompt: [{ type: "text", content: text, start: 0, end: text.length }],
        requestText: "compacted verifier output",
        system: "Use the compacted verifier context.",
        context: [],
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        variant: "high",
      },
      messageID: "message-optimized-followup",
      queued: true,
      delivery: "queue",
    })

    expect(admittedPrompts).toHaveLength(0)
    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        messageID: "message-optimized-followup",
        system: "Use the compacted verifier context.",
        delivery: "queue",
        parts: [
          {
            type: "text",
            text: "compacted verifier output",
          },
        ],
      },
    ])
  })

  test("steers active followups through the active prompt path", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "continue while running", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => false,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()

    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        agent: "agent",
        model: { providerID: "provider", modelID: "model" },
        parts: [{ type: "text", text: "continue while running" }],
      },
    ])
    expect(sentCommands).toHaveLength(0)
    expect(admittedPrompts).toHaveLength(0)
    expect(promptResets).toHaveLength(1)
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toMatchObject([
      {
        id: "session-1",
        title: "New session 1",
      },
    ])
    expect(optimisticSeeded).toEqual([true])
  })

  test("admits a docked draft prompt before promoting and disposing the draft", async () => {
    promptValue = [{ type: "text", content: "ship draft", start: 0, end: 10 }]

    await createDockedDraftSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentPrompts).toMatchObject([
      {
        directory: "/repo/main",
        sessionID: "session-1",
        parts: [{ type: "text", text: "ship draft" }],
      },
    ])
    expect(promotedDrafts).toHaveLength(1)
    expect(eventOrder.indexOf("v2.session.prompt")).toBeLessThan(eventOrder.indexOf("tabs.promoteDraft"))
    expect(eventOrder.indexOf("v2.session.prompt")).toBeLessThan(eventOrder.indexOf("local.session.promote"))
  })

  test("keeps draft model, agent, and create-worktree selection after prompt admission fails", async () => {
    const { Worktree } = await import("@/utils/worktree")
    promptValue = [{ type: "text", content: "retry prompt", start: 0, end: 12 }]
    selectedModel = { id: "custom-model", provider: { id: "custom-provider" } }
    selectedAgent = { name: "custom-agent" }
    variant = "high"
    let worktree = "create"
    let resets = 0
    let fail: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      fail = reject
    })

    const submission = createDockedDraftSubmit(undefined, {
      worktree: () => worktree,
      onWorktreeReset: () => {
        worktree = "main"
        resets += 1
      },
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    Worktree.ready(ServerScope.local, "/repo/main/new")
    await new Promise((resolve) => setTimeout(resolve, 0))
    fail(new Error("prompt admission failed"))
    await submission

    expect(sentPrompts.at(-1)).toMatchObject({
      directory: "/repo/main/new",
      agent: "custom-agent",
      model: { providerID: "custom-provider", modelID: "custom-model", variant: "high" },
    })
    expect(promoted).toEqual([])
    expect(promotedDrafts).toEqual([])
    expect(worktree).toBe("create")
    expect(resets).toBe(0)
    expect(selectedModel.id).toBe("custom-model")
    expect(selectedAgent.name).toBe("custom-agent")
  })

  test("keeps draft model, agent, and create-worktree selection after goal admission fails", async () => {
    const { Worktree } = await import("@/utils/worktree")
    promptValue = [{ type: "text", content: "/goal retry goal", start: 0, end: 16 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    selectedModel = { id: "custom-model", provider: { id: "custom-provider" } }
    selectedAgent = { name: "custom-agent" }
    variant = "high"
    let worktree = "create"
    let resets = 0
    let fail: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      fail = reject
    })

    const submission = createDockedDraftSubmit(undefined, {
      worktree: () => worktree,
      onWorktreeReset: () => {
        worktree = "main"
        resets += 1
      },
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    Worktree.ready(ServerScope.local, "/repo/main/new")
    await new Promise((resolve) => setTimeout(resolve, 0))
    fail(new Error("goal admission failed"))
    await submission

    expect(sentPrompts.at(-1)).toMatchObject({
      directory: "/repo/main/new",
      prompt: { text: "retry goal" },
      agent: "custom-agent",
      model: { providerID: "custom-provider", modelID: "custom-model", variant: "high" },
    })
    expect(promoted).toEqual([])
    expect(promotedDrafts).toEqual([])
    expect(worktree).toBe("create")
    expect(resets).toBe(0)
    expect(selectedModel.id).toBe("custom-model")
    expect(selectedAgent.name).toBe("custom-agent")
  })

  test("keeps draft model, agent, and create-worktree selection after shell admission fails", async () => {
    promptValue = [{ type: "text", content: "echo retry", start: 0, end: 10 }]
    selectedModel = { id: "custom-model", provider: { id: "custom-provider" } }
    selectedAgent = { name: "custom-agent" }
    variant = "high"
    let worktree = "create"
    let resets = 0
    let fail: (error: Error) => void = () => undefined
    shellAdmissionPromise = new Promise<void>((_, reject) => {
      fail = reject
    })

    const submission = createDockedDraftSubmit(undefined, {
      mode: "shell",
      worktree: () => worktree,
      onWorktreeReset: () => {
        worktree = "main"
        resets += 1
      },
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    fail(new Error("shell admission failed"))
    await submission

    expect(sentShell.at(-1)).toBe("/repo/main/new")
    expect(sentShellAgents.at(-1)).toBe("custom-agent")
    expect(promoted).toEqual([])
    expect(promotedDrafts).toEqual([])
    expect(worktree).toBe("create")
    expect(resets).toBe(0)
    expect(selectedModel.id).toBe("custom-model")
    expect(selectedAgent.name).toBe("custom-agent")
  })

  test("retries ambiguous session creation and prompt admission with the same IDs", async () => {
    promptValue = [{ type: "text", content: "retry exactly", start: 0, end: 13 }]
    let loseCreateResponse: (error: Error) => void = () => undefined
    sessionCreatePromise = new Promise<void>((_, reject) => {
      loseCreateResponse = reject
    })

    const submit = createDockedDraftSubmit()
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseCreateResponse(new Error("session create response lost"))
    await first

    sessionCreatePromise = undefined
    let losePromptResponse: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      losePromptResponse = reject
    })
    const second = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    losePromptResponse(new Error("prompt response lost"))
    await second

    promptAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createPayloads).toHaveLength(2)
    expect(createPayloads.map((item) => item.id)).toEqual(["session-1", "session-1"])
    expect(sentPrompts).toHaveLength(2)
    expect(sentPrompts.map((item) => ({ sessionID: item.sessionID, messageID: item.messageID }))).toEqual([
      { sessionID: "session-1", messageID: "message-1" },
      { sessionID: "session-1", messageID: "message-1" },
    ])
    expect(promoted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
    expect(promotedDrafts).toHaveLength(1)
  })

  test("reuses an existing-session message ID only for the same admitted prompt request", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "retry exactly", start: 0, end: 13 }]
    let loseResponse: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createExistingSessionSubmit()
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    loseResponse(new Error("prompt response lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    promptAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.map((item) => item.messageID)).toEqual(["message-1", "message-1"])
    expect(sentPrompts.map((item) => item.delivery)).toEqual([undefined, undefined])
    expect(sentPrompts[0]?.system).toBe(sentPrompts[1]?.system)
  })

  test("uses a new message ID when optimization changes the admitted prompt request", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "retry optimized", start: 0, end: 15 }]
    let loseResponse: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createExistingSessionSubmit()
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    loseResponse(new Error("prompt response lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    optimizationProfile = "off"
    promptAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.map((item) => item.messageID)).toEqual(["message-1", "message-2"])
    expect(sentPrompts[0]?.system).toContain("OpenCode optimization profile enabled")
    expect(sentPrompts[1]?.system).toBeUndefined()
  })

  test("uses a new message ID when verifier compaction changes the admitted request text", async () => {
    params = { id: "session-1" }
    const text = [
      "bun test",
      ...Array.from({ length: 900 }, (_, index) => `INFO verifier output line ${index} with routine details`),
      "FAIL: src/example.test.ts:42 expected true",
    ].join("\n")
    promptValue = [{ type: "text", content: text, start: 0, end: text.length }]
    let loseResponse: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createExistingSessionSubmit()
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    loseResponse(new Error("prompt response lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    compactVerifierContext = false
    promptAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.map((item) => item.messageID)).toEqual(["message-1", "message-2"])
    expect(sentPrompts[0]?.prompt?.text).toStartWith("The original prompt included long test/verifier output")
    expect(sentPrompts[1]?.prompt?.text).toBe(text)
  })

  test("uses a new message ID when a queued busy request is retried after the session becomes idle", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "retry delivery", start: 0, end: 14 }]
    followupMode = "queue"
    let working = true
    let loseResponse: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createExistingSessionSubmit({ working: () => working })
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    loseResponse(new Error("prompt response lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    working = false
    promptAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.map((item) => ({ messageID: item.messageID, delivery: item.delivery }))).toEqual([
      { messageID: "message-1", delivery: "queue" },
      { messageID: "message-2", delivery: undefined },
    ])
  })

  test("uses a new message ID when a queued busy request is explicitly retried as steer", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "retry as steer", start: 0, end: 14 }]
    followupMode = "queue"
    let working = true
    let forceSteer = false
    let loseResponse: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createExistingSessionSubmit({
      working: () => working,
      forceSteer: () => forceSteer,
    })
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    loseResponse(new Error("prompt response lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    working = false
    forceSteer = true
    promptAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentPrompts.map((item) => ({ messageID: item.messageID, delivery: item.delivery }))).toEqual([
      { messageID: "message-1", delivery: "queue" },
      { messageID: "message-2", delivery: "steer" },
    ])
  })

  test("retries an ambiguous command admission with the same session and message IDs", async () => {
    promptValue = [{ type: "text", content: "/commit retry exactly", start: 0, end: 21 }]
    configuredCommands.push({ name: "commit", description: "Commit" })
    let loseResponse: (error: Error) => void = () => undefined
    commandAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createDockedDraftSubmit()
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseResponse(new Error("command response lost"))
    await first

    commandAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createdSessions).toEqual(["/repo/main"])
    expect(sentCommands.map((item) => ({ sessionID: item.sessionID, messageID: item.messageID }))).toEqual([
      { sessionID: "session-1", messageID: "message-1" },
      { sessionID: "session-1", messageID: "message-1" },
    ])
    expect(promotedDrafts).toHaveLength(1)
  })

  test("retries an ambiguous command with the same ID after context-only changes", async () => {
    promptValue = [{ type: "text", content: "/commit retry exactly", start: 0, end: 21 }]
    configuredCommands.push({ name: "commit", description: "Commit" })
    let loseResponse: (error: Error) => void = () => undefined
    commandAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createDockedDraftSubmit()
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseResponse(new Error("command response lost"))
    await first

    prompt.context.add({ type: "file", path: "later.ts", comment: "new context", commentID: "later" })
    commandAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands.map((item) => item.messageID)).toEqual(["message-1", "message-1"])
    expect(promotedDrafts).toHaveLength(1)
  })

  test("keeps an existing-session command retry ID after context-only changes", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    promptValue = [{ type: "text", content: "/commit retry exactly", start: 0, end: 21 }]
    configuredCommands.push({ name: "commit", description: "Commit" })
    let loseResponse: (error: Error) => void = () => undefined
    commandAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createExistingSessionSubmit()
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseResponse(new Error("command response lost"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    prompt.context.add({ type: "file", path: "later.ts", comment: "new context", commentID: "later" })
    commandAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sentCommands.map((item) => item.messageID)).toEqual(["message-1", "message-1"])
  })

  test("does not repeat an ambiguous command after only its model changes", async () => {
    promptValue = [{ type: "text", content: "/commit retry exactly", start: 0, end: 21 }]
    configuredCommands.push({ name: "commit", description: "Commit" })
    let loseResponse: (error: Error) => void = () => undefined
    commandAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createDockedDraftSubmit()
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseResponse(new Error("command response lost"))
    await first

    selectedModel = { id: "different-model", provider: { id: "different-provider" } }
    commandAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toHaveLength(1)
    expect(toasts.at(-1)?.description).toContain("may already have run")
  })

  test("does not repeat an unchanged shell command after an ambiguous failure", async () => {
    promptValue = [{ type: "text", content: "echo once", start: 0, end: 9 }]
    let loseResponse: (error: Error) => void = () => undefined
    shellAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createDockedDraftSubmit(undefined, { mode: "shell" })
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseResponse(new Error("shell response lost"))
    await first
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(createdSessions).toEqual(["/repo/main"])
    expect(sentShell).toEqual(["/repo/main"])
    expect(promoted).toEqual([])
    expect(toasts.at(-1)?.description).toContain("may already have run")
  })

  test("does not repeat an ambiguous shell command after context, model, and image changes", async () => {
    promptValue = [{ type: "text", content: "remove-important-data", start: 0, end: 21 }]
    let loseResponse: (error: Error) => void = () => undefined
    shellAdmissionPromise = new Promise<void>((_, reject) => {
      loseResponse = reject
    })

    const submit = createDockedDraftSubmit(undefined, { mode: "shell" })
    const first = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    loseResponse(new Error("shell response lost"))
    await first

    prompt.context.add({ type: "file", path: "later.ts", comment: "new context", commentID: "later" })
    selectedModel = { id: "different-model", provider: { id: "different-provider" } }
    prompt.set([
      ...promptValue,
      {
        type: "image",
        id: "later-image",
        filename: "later.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,bGF0ZXI=",
      },
    ])
    shellAdmissionPromise = undefined
    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentShell).toHaveLength(1)
    expect(toasts.at(-1)?.description).toContain("may already have run")
  })

  test("coalesces a remounted draft submit and lets only the latest owner promote it", async () => {
    promptValue = [{ type: "text", content: "submit once", start: 0, end: 11 }]
    let admit: () => void = () => undefined
    promptAdmissionPromise = new Promise<void>((resolve) => {
      admit = resolve
    })
    let oldOwnerResets = 0
    let newOwnerResets = 0

    const first = createDockedDraftSubmit(undefined, {
      onWorktreeReset: () => {
        oldOwnerResets += 1
      },
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = createDockedDraftSubmit(undefined, {
      onWorktreeReset: () => {
        newOwnerResets += 1
      },
    }).handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    admit()
    await Promise.all([first, second])

    expect(createdSessions).toEqual(["/repo/main"])
    expect(sentPrompts).toHaveLength(1)
    expect(promoted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
    expect(promotedDrafts).toHaveLength(1)
    expect(oldOwnerResets).toBe(0)
    expect(newOwnerResets).toBe(1)
  })

  test("preserves a same-key context edit when normal prompt admission succeeds", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    promptValue = [{ type: "text", content: "check context", start: 0, end: 13 }]
    promptContextItems = [
      {
        type: "file",
        path: "changed.ts",
        comment: "old comment",
        commentID: "same-key",
        key: "file:changed.ts:same-key",
      },
    ]
    let syncAccess: () => void = () => undefined
    accessControlSyncPromise = new Promise<void>((resolve) => {
      syncAccess = resolve
    })

    const submission = createExistingSessionSubmit().handleSubmit({
      preventDefault: () => undefined,
    } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    promptContextItems = promptContextItems.map((item) => ({ ...item, comment: "new comment" }))
    syncAccess()
    await submission

    expect(promptContextItems).toEqual([
      {
        type: "file",
        path: "changed.ts",
        comment: "new comment",
        commentID: "same-key",
        key: "file:changed.ts:same-key",
      },
    ])
  })

  test("preserves a same-key context edit when normal prompt admission fails", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    promptValue = [{ type: "text", content: "check context", start: 0, end: 13 }]
    promptContextItems = [
      {
        type: "file",
        path: "changed.ts",
        comment: "old comment",
        commentID: "same-key",
        key: "file:changed.ts:same-key",
      },
    ]
    let syncAccess: () => void = () => undefined
    accessControlSyncPromise = new Promise<void>((resolve) => {
      syncAccess = resolve
    })
    let failAdmission: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      failAdmission = reject
    })

    const submission = createExistingSessionSubmit().handleSubmit({
      preventDefault: () => undefined,
    } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    promptContextItems = promptContextItems.map((item) => ({ ...item, comment: "new comment" }))
    syncAccess()
    await new Promise((resolve) => setTimeout(resolve, 0))
    failAdmission(new Error("prompt response lost"))
    await submission

    expect(promptContextItems).toEqual([
      {
        type: "file",
        path: "changed.ts",
        comment: "new comment",
        commentID: "same-key",
        key: "file:changed.ts:same-key",
      },
    ])
  })

  test("preserves a same-key context edit while an existing-session prompt is queued", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    promptValue = [{ type: "text", content: "queue context", start: 0, end: 13 }]
    promptContextItems = [
      {
        type: "file",
        path: "changed.ts",
        comment: "old comment",
        commentID: "same-key",
        key: "file:changed.ts:same-key",
      },
    ]
    let syncAccess: () => void = () => undefined
    accessControlSyncPromise = new Promise<void>((resolve) => {
      syncAccess = resolve
    })
    let queued = 0
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 1,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: () => true,
      onQueue: () => {
        queued += 1
      },
      onSubmit: () => undefined,
    })

    const submission = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    promptContextItems = promptContextItems.map((item) => ({ ...item, comment: "new comment" }))
    syncAccess()
    await submission

    expect(queued).toBe(1)
    expect(promptContextItems).toEqual([
      {
        type: "file",
        path: "changed.ts",
        comment: "new comment",
        commentID: "same-key",
        key: "file:changed.ts:same-key",
      },
    ])
  })

  test("transfers context and attachments added to a docked draft while admission is pending", async () => {
    promptValue = [{ type: "text", content: "ship draft", start: 0, end: 10 }]
    let admit: () => void = () => undefined
    promptAdmissionPromise = new Promise<void>((resolve) => {
      admit = resolve
    })

    const submission = createDockedDraftSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const nextPrompt: Prompt = [
      { type: "text", content: "follow up", start: 0, end: 9 },
      {
        type: "image",
        id: "late-image",
        filename: "late.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,bGF0ZQ==",
      },
    ]
    prompt.set(nextPrompt, 9)
    prompt.context.add({ type: "file", path: "late.ts", comment: "late context", commentID: "late-comment" })
    admit()
    await submission

    expect(transferredPrompts).toEqual([
      {
        prompt: nextPrompt,
        cursor: 9,
        scope: { dir: "/repo/main", id: "session-1" },
      },
    ])
    expect(transferredContexts).toMatchObject([
      {
        item: { type: "file", path: "late.ts", comment: "late context", commentID: "late-comment" },
        scope: { dir: "/repo/main", id: "session-1" },
      },
    ])
    expect(sentPrompts[0].parts).toEqual([{ type: "text", text: "ship draft" }])
    expect(promotedDrafts).toHaveLength(1)
  })

  test("keeps context edited under the same key while a draft goal admission is pending", async () => {
    promptValue = [{ type: "text", content: "/goal ship it", start: 0, end: 13 }]
    configuredCommands.push({ name: "goal", description: "Set a goal" })
    promptContextItems = [
      {
        type: "file",
        path: "changed.ts",
        comment: "old comment",
        commentID: "changed-comment",
        key: "file:changed.ts:changed-comment",
      },
      {
        type: "file",
        path: "unchanged.ts",
        comment: "unchanged comment",
        commentID: "unchanged-comment",
        key: "file:unchanged.ts:unchanged-comment",
      },
    ]
    let syncAccess: () => void = () => undefined
    accessControlSyncPromise = new Promise<void>((resolve) => {
      syncAccess = resolve
    })

    const submission = createDockedDraftSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    promptContextItems = promptContextItems.map((item) =>
      item.commentID === "changed-comment" ? { ...item, comment: "newer comment" } : item,
    )
    syncAccess()
    await submission

    expect(promptContextItems).toEqual([
      {
        type: "file",
        path: "changed.ts",
        comment: "newer comment",
        commentID: "changed-comment",
        key: "file:changed.ts:changed-comment",
      },
    ])
    expect(transferredContexts).toMatchObject([
      {
        item: {
          type: "file",
          path: "changed.ts",
          comment: "newer comment",
          commentID: "changed-comment",
        },
        scope: { dir: "/repo/main", id: "session-1" },
      },
    ])
  })

  test("merges a failed existing-session prompt with newer text, attachments, and context", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    promptValue = [{ type: "text", content: "first request", start: 0, end: 13 }]
    let fail: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      fail = reject
    })

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    prompt.set(
      [
        { type: "text", content: "newer draft", start: 0, end: 11 },
        {
          type: "image",
          id: "newer-image",
          filename: "newer.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,bmV3ZXI=",
        },
      ],
      11,
    )
    prompt.context.add({ type: "file", path: "newer.ts", comment: "keep this", commentID: "newer-comment" })
    fail(new Error("admission failed"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      promptValue
        .filter((part) => "content" in part)
        .map((part) => part.content)
        .join(""),
    ).toBe("first request\n\nnewer draft")
    expect(promptValue).toContainEqual(expect.objectContaining({ type: "image", id: "newer-image" }))
    expect(promptContextItems).toMatchObject([
      { type: "file", path: "newer.ts", comment: "keep this", commentID: "newer-comment" },
    ])
  })

  test("deduplicates overlapping file and agent references while preserving failed and pending text", async () => {
    params = { id: "session-1" }
    activeTab = { type: "session", sessionId: "session-1" }
    promptValue = [
      { type: "text", content: "first text ", start: 0, end: 11 },
      { type: "file", path: "shared.ts", content: "@shared.ts", start: 11, end: 21 },
      { type: "agent", name: "reviewer", content: "@reviewer", start: 21, end: 30 },
    ]
    let fail: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      fail = reject
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    prompt.set(
      [
        { type: "text", content: "pending text ", start: 0, end: 13 },
        { type: "file", path: "shared.ts", content: "@shared.ts", start: 13, end: 23 },
        { type: "agent", name: "reviewer", content: "@reviewer", start: 23, end: 32 },
        { type: "file", path: "new.ts", content: "@new.ts", start: 32, end: 39 },
      ],
      39,
    )
    fail(new Error("admission failed"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(
      promptValue
        .filter((part) => part.type === "text")
        .map((part) => part.content)
        .join(""),
    ).toBe("first text \n\npending text ")
    expect(promptValue.filter((part) => part.type === "file" && part.path === "shared.ts")).toHaveLength(1)
    expect(promptValue.filter((part) => part.type === "agent" && part.name === "reviewer")).toHaveLength(1)
    expect(promptValue.filter((part) => part.type === "file" && part.path === "new.ts")).toHaveLength(1)
  })

  test("adds a late undocked new session in the background after the user navigates away", async () => {
    params = {}
    activeTab = undefined
    promptValue = [{ type: "text", content: "ship root prompt", start: 0, end: 16 }]
    let admit: () => void = () => undefined
    promptAdmissionPromise = new Promise<void>((resolve) => {
      admit = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "main",
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const submission = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    params.id = "session-other"
    activeTab = { type: "session", sessionId: "session-other" }
    admit()
    await submission

    expect(promoted).toEqual([{ directory: "/repo/main", sessionID: "session-1" }])
    expect(addedSessionTabs).toEqual([
      {
        server: "server-key",
        dirBase64: "/repo/main",
        sessionId: "session-1",
        createdEmpty: false,
      },
    ])
    expect(activatedSessionTabs).toEqual([])
  })

  test("promotes a draft without stealing focus after the user switches tabs during admission", async () => {
    promptValue = [{ type: "text", content: "ship draft", start: 0, end: 10 }]
    let admit: () => void = () => undefined
    promptAdmissionPromise = new Promise<void>((resolve) => {
      admit = resolve
    })

    const submission = createDockedDraftSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    activeTab = { type: "draft", draftID: "draft-2" }
    admit()
    await submission

    expect(promotedDrafts).toHaveLength(1)
    expect(activatedSessionTabs).toEqual([])
  })

  test("does not reopen a draft closed while admission is pending", async () => {
    promptValue = [{ type: "text", content: "ship draft", start: 0, end: 10 }]
    let admit: () => void = () => undefined
    promptAdmissionPromise = new Promise<void>((resolve) => {
      admit = resolve
    })

    const submission = createDockedDraftSubmit().handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await new Promise((resolve) => setTimeout(resolve, 0))
    activeTab = undefined
    admit()
    await submission

    expect(promotedDrafts).toHaveLength(1)
    expect(activatedSessionTabs).toEqual([])
  })

  test("restores a failed inactive draft without focusing its editor", async () => {
    promptValue = [{ type: "text", content: "ship draft", start: 0, end: 10 }]
    const editor = document.createElement("div")
    editor.tabIndex = 0
    document.body.append(editor)
    let focused = 0
    editor.focus = () => {
      focused += 1
    }
    let fail: (error: Error) => void = () => undefined
    promptAdmissionPromise = new Promise<void>((_, reject) => {
      fail = reject
    })

    try {
      const submission = createDockedDraftSubmit(() => editor).handleSubmit({
        preventDefault: () => undefined,
      } as unknown as Event)
      await new Promise((resolve) => setTimeout(resolve, 0))
      activeTab = { type: "draft", draftID: "draft-2" }
      fail(new Error("admission failed"))
      await submission
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(focused).toBe(0)
      expect(promptValue).toEqual([{ type: "text", content: "ship draft", start: 0, end: 10 }])
    } finally {
      editor.remove()
    }
  })

  test("an empty submit while working does not interrupt the running session", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    let onAbort = 0
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => {
        onAbort += 1
      },
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(aborted).toEqual([])
    expect(onAbort).toBe(0)
    expect(sessionStatusUpdates).toHaveLength(0)
    expect(toasts).toEqual([])
  })

  test("stop aborts the running session without restoring a pending draft", async () => {
    const { Worktree } = await import("@/utils/worktree")
    params = { id: "session-1" }
    const scope = ServerScope.local
    Worktree.pending(scope, "/repo/main")
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    await Promise.resolve()
    await submit.abort()

    expect(aborted).toEqual(["/repo/main"])
    expect(sessionStatusUpdates).toContainEqual({ directory: "/repo/main", sessionID: "session-1", type: "idle" })
    expect(promptResets).toHaveLength(1)
    expect(promptSets).toHaveLength(0)
    Worktree.ready(scope, "/repo/main")
  })

  test("keeps the followup queue active and reports an interrupt failure", async () => {
    params = { id: "session-1" }
    interruptError = new Error("interrupt unavailable")
    let onAbort = 0
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => {
        onAbort += 1
      },
      onSubmit: () => undefined,
    })

    await submit.abort()

    expect(aborted).toEqual(["/repo/main"])
    expect(onAbort).toBe(0)
    expect(toasts).toEqual([{ title: "common.requestFailed", description: "interrupt unavailable" }])
    expect(sessionStatusUpdates).toHaveLength(0)
  })

  test("does not overwrite a newer busy activity after stop settles", async () => {
    params = { id: "session-1" }
    let releaseInterrupt = () => {}
    interruptGate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    let onAbort = 0
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => {
        onAbort += 1
      },
      onSubmit: () => undefined,
    })

    const stopping = submit.abort()
    while (interruptReads === 0) await Promise.resolve()
    startSessionActivity("/repo/main", "session-1", "activity_new")
    releaseInterrupt()
    await stopping

    expect(sessionStatusUpdates).toHaveLength(0)
    expect(statusReads).toBe(0)
    expect(onAbort).toBe(1)
    finishSessionActivity("/repo/main", "session-1", "activity_new")
  })

  test("tombstones the stopped activity even if a busy status snapshot arrives during interrupt", async () => {
    params = { id: "session-status-race" }
    startSessionActivity("/repo/main", "session-status-race", "activity_same")
    let releaseInterrupt = () => {}
    interruptGate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-status-race" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const stopping = submit.abort()
    while (interruptReads === 0) await Promise.resolve()
    updateSessionActivity("/repo/main", "session-status-race", { type: "busy" })
    releaseInterrupt()
    await stopping

    expect(startSessionActivity("/repo/main", "session-status-race", "activity_same")).toBeFalse()
    expect(sessionStatusUpdates).toContainEqual({
      directory: "/repo/main",
      sessionID: "session-status-race",
      type: "idle",
    })
  })

  test("applies idle immediately after stop without waiting for session status", async () => {
    params = { id: "session-duplicate" }
    startSessionActivity("/repo/main", "session-duplicate", "activity_same")
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-duplicate" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.abort()

    expect(statusReads).toBe(0)
    expect(sessionStatusUpdates).toContainEqual({
      directory: "/repo/main",
      sessionID: "session-duplicate",
      type: "idle",
    })
    expect(startSessionActivity("/repo/main", "session-duplicate", "activity_same")).toBeFalse()
    finishSessionActivity("/repo/main", "session-duplicate", "activity_same")
  })

  test("pauses followups on interrupt and preserves a newer activity", async () => {
    const sessionID = "session-status-empty"
    params = { id: sessionID }
    let releaseInterrupt = () => {}
    interruptGate = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    let onAbort = 0
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: sessionID }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => true,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onAbort: () => {
        onAbort += 1
      },
      onSubmit: () => undefined,
    })

    const stopping = submit.abort()
    while (interruptReads === 0) await Promise.resolve()
    expect(onAbort).toBe(0)
    startSessionActivity("/repo/main", sessionID, "activity_new")
    releaseInterrupt()
    await stopping

    expect(statusReads).toBe(0)
    expect(onAbort).toBe(1)
    expect(sessionStatusUpdates).toHaveLength(0)
    finishSessionActivity("/repo/main", sessionID, "activity_new")
  })

  test("submits Continue through the resume option without re-adding history", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]
    const historyAdds: unknown[] = []
    let resetCount = 0

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: (entry) => historyAdds.push(entry),
      resetHistoryNavigation: () => {
        resetCount += 1
      },
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event, {
      resume: true,
      prompt: [{ type: "text", content: "Run the agent once", start: 0, end: 17 }],
      context: [],
    })
    await Promise.resolve()

    expect(eventOrder).toEqual(["access-control.sync", "v2.session.prompt"])
    expect(sentPrompts).toHaveLength(1)
    expect(sentPrompts[0].parts?.[0]).toMatchObject({ type: "text", text: "Continue" })
    expect(historyAdds).toHaveLength(0)
    expect(resetCount).toBe(0)
  })

  test("an empty idle submit without the resume option is a no-op", async () => {
    params = { id: "session-1" }
    promptValue = [{ type: "text", content: "", start: 0, end: 0 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentPrompts).toHaveLength(0)
    expect(aborted).toHaveLength(0)
  })
})
