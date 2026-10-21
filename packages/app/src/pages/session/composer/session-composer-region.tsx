import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { useLayout } from "@/context/layout"
import { PromptInput, type PromptInputState } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionGoalDock } from "@/pages/session/composer/session-goal-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SubagentSessionBar } from "@/pages/session/composer/subagent-session-bar"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { composerModelLoading } from "@/pages/session/composer/session-composer-readiness"
import { providerQueryErrorVisible } from "@/context/global-sync/provider-query-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { runningModelStatus } from "@/pages/session/composer/session-running-status"
import { SessionUsageStatus } from "@/pages/session/composer/session-usage-status-indicator"
import {
  sessionActivity,
  sessionActivityGeneration,
  sessionActivityID,
  sessionActivitySettled,
  sessionActivityStartedAt,
} from "@/utils/session-activity"
import { questionDockPaneId, questionRequestKey } from "@/pages/session/composer/session-request-tree"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { createQuery } from "@tanstack/solid-query"
import { useQueryOptions } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { pathKey } from "@/utils/path-key"
import { useLocal } from "@/context/local"
import { useProviders } from "@/hooks/use-providers"
import { useSettings } from "@/context/settings"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useDirectoryPicker } from "@/components/directory-picker"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { displayName, errorMessage, latestRootSession, projectsForDirectorySelection } from "@/pages/layout/helpers"
import { getFilename } from "@opencode-ai/core/util/path"
import { showToast } from "@/utils/toast"
import type { LocalProject } from "@/context/layout"
import type { SurfaceBlockingRequest } from "@opencode-ai/sdk/v2"
import { focusDockPromptInputForSession } from "@/utils/focus"
import {
  questionRequestErrorMessage,
  questionSessionSettlement,
  questionSettlementPending,
  retryQuestionSettlement,
} from "@/context/question-request"

type ProjectMoveStep = "target" | "changes"
type ProjectMoveOption = {
  label: string
  description: string
  onSelect: () => void
}

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  disabled?: boolean
  centered: boolean
  placement?: "dock" | "inline"
  draftID?: string
  promptState?: PromptInputState
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  followup?: {
    queue: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    failed?: string
    paused?: boolean
    onPause?: () => void
    onResume?: () => void
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    forceSteer: () => boolean
    onForceSteerSent: () => void
    onGoal: (input: { sessionID: string; sessionDirectory: string; goal: string }) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onDelete: (id: string) => void
    onMove: (id: string, beforeID: string) => void
    onEditLoaded: () => void
  }
  goal?: {
    value: string
    onClear: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    blocked?: boolean
    blockedReason?: "conflict" | "unattributed"
    conflicts?: { resource: string; message: string }[]
    restoring?: string
    disabled?: boolean
    onRestoreCheckpoint: () => void
    onKeepFiles: () => void
    onRestoreMessage: (id: string) => void
    onRestoreBoth: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const navigate = useNavigate()
  const layout = useLayout()
  const contextPrompt = usePrompt()
  const prompt = () => props.promptState ?? contextPrompt
  const language = useLanguage()
  const route = useSessionKey()
  const sync = useSync()
  const serverSync = useServerSync()
  const sdk = useSDK()
  const queryOptions = useQueryOptions()
  const local = useLocal()
  const providers = useProviders()
  const settings = useSettings()
  const server = useServer()
  const tabs = useTabs()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const view = layout.view(route.sessionKey)
  const sessionID = createMemo(() => (props.draftID ? undefined : route.params.id))
  const [projectMove, setProjectMove] = createStore({
    step: "target" as ProjectMoveStep,
    project: undefined as LocalProject | undefined,
    directory: undefined as string | undefined,
    moving: false,
  })

  const agentsQuery = createQuery(() => queryOptions().agents(pathKey(sdk().directory), sdk().directory))
  const globalProviderQueryOptions = createMemo(() => queryOptions().providers(null))
  const globalProvidersQuery = createQuery(() => globalProviderQueryOptions())
  const [providerRetrying, setProviderRetrying] = createSignal(false)
  const directoryProviders = createMemo(() => serverSync().child(pathKey(sdk().directory))[0])
  const projects = createMemo(() =>
    projectsForDirectorySelection(layout.projects.list(), serverSync().data.project ?? [], sdk().directory),
  )
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return "idle"
    return sync().data.session_status[id]?.type ?? "idle"
  })
  const runningStatus = createMemo(() => {
    const id = sessionID()
    if (!id || sessionActivitySettled(sdk().directory, id)) return
    return runningModelStatus({
      status: sessionActivity(sdk().directory, id)?.type ?? sessionStatus(),
      messages: sync().data.message[id],
      startedAt: sessionActivityStartedAt(sdk().directory, id),
      session: sync().session.get(id),
    })
  })
  const projectSwitchDisabled = createMemo(() => !!sessionID() && (sessionStatus() !== "idle" || projectMove.moving))
  const sessionBeforeFirstMessage = createMemo(() => {
    const id = sessionID()
    if (!id) return true
    const messages = sync().data.message[id]
    if (messages)
      return messages.every((message) => {
        const parts = sync().data.part[message.id] ?? []
        return message.role !== "user" && parts.length === 0
      })
    const activeTab = tabs.active()
    return activeTab?.type === "session" && activeTab.sessionId === id && activeTab.createdEmpty === true
  })
  const projectForWorktree = (worktree: string) => {
    const key = pathKey(worktree)
    return projects().find((project) => pathKey(project.worktree) === key)
  }
  const projectMoveDirectories = createMemo(() => {
    const project = projectMove.project
    if (!project) return []
    return [project.worktree, ...(project.sandboxes ?? [])]
  })
  const projectMoveLastDirectory = createMemo(
    () =>
      latestRootSession(
        projectMoveDirectories().map((directory) => serverSync().child(directory, { bootstrap: false })[0]),
        Date.now(),
      )?.directory,
  )
  const projectMoveTargetCandidates = createMemo(() => {
    const project = projectMove.project
    if (!project) return []
    const seen = new Set<string>()
    return [project.worktree, projectMoveLastDirectory(), ...(project.sandboxes ?? [])].filter(
      (directory): directory is string => {
        if (!directory) return false
        const key = pathKey(directory)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
    )
  })
  const startProjectMove = (project: LocalProject) => {
    setProjectMove({
      step: "target",
      project,
      directory: undefined,
      moving: false,
    })
  }
  const cancelProjectMove = () => {
    if (projectMove.moving) return
    setProjectMove({
      step: "target",
      project: undefined,
      directory: undefined,
      moving: false,
    })
  }
  const chooseProjectMoveDirectory = (directory: string) => {
    setProjectMove({
      step: "changes",
      directory,
    })
  }
  const preservePromptForDirectory = (directory: string, id?: string) => {
    if (!prompt().dirty()) return
    const current = prompt().current()
    prompt().set(
      current,
      prompt().cursor() ??
        current.reduce((length, part) => ("content" in part ? length + part.content.length : length), 0),
      { dir: base64Encode(directory), id },
    )
  }
  const moveSessionProjectTo = async (
    directory: string,
    moveChanges: boolean,
    project?: LocalProject,
    options?: { showPrompt?: boolean },
  ) => {
    const id = sessionID()
    if (!id) return

    const sourceDirectory = sdk().directory
    const sourceSync = sync()
    setProjectMove({
      step: "target",
      project: options?.showPrompt === false ? undefined : project,
      directory,
      moving: true,
    })
    try {
      const response = await sdk().client.experimental.controlPlane.moveSession({
        sessionID: id,
        destination: { directory },
        moveChanges,
      })
      if (!response.data) throw new Error("Move session did not return a result")
      local.session.promote(response.data.directory, id)
      preservePromptForDirectory(response.data.directory, id)
      if (project) {
        layout.projects.open(project.worktree)
        server.projects.touch(project.worktree)
      }
      tabs.moveSessions({
        fromDirectory: sourceDirectory,
        toDirectory: response.data.directory,
        sessionIDs: response.data.sessionIDs,
        selectSessionID: id,
      })
      tabs.select({
        type: "session",
        server: server.key,
        dirBase64: base64Encode(response.data.directory),
        sessionId: id,
      })
      setProjectMove({
        step: "target",
        project: undefined,
        directory: undefined,
        moving: false,
      })
      const targetSync = serverSync().createDirSyncContext(response.data.directory)
      response.data.sessionIDs.forEach((sessionID) => sourceSync.session.evict(sessionID, sourceDirectory))
      void Promise.all([
        ...response.data.sessionIDs.map((sessionID) => targetSync.session.sync(sessionID, { force: true })),
        serverSync().project.loadSessions(sourceDirectory),
        serverSync().project.loadSessions(response.data.directory),
      ]).catch((error) => {
        console.warn("Failed to refresh moved session caches", error)
      })
    } catch (error) {
      console.error("Failed to move session project", error)
      setProjectMove("moving", false)
      showToast({
        variant: "error",
        title: "Could not move session",
        description: errorMessage(error, "The session project could not be changed."),
      })
    }
  }
  const chooseCustomProjectMoveDirectory = () => {
    if (!server.current) return
    pickDirectory({
      server: server.current,
      title: "Choose target directory",
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) chooseProjectMoveDirectory(directory)
      },
    })
  }
  const moveSessionProject = async (moveChanges: boolean) => {
    const directory = projectMove.directory
    if (!directory) return
    await moveSessionProjectTo(directory, moveChanges, projectMove.project)
  }
  const projectMoveTargetOptions = createMemo<ProjectMoveOption[]>(() => {
    const project = projectMove.project
    if (!project) return []
    const last = projectMoveLastDirectory()
    const targets = projectMoveTargetCandidates().map((directory, index) => {
      const label =
        index === 0
          ? "Project root"
          : last && pathKey(last) === pathKey(directory)
            ? `Last used: ${getFilename(directory) || directory}`
            : `Workspace: ${getFilename(directory) || directory}`
      return {
        label,
        description: directory,
        onSelect: () => chooseProjectMoveDirectory(directory),
      }
    })
    return [
      ...targets,
      {
        label: "Choose directory",
        description: "Pick another directory for this project move.",
        onSelect: chooseCustomProjectMoveDirectory,
      },
    ]
  })
  const projectMoveChangesOptions = createMemo<ProjectMoveOption[]>(() => [
    {
      label: "Move session only",
      description: "Change the session project and keep local file changes in the current directory.",
      onSelect: () => void moveSessionProject(false),
    },
    {
      label: "Move session and copy changes",
      description: "Apply current local changes in the destination and reset them from the current directory.",
      onSelect: () => void moveSessionProject(true),
    },
  ])
  const selectProject = (worktree: string) => {
    if (props.draftID) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      tabs.updateDraft(props.draftID, { server: server.key, directory: worktree })
      return
    }
    if (search.draftId) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: server.key, directory: worktree })
      return
    }
    const id = sessionID()
    if (id) {
      if (projectSwitchDisabled()) {
        showToast({
          variant: "error",
          title: "Session is active",
          description: "Wait until the session is idle before changing its project.",
        })
        return
      }
      const project = projectForWorktree(worktree)
      if (project) {
        if (sessionBeforeFirstMessage()) {
          void moveSessionProjectTo(project.worktree, false, project, { showPrompt: false })
          return
        }
        startProjectMove(project)
        return
      }
    }
    layout.projects.open(worktree)
    server.projects.touch(worktree)
    preservePromptForDirectory(worktree)
    navigate(`/${base64Encode(worktree)}/session`)
  }
  const addProject = (title: string) => {
    if (!server.current) return
    pickDirectory({
      server: server.current,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory)
      },
    })
  }
  const controls = createMemo(() => ({
    selection: local.selection,
    agents: {
      available: sync().data.agent,
      options: local.agent.list().map((agent) => agent.name),
      current: local.agent.current()?.name ?? "",
      loading: agentsQuery.isLoading,
      visible: settings.visibility.customAgents(),
      refresh: async () => {
        const result = await agentsQuery.refetch()
        if (result.data) sync().set("agent", reconcile(result.data, { merge: false }))
      },
      select: local.agent.set,
    },
    model: {
      selection: local.model,
      paid: providers.paid().length > 0,
      retrying: providerRetrying(),
      loading: composerModelLoading({
        directoryLoading: !directoryProviders().provider_ready,
        directoryHasProviders: directoryProviders().provider.all.size > 0,
        globalLoading: globalProvidersQuery.isFetching,
        retrying: providerRetrying(),
      }),
      error: providerQueryErrorVisible({
        isError: globalProvidersQuery.isError,
        isFetching: globalProvidersQuery.isFetching,
      }) || directoryProviders().provider_error,
      retry: () => {
        if (providerRetrying()) return
        setProviderRetrying(true)
        void serverSync().refreshProviders(sdk().directory).then(
          () => setProviderRetrying(false),
          () => setProviderRetrying(false),
        )
      },
    },
    projects: {
      available: projects(),
      directory: sdk().directory,
      disabled: projectSwitchDisabled(),
      select: selectProject,
      add: addProject,
    },
    session: {
      id: sessionID(),
      tabs: layout.tabs(route.sessionKey),
      reviewPanel: view.reviewPanel,
    },
  }))

  const handoffPrompt = createMemo(() => (props.draftID ? undefined : getSessionHandoff(route.sessionKey())?.prompt))
  const info = createMemo(() => (sessionID() ? sync().session.get(sessionID()!) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())

  const [editorReady, setEditorReady] = createSignal(false)
  createEffect(() => {
    if (prompt().ready()) setEditorReady(true)
  })

  const previewPrompt = () =>
    prompt()
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (props.draftID) return
    if (!prompt().ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
  })
  const [questionStore, setQuestionStore] = createStore({
    hidden: {} as Record<string, true>,
    active: undefined as string | undefined,
  })
  const questionDockVisible = (request: SurfaceBlockingRequest) => layout.dock.itemVisible(questionDockPaneId(request))
  const visibleSurfaceBlockingRequests = createMemo(() =>
    props.state
      .questionRequests()
      .filter((request) => !questionStore.hidden[questionRequestKey(request)] && !questionDockVisible(request)),
  )
  const activeSurfaceBlockingRequest = createMemo(() => {
    const requests = visibleSurfaceBlockingRequests()
    return requests.find((request) => questionRequestKey(request) === questionStore.active) ?? requests[0]
  })
  const activeQuestionKey = createMemo(() => {
    const request = activeSurfaceBlockingRequest()
    return request ? questionRequestKey(request) : undefined
  })
  const activeQuestionIndex = createMemo(() => {
    const request = activeSurfaceBlockingRequest()
    if (!request) return -1
    return visibleSurfaceBlockingRequests().findIndex(
      (item) => item.sessionID === request.sessionID && item.id === request.id,
    )
  })
  const setActiveQuestion = (request: SurfaceBlockingRequest | undefined) => {
    setQuestionStore("active", request ? questionRequestKey(request) : undefined)
  }
  const moveQuestion = (offset: number) => {
    const requests = visibleSurfaceBlockingRequests()
    if (requests.length <= 1) return
    const next = requests[(Math.max(0, activeQuestionIndex()) + offset + requests.length) % requests.length]
    setActiveQuestion(next)
  }
  const dismissActiveQuestion = () => {
    const request = activeSurfaceBlockingRequest()
    if (!request) return
    setQuestionStore("hidden", questionRequestKey(request), true)
    focusDockPromptInputForSession(request.sessionID)
  }
  const composerBlocked = createMemo(() => !!props.state.permissionRequest() || questionSettlementPending(sessionID()))
  const questionSettlement = createMemo(() => questionSessionSettlement(sessionID()))
  const showComposer = createMemo(() => !composerBlocked() || child())

  createEffect(() => {
    const valid = new Set(props.state.questionRequests().map(questionRequestKey))
    setQuestionStore(
      "hidden",
      (hidden) => Object.fromEntries(Object.entries(hidden).filter(([key]) => valid.has(key))) as Record<string, true>,
    )
  })

  createEffect(() => {
    const request = activeSurfaceBlockingRequest()
    if (!request) {
      setActiveQuestion(undefined)
      return
    }
    if (questionStore.active !== questionRequestKey(request)) setActiveQuestion(request)
  })
  let timer: number | undefined
  let frame: number | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  createEffect(() => {
    route.sessionKey()
    const ready = props.ready
    const delay = 40

    clear()
    setStore("ready", false)
    setEditorReady(false)
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(clear)

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const todos = createMemo(() => (sessionID() ? props.state.todos() : []))
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  const openParent = () => {
    const id = parentID()
    if (!id) return
    tabs.openSessionTab({ server: server.key, dirBase64: base64Encode(sdk().directory), sessionId: id })
  }

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(store.body, update)
    update()
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "relative z-[70] w-full flex flex-col justify-center items-center pointer-events-none": true,
        "shrink-0 pb-3 bg-background-stronger": props.placement !== "inline",
      }}
    >
      <div
        classList={{
          "w-full pointer-events-auto": true,
          "px-3": props.placement !== "inline",
          [NEW_SESSION_CONTENT_WIDTH]: props.placement === "inline",
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <Show when={questionSettlement()}>
          {(settlement) => (
            <div
              data-component="question-settlement-status"
              class="mb-2 flex items-center justify-between gap-3 rounded-md border border-border-weak-base bg-background-base px-3 py-2"
              aria-live="polite"
            >
              <div class="min-w-0 flex items-center gap-2 text-13-regular text-text-base">
                <Show when={settlement().status === "settling"}>
                  <Spinner />
                </Show>
                <span data-slot="question-settlement-message" class="truncate">
                  {settlement().status === "reconcile"
                    ? `${language.t("common.requestFailed")}: ${questionRequestErrorMessage(settlement().error)}`
                    : language.t("session.question.status.sending")}
                </span>
              </div>
              <Show when={settlement().status === "reconcile"}>
                <Button
                  variant="secondary"
                  size="normal"
                  onClick={() => {
                    const id = sessionID()
                    if (id) retryQuestionSettlement(id)
                  }}
                >
                  {language.t("session.messages.unavailable.retry")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <Show when={activeQuestionKey()} keyed>
          {(_) => (
            <Show when={activeSurfaceBlockingRequest()}>
              {(request) => (
                <div>
                  <SessionQuestionDock
                    request={request()}
                    collapsible
                    queueIndex={activeQuestionIndex() + 1}
                    queueTotal={visibleSurfaceBlockingRequests().length}
                    onPrevious={() => moveQuestion(-1)}
                    onNext={() => moveQuestion(1)}
                    onLocalDismiss={dismissActiveQuestion}
                    onSubmit={props.onResponseSubmit}
                    dock={{
                      currentArea: layout.dock.itemArea(questionDockPaneId(request())),
                      pinned: layout.dock.itemVisible(questionDockPaneId(request())),
                      onDock: (area) => layout.dock.openItem(questionDockPaneId(request()), area),
                      onUnpin: () => layout.dock.closeItem(questionDockPaneId(request())),
                    }}
                  />
                </div>
              )}
            </Show>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  props.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={projectMove.project} keyed>
          {(project) => (
            <div class="pb-2">
              <SessionProjectMoveDock
                project={project}
                step={projectMove.step}
                targetDirectory={projectMove.directory}
                targetOptions={projectMoveTargetOptions()}
                changesOptions={projectMoveChangesOptions()}
                moving={projectMove.moving}
                onBack={() => setProjectMove("step", "target")}
                onCancel={cancelProjectMove}
              />
            </div>
          )}
        </Show>

        <Show when={showComposer()}>
          <Show
            when={editorReady() || prompt().ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        blocked={revert.blocked}
                        blockedReason={revert.blockedReason}
                        conflicts={revert.conflicts}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestoreCheckpoint={revert.onRestoreCheckpoint}
                        onKeepFiles={revert.onKeepFiles}
                        onRestoreMessage={revert.onRestoreMessage}
                        onRestoreBoth={revert.onRestoreBoth}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={dock() && todos().length > 0}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={sessionID()}
                    todos={todos()}
                    collapsed={view.todoCollapsed.get()}
                    onToggle={() => view.todoCollapsed.set(!view.todoCollapsed.get())}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                    badgeStatus={props.state.badgeStatus()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    blocked={revert.blocked}
                    blockedReason={revert.blockedReason}
                    conflicts={revert.conflicts}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestoreCheckpoint={revert.onRestoreCheckpoint}
                    onKeepFiles={revert.onKeepFiles}
                    onRestoreMessage={revert.onRestoreMessage}
                    onRestoreBoth={revert.onRestoreBoth}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.goal?.value}>
                <SessionGoalDock
                  goal={props.goal!.value}
                  onClear={props.goal!.onClear}
                  running={runningStatus() !== undefined}
                />
              </Show>
              <Show when={props.followup?.items.length}>
                <SessionFollowupDock
                  items={props.followup!.items}
                  sending={props.followup!.sending}
                  failed={props.followup!.failed}
                  paused={props.followup!.paused}
                  onPause={props.followup!.onPause}
                  onResume={props.followup!.onResume}
                  onSend={props.followup!.onSend}
                  onEdit={props.followup!.onEdit}
                  onDelete={props.followup!.onDelete}
                  onMove={props.followup!.onMove}
                />
              </Show>
              <Show
                when={child()}
                fallback={
                  <Show when={!composerBlocked()}>
                    <PromptInput
                      controls={controls()}
                      footerStatus={
                        <Show when={sessionID() || runningStatus()}>
                          <div
                            data-component="session-running-status"
                            aria-live="polite"
                            class="flex min-w-0 items-center gap-1 overflow-hidden text-12-regular text-text-weak"
                          >
                            <Show when={runningStatus()}>
                              {(status) => (
                                <>
                                  <span class="shrink-0">
                                    {status().status === "retry"
                                      ? language.t("session.child.status.retrying")
                                      : status().status === "waiting_for_user"
                                        ? language.t("session.running.waiting")
                                        : language.t("session.child.status.running")}
                                  </span>
                                  <Show when={status().agent}>
                                    <span class="shrink-0">· {status().agent}</span>
                                  </Show>
                                  <span data-slot="running-model" class="min-w-0 truncate font-medium text-text-base">
                                    · {status().model ?? language.t("session.running.resolvingModel")}
                                  </span>
                                  <Show when={status().variant}>
                                    <span class="shrink-0">· {status().variant}</span>
                                  </Show>
                                  <Show when={status().chain}>
                                    <span class="min-w-0 truncate">· {status().chain}</span>
                                  </Show>
                                </>
                              )}
                            </Show>
                            <Show when={sessionID()}>
                              {(id) => (
                                <SessionUsageStatus
                                  sessionID={id()}
                                  running={() => sessionStatus() !== "idle"}
                                  activityID={() => sessionActivityID(sdk().directory, id())}
                                  activityGeneration={() => sessionActivityGeneration(sdk().directory, id())}
                                  activitySettled={() => sessionActivitySettled(sdk().directory, id())}
                                />
                              )}
                            </Show>
                          </div>
                        </Show>
                      }
                      state={prompt()}
                      disabled={props.disabled}
                      draftID={props.draftID}
                      variant={props.placement === "inline" ? "new-session" : undefined}
                      ref={props.inputRef}
                      newSessionWorktree={props.newSessionWorktree}
                      onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                      edit={props.followup?.edit}
                      onEditLoaded={props.followup?.onEditLoaded}
                      shouldQueue={props.followup?.queue}
                      onQueue={props.followup?.onQueue}
                      forceSteer={props.followup?.forceSteer}
                      onForceSteerSent={props.followup?.onForceSteerSent}
                      onGoal={props.followup?.onGoal}
                      onAbort={props.followup?.onAbort}
                      onSubmit={props.onSubmit}
                    />
                  </Show>
                }
              >
                <SubagentSessionBar sessionID={sessionID()!} inputRef={props.inputRef} onOpenParent={openParent} />
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}

function SessionProjectMoveDock(props: {
  project: LocalProject
  step: ProjectMoveStep
  targetDirectory?: string
  targetOptions: ProjectMoveOption[]
  changesOptions: ProjectMoveOption[]
  moving: boolean
  onBack: () => void
  onCancel: () => void
}) {
  const options = () => (props.step === "target" ? props.targetOptions : props.changesOptions)
  return (
    <DockPrompt
      kind="question"
      header={
        <>
          <div data-slot="question-header-title">Change session project</div>
          <div data-slot="question-progress">
            <button
              type="button"
              data-slot="question-progress-segment"
              data-active={props.step === "target"}
              data-answered={props.step === "changes"}
              disabled={props.moving}
              onClick={props.onBack}
              aria-label="Target directory"
            />
            <button
              type="button"
              data-slot="question-progress-segment"
              data-active={props.step === "changes"}
              data-answered={false}
              disabled={props.moving || props.step === "target"}
              aria-label="Local changes"
            />
          </div>
        </>
      }
      footer={
        <>
          <Button variant="ghost" size="large" disabled={props.moving} onClick={props.onCancel}>
            Cancel
          </Button>
          <Show when={props.step === "changes"}>
            <Button variant="secondary" size="large" disabled={props.moving} onClick={props.onBack}>
              Back
            </Button>
          </Show>
        </>
      }
    >
      <div data-slot="question-text" class="overflow-auto">
        <Show
          when={props.step === "target"}
          fallback={`Move "${displayName(props.project)}" session to ${props.targetDirectory ?? "the selected directory"}?`}
        >
          Choose where to move this idle session in {displayName(props.project)}.
        </Show>
      </div>
      <div data-slot="question-options">
        <For each={options()}>
          {(option) => (
            <button
              type="button"
              data-slot="question-option"
              data-picked={false}
              role="radio"
              aria-checked={false}
              disabled={props.moving}
              onClick={option.onSelect}
            >
              <span data-slot="question-option-check" aria-hidden="true">
                <span data-slot="question-option-box" data-type="radio" data-picked={false}>
                  <span data-slot="question-option-radio-dot" />
                </span>
              </span>
              <span data-slot="question-option-main">
                <span data-slot="option-label">
                  {option.label}
                  <Show when={props.moving && props.step === "changes"}>
                    <span class="ml-2 inline-flex align-middle">
                      <Spinner class="size-3 text-v2-icon-icon-muted" />
                    </span>
                  </Show>
                </span>
                <span data-slot="option-description">{option.description}</span>
              </span>
            </button>
          )}
        </For>
      </div>
    </DockPrompt>
  )
}
