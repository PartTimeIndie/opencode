import {
  commitTargetForSession,
  forgetCommitTarget,
  normalizeCommitTargetStore,
  rememberCommitTarget,
  repositoryKey,
  repositoryWithin,
  resolveCommitTarget,
  snapshotWorktree,
} from "./commit-target.js"

const ICON = new URL("./assets/git-workbench-icon.svg", import.meta.url).href
const TOOLBAR_ICON = new URL("./assets/git-workbench-toolbar.svg", import.meta.url).href
const EMPTY_IMAGE = new URL("./assets/git-workbench-empty.svg", import.meta.url).href
const ACTION_ICONS = {
  aiCommit: new URL("./assets/git-action-ai-commit.svg", import.meta.url).href,
  commit: new URL("./assets/git-action-commit.svg", import.meta.url).href,
  diff: new URL("./assets/git-action-diff.svg", import.meta.url).href,
  discard: new URL("./assets/git-action-discard.svg", import.meta.url).href,
  refresh: new URL("./assets/git-action-refresh.svg", import.meta.url).href,
  stage: new URL("./assets/git-action-stage-all.svg", import.meta.url).href,
  stash: new URL("./assets/git-action-stash.svg", import.meta.url).href,
  fetch: new URL("./assets/git-action-fetch.svg", import.meta.url).href,
  pull: new URL("./assets/git-action-pull.svg", import.meta.url).href,
  push: new URL("./assets/git-action-push.svg", import.meta.url).href,
  resolve: new URL("./assets/git-action-resolve.svg", import.meta.url).href,
  resolveAll: new URL("./assets/git-action-resolve-all.svg", import.meta.url).href,
  sync: new URL("./assets/git-action-sync.svg", import.meta.url).href,
  undo: new URL("./assets/git-action-undo.svg", import.meta.url).href,
  unstage: new URL("./assets/git-action-unstage.svg", import.meta.url).href,
}
const FILE_ICONS = {
  asset: new URL("./assets/git-file-asset.svg", import.meta.url).href,
  file: new URL("./assets/git-file-generic.svg", import.meta.url).href,
  folder: new URL("./assets/git-file-folder.svg", import.meta.url).href,
  js: new URL("./assets/git-file-js.svg", import.meta.url).href,
  json: new URL("./assets/git-file-json.svg", import.meta.url).href,
  md: new URL("./assets/git-file-md.svg", import.meta.url).href,
  ts: new URL("./assets/git-file-ts.svg", import.meta.url).href,
}

const DEFAULT_SETTINGS = {
  showComposerCommit: true,
  commitChain: "chain:default",
  historyLimit: 200,
  defaultRemote: "",
  syncMode: "pull-merge-push",
  showDangerActions: true,
}
const CANCELLATION_NAMES = new Set(["AbortError", "CanceledError", "CancelledError", "UICancelledError"])
export default {
  id: "git-workbench-app",
  app(api) {
    const collapsedPaths = api.kv.get("collapsedPaths", [])
    const state = {
      directory: currentDirectory(api),
      snapshot: undefined,
      settings: readSettings(api),
      busy: "",
      commitBusy: false,
      error: "",
      notice: "",
      selectedTab: api.kv.get("selectedTab", "working"),
      selectedCommit: api.kv.get("selectedCommit", ""),
      selectedFile: api.kv.get("selectedFile", ""),
      collapsedPaths: new Set(
        Array.isArray(collapsedPaths) ? collapsedPaths.filter((item) => typeof item === "string") : [],
      ),
      projects: normalizeProjects(api.host.projects.list()),
      discoveredProjects: [],
      discoveryBusy: false,
      discoveryError: "",
      discoveryRequest: 0,
      discoveryTruncated: false,
      navigationSessionID: api.host?.navigation?.current?.().sessionID,
      pendingProjectSelection: undefined,
      commitTargets: normalizeCommitTargetStore(api.kv.get("commitTargetsBySession", undefined)),
      navigationDirectory: currentDirectory(api),
      diffByFile: new Map(),
      diffBusy: "",
      diffError: "",
      dialog: undefined,
      dialogElement: undefined,
      dialogStyleElement: undefined,
      dialogRendered: undefined,
      contextMenu: undefined,
      restoreContextFocus: undefined,
      lastAction: undefined,
      panels: new Set(),
      composerToolbarDispose: undefined,
      composerToolbarBusy: undefined,
      syncComposerToolbar: undefined,
    }

    const composerCommitDefault = api.settings.get("showToolbarCommit", DEFAULT_SETTINGS.showComposerCommit)
    api.settings.register({
      id: "gitWorkbenchSettings",
      title: "Git Workbench",
      sections: [
        {
          title: "General",
          fields: [
            {
              key: "showComposerCommit",
              type: "boolean",
              label: "Composer commit button",
              description: "Show the icon-only AI Commit button next to the composer send button.",
              default: composerCommitDefault,
            },
            {
              key: "commitChain",
              type: "model-target",
              label: "Commit model or chain",
              description: "Select one model or an ordered fallback chain for AI commit messages.",
              default: DEFAULT_SETTINGS.commitChain,
              required: true,
              autoSelectDefault: true,
            },
            {
              key: "historyLimit",
              type: "number",
              label: "History limit",
              description: "Maximum commits loaded into the history tree.",
              min: 25,
              max: 1000,
              default: DEFAULT_SETTINGS.historyLimit,
            },
            {
              key: "defaultRemote",
              type: "text",
              label: "Default remote",
              description: "Optional remote used by push, pull, fetch, and sync. Leave empty for Git defaults.",
              default: DEFAULT_SETTINGS.defaultRemote,
            },
            {
              key: "syncMode",
              type: "select",
              label: "Sync mode",
              description: "How the Sync action behaves.",
              options: [
                { value: "pull-merge-push", label: "Pull merge, then push" },
                { value: "fetch-only", label: "Fetch only" },
              ],
              default: DEFAULT_SETTINGS.syncMode,
            },
            {
              key: "showDangerActions",
              type: "boolean",
              label: "Danger actions",
              description: "Show destructive actions such as discard, force push, branch delete, and stash drop.",
              default: DEFAULT_SETTINGS.showDangerActions,
            },
          ],
        },
      ],
    })

    const unsubscribeProjects = api.host.projects.subscribe((projects) => {
      state.projects = normalizeProjects(projects)
      renderAll(state)
    })
    const unsubscribeNavigation = api.host.navigation.subscribe
      ? api.host.navigation.subscribe((navigation, event) => syncNavigationDirectory(api, state, navigation, event))
      : () => {}

    const syncComposerToolbar = () => {
      if (!state.settings.showComposerCommit) {
        state.composerToolbarDispose?.()
        state.composerToolbarDispose = undefined
        state.composerToolbarBusy = undefined
        return
      }
      // Toolbar callbacks run in the host's Solid tree; re-register when mutable plugin state affects them.
      const busy = state.commitBusy === true
      if (state.composerToolbarDispose && state.composerToolbarBusy === busy) return
      state.composerToolbarDispose?.()
      state.composerToolbarBusy = busy
      state.composerToolbarDispose = api.toolbar.register({
        id: "aiCommit",
        defaultVisible: true,
        title: "Commit All Open Changes",
        tooltip: "Resolve the current repository, stage all of its changes, and commit with an LLM-generated message",
        placement: "composer",
        align: "right",
        order: 70,
        icon: { src: TOOLBAR_ICON, alt: "Commit All Open Changes", size: "large" },
        visible: () => true,
        enabled: () => !busy,
        run: async (ctx) => {
          api.dock.open.item("gitWorkbench")
          await runCommitAllOpenChanges(api, state, ctx)
        },
      })
    }
    state.syncComposerToolbar = syncComposerToolbar

    api.settings.subscribe((settings) => {
      state.settings = normalizeSettings(settings)
      syncComposerToolbar()
      renderAll(state)
      if (state.snapshot) void refreshSnapshot(api, state, { quiet: true })
    })
    syncComposerToolbar()

    api.commands.register({
      id: "gitWorkbench.open",
      title: "Open Git Workbench",
      run() {
        api.dock.open.item("gitWorkbench")
      },
    })

    api.commands.register({
      id: "gitWorkbench.aiCommit",
      title: "Commit All Open Changes",
      run() {
        api.dock.open.item("gitWorkbench")
        return runCommitAllOpenChanges(api, state, { directory: selectedDirectory(api, state) })
      },
    })

    api.automation.register({
      id: "smoke",
      title: "Git Workbench smoke",
      description: "Runs one Git Workbench action against a local repository and returns before/after snapshots.",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string" },
          action: { type: "object" },
          limit: { type: "number" },
          openDock: { type: "boolean" },
        },
        required: ["directory"],
      },
      async run(input) {
        return runAutomation(api, state, input)
      },
    })

    api.dock.register({
      id: "gitWorkbench",
      title: "Git Workbench",
      icon: ICON,
      defaultArea: "left",
      minWidth: 320,
      minHeight: 260,
      preferredWidth: 520,
      mount(context) {
        return mountWorkbench(api, state, context)
      },
    })

    api.dock.register({
      id: "gitDiff",
      title: "Git Diff",
      icon: ACTION_ICONS.diff,
      defaultArea: "middle",
      minWidth: 420,
      minHeight: 260,
      mount(context) {
        return mountDiffPanel(api, state, context)
      },
    })

    api.lifecycle.onDispose(() => {
      unsubscribeNavigation()
      unsubscribeProjects()
      state.composerToolbarDispose?.()
      removeTextDialogElement(state)
    })
  },
}

function readSettings(api) {
  const composerCommitDefault = api.settings.get("showToolbarCommit", DEFAULT_SETTINGS.showComposerCommit)
  return normalizeSettings({
    showComposerCommit: api.settings.get("showComposerCommit", composerCommitDefault),
    commitChain: api.settings.get("commitChain", DEFAULT_SETTINGS.commitChain),
    historyLimit: api.settings.get("historyLimit", DEFAULT_SETTINGS.historyLimit),
    defaultRemote: api.settings.get("defaultRemote", DEFAULT_SETTINGS.defaultRemote),
    syncMode: api.settings.get("syncMode", DEFAULT_SETTINGS.syncMode),
    showDangerActions: api.settings.get("showDangerActions", DEFAULT_SETTINGS.showDangerActions),
  })
}

function currentDirectory(api) {
  const directory = api.host?.navigation?.current?.().directory
  return typeof directory === "string" && directory ? directory : undefined
}

function selectedDirectory(api, state) {
  const directory = state.directory || state.navigationDirectory || currentDirectory(api)
  return typeof directory === "string" && directory ? directory : undefined
}

function actionDirectory(api, state, context) {
  const directory = context?.directory || selectedDirectory(api, state)
  return typeof directory === "string" && directory ? directory : undefined
}

function normalizeProjects(projects) {
  if (!Array.isArray(projects)) return []
  const seen = new Set()
  return projects.flatMap((project) => {
    if (!project || typeof project !== "object" || typeof project.worktree !== "string" || !project.worktree) return []
    const key = repositoryKey(project.worktree)
    if (seen.has(key)) return []
    seen.add(key)
    return [
      {
        worktree: project.worktree,
        name:
          typeof project.name === "string" && project.name.trim()
            ? project.name.trim()
            : directoryName(project.worktree),
      },
    ]
  })
}

function normalizeDiscoveredProjects(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.repositories)) return []
  return normalizeProjects(result.repositories).toSorted((a, b) => a.name.localeCompare(b.name))
}

function syncNavigationDirectory(api, state, navigation, event) {
  const directory = navigation?.directory
  if (typeof directory !== "string" || !directory) return
  const pending = state.pendingProjectSelection
  if (event?.activated && pending) {
    const isStaleActivation =
      repositoryKey(directory) === repositoryKey(pending.navigationDirectory ?? "") &&
      navigation.sessionID === pending.navigationSessionID &&
      repositoryKey(directory) !== repositoryKey(pending.directory)
    state.pendingProjectSelection = undefined
    if (isStaleActivation) return
  }
  state.navigationDirectory = directory
  state.navigationSessionID = typeof navigation.sessionID === "string" ? navigation.sessionID : undefined
  if (!event?.activated && state.directory) return
  if (repositoryKey(directory) === repositoryKey(state.directory ?? "")) return
  void selectProject(api, state, directory, { openProject: false })
}

function normalizeSettings(settings) {
  const historyLimit = Number(settings.historyLimit)
  return {
    showComposerCommit: settings.showComposerCommit !== false,
    commitChain:
      typeof settings.commitChain === "string" && settings.commitChain.trim()
        ? settings.commitChain.trim()
        : DEFAULT_SETTINGS.commitChain,
    historyLimit: Number.isFinite(historyLimit)
      ? Math.max(25, Math.min(1000, Math.floor(historyLimit)))
      : DEFAULT_SETTINGS.historyLimit,
    defaultRemote: typeof settings.defaultRemote === "string" ? settings.defaultRemote.trim() : "",
    syncMode: settings.syncMode === "fetch-only" ? "fetch-only" : "pull-merge-push",
    showDangerActions: settings.showDangerActions !== false,
  }
}

function mountWorkbench(api, state, context) {
  const abort = mountSurface(state, context, "oc-git-workbench", (view) => renderWorkbench(api, state, view))
  const cleanup = () => {
    context.signal.removeEventListener("abort", cleanup)
    state.contextMenu = undefined
    state.restoreContextFocus = undefined
    removeContextMenuElement(state)
    abort()
  }
  context.signal.addEventListener("abort", cleanup, { once: true })
  void refreshWorkbench(api, state, { quiet: true })
  return cleanup
}

function mountDiffPanel(api, state, context) {
  const abort = mountSurface(state, context, "oc-git-workbench oc-git-workbench--diff-dock", (view) =>
    renderDiffDock(api, state, view),
  )
  if (!state.snapshot) void refreshSnapshot(api, state, { quiet: true })
  return abort
}

function mountSurface(state, context, className, renderView) {
  const root = document.createElement("section")
  root.className = className
  const style = styleNode()
  const view = document.createElement("div")
  view.className = "oc-git-workbench__view"
  root.append(style, view)
  context.element.replaceChildren(root)

  let queued = false
  const render = () => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      renderView(view)
    })
  }
  state.panels.add(render)

  let mounted = true
  const abort = () => {
    if (!mounted) return
    mounted = false
    context.signal.removeEventListener("abort", abort)
    state.panels.delete(render)
    context.element.replaceChildren()
  }
  context.signal.addEventListener("abort", abort, { once: true })

  render()
  return abort
}

export function renderAll(state) {
  syncTextDialogElement(state)
  for (const render of state.panels) render()
}

async function refreshWorkbench(api, state, options = {}) {
  await Promise.all([refreshDiscoveredProjects(api, state, options), refreshSnapshot(api, state, options)])
}

export async function refreshDiscoveredProjects(api, state, options = {}) {
  const directory = actionDirectory(api, state)
  if (!directory) return
  state.directory = directory
  const request = ++state.discoveryRequest
  state.discoveryBusy = true
  state.discoveryError = ""
  state.discoveryTruncated = false
  if (!options.quiet) renderAll(state)
  try {
    const result = await api.host.git.discover({ directory, maxDepth: 3 })
    if (state.directory !== directory || state.discoveryRequest !== request) return
    state.discoveredProjects = normalizeDiscoveredProjects(result)
    state.discoveryTruncated = result?.truncated === true
  } catch (error) {
    if (state.directory !== directory || state.discoveryRequest !== request) return
    if (isCancellation(error)) return
    state.discoveryError = error instanceof Error ? error.message : String(error)
  } finally {
    if (state.directory === directory && state.discoveryRequest === request) state.discoveryBusy = false
    renderAll(state)
  }
}

export function isCancellation(error, seen = new Set()) {
  if (error === undefined || error === null) return false
  if (typeof error === "string") return CANCELLATION_NAMES.has(error) || isCancellationMessage(error)
  if (typeof error !== "object") return false
  if (seen.has(error)) return false
  seen.add(error)
  if (error.status === 499 || error.statusCode === 499) return true
  if (CANCELLATION_NAMES.has(error.name) || CANCELLATION_NAMES.has(error._tag)) return true
  if (typeof error.message === "string") {
    if (CANCELLATION_NAMES.has(error.message) || isCancellationMessage(error.message)) return true
  }
  return isCancellation(error.cause, seen) || isCancellation(error.body, seen)
}

function isCancellationMessage(message) {
  return /(?:→|(?:https?|http)\s*|status(?:\s+code)?\s*[:=]?)\s*499(?:\s|$)/i.test(message)
}

function renderDiffDock(api, state, view) {
  const shell = node("div", "oc-git-workbench__diff-shell")
  shell.append(renderSelectedFileDiff(api, state, state.snapshot))
  view.replaceChildren(shell)
}

export async function refreshSnapshot(api, state, options = {}) {
  if (state.busy && !options.force) return
  const previous = state.busy
  if (!options.quiet) setBusy(state, "refresh")
  state.error = ""
  if (!options.quiet) renderAll(state)
  try {
    const directory = actionDirectory(api, state)
    if (!directory) throw new Error("No project directory is active")
    state.directory = directory
    const snapshot = normalizeSnapshot(await api.host.git.snapshot({ directory, limit: state.settings.historyLimit }))
    if (state.directory !== directory) return
    state.snapshot = snapshot
    if (options.quiet) {
      const files = new Set(snapshot.status.map((file) => file.file))
      state.diffByFile = new Map([...state.diffByFile].filter(([file]) => files.has(file)))
      if (state.diffBusy && !files.has(state.diffBusy)) state.diffBusy = ""
    } else {
      state.diffByFile = new Map()
      state.diffBusy = ""
      state.diffError = ""
    }
    if (!state.selectedCommit && state.snapshot.history[0]) state.selectedCommit = state.snapshot.history[0].hash
    if (state.selectedCommit && !state.snapshot.history.some((commit) => commit.hash === state.selectedCommit)) {
      state.selectedCommit = state.snapshot.history[0]?.hash ?? ""
    }
    if (state.selectedFile && !state.snapshot.status.some((file) => file.file === state.selectedFile)) {
      state.selectedFile = state.snapshot.status[0]?.file ?? ""
      api.kv.set("selectedFile", state.selectedFile)
    }
  } catch (error) {
    if (isCancellation(error)) return
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    setBusy(state, previous === "refresh" ? "" : previous)
    renderAll(state)
  }
}

function persistCommitTargets(api, state, store) {
  state.commitTargets = normalizeCommitTargetStore(store)
  api.kv.set("commitTargetsBySession", state.commitTargets)
}

function rememberSessionCommitTarget(api, state, worktree, context = {}) {
  const navigation = api.host.navigation.current()
  const sessionID = context.sessionID || state.navigationSessionID || navigation.sessionID
  const container = context.directory || state.navigationDirectory || navigation.directory
  if (!sessionID || !container || !repositoryWithin(container, worktree)) return
  persistCommitTargets(
    api,
    state,
    rememberCommitTarget(state.commitTargets, { sessionID, container, worktree, updatedAt: Date.now() }),
  )
}

function forgetSessionCommitTarget(api, state, sessionID) {
  if (!sessionID) return
  persistCommitTargets(api, state, forgetCommitTarget(state.commitTargets, sessionID))
}

async function inspectCommitCandidates(api, repositories, limit) {
  const candidates = []
  const errors = []
  for (let index = 0; index < repositories.length; index += 8) {
    const batch = repositories.slice(index, index + 8)
    const inspected = await Promise.all(
      batch.map(async (repository) => {
        try {
          const snapshot = normalizeSnapshot(await api.host.git.snapshot({ directory: repository.worktree, limit }))
          const worktree = snapshotWorktree(snapshot, repository.worktree)
          if (!worktree) return { error: `Not a Git repository: ${repository.worktree}` }
          return {
            candidate: {
              worktree,
              name: repository.name || directoryName(worktree),
              changeCount: snapshot.status.length,
            },
          }
        } catch (error) {
          if (isCancellation(error)) throw error
          return { error: `${repository.worktree}: ${error instanceof Error ? error.message : String(error)}` }
        }
      }),
    )
    for (const item of inspected) {
      if (item.candidate) candidates.push(item.candidate)
      if (item.error) errors.push(item.error)
    }
  }
  return { candidates, errors }
}

async function resolveCommitRepository(api, state, context = {}) {
  // Explicit context wins (composer toolbar session); otherwise commit what the workbench shows,
  // never the active tab's project.
  const directory = context.directory || selectedDirectory(api, state)
  const sessionID = context.sessionID || state.navigationSessionID || api.host.navigation.current().sessionID
  if (!directory) return { kind: "none", reason: "No project directory is active." }

  const directSnapshot = normalizeSnapshot(await api.host.git.snapshot({ directory, limit: 1 }))
  const directWorktree = snapshotWorktree(directSnapshot, directory)
  if (directWorktree) return resolveCommitTarget({ directWorktree })

  const remembered = commitTargetForSession(state.commitTargets, sessionID, directory)
  if (remembered) {
    try {
      const snapshot = normalizeSnapshot(await api.host.git.snapshot({ directory: remembered.worktree, limit: 1 }))
      const worktree = snapshotWorktree(snapshot, remembered.worktree)
      if (
        worktree &&
        repositoryKey(worktree) === repositoryKey(remembered.worktree) &&
        repositoryWithin(directory, worktree)
      ) {
        return resolveCommitTarget({ rememberedWorktree: worktree })
      }
    } catch (error) {
      if (isCancellation(error)) throw error
      // Invalid persisted targets are removed below and resolved again from the container.
    }
    forgetSessionCommitTarget(api, state, sessionID)
  }

  const discovery = await api.host.git.discover({ directory, maxDepth: 3 })
  const repositories = normalizeDiscoveredProjects(discovery)
  state.discoveredProjects = repositories
  state.discoveryTruncated = discovery?.truncated === true
  const inspected = await inspectCommitCandidates(api, repositories, 1)
  const dirty = inspected.candidates.filter((candidate) => candidate.changeCount > 0)
  if (inspected.errors.length && !dirty.length) {
    throw new Error(`Could not inspect discovered repositories. ${inspected.errors[0]}`)
  }
  return resolveCommitTarget({
    candidates: inspected.candidates,
    discoveryTruncated: state.discoveryTruncated || inspected.errors.length > 0,
  })
}

function promptCommitTarget(api, state, resolution, context) {
  const options = resolution.candidates.map((candidate) => ({
    value: candidate.worktree,
    label: `${candidate.name || directoryName(candidate.worktree)} (${candidate.changeCount} changed)`,
    description: candidate.worktree,
  }))
  openTextDialog(state, {
    title: "Choose repository to commit",
    description: resolution.discoveryTruncated
      ? "Repository discovery was incomplete. Choose an inspected repository explicitly; no other repository will be committed."
      : "Several repositories have open changes. Choose exactly one repository for this session.",
    fields: [
      {
        id: "repository",
        label: "Repository",
        type: "select",
        value: options[0]?.value ?? "",
        options,
        showOptionDescriptions: true,
        required: true,
      },
    ],
    confirm: "Commit selected repository",
    cancel: () => setCommitBusy(state, false),
    submit: async (values) => {
      const selected = resolution.candidates.find(
        (candidate) => repositoryKey(candidate.worktree) === repositoryKey(values.repository),
      )
      try {
        if (!selected) return
        rememberSessionCommitTarget(api, state, selected.worktree, context)
        return await runGitAction(
          api,
          state,
          commitAutoInput(state, { directory: selected.worktree }),
          "Commit all open changes",
        )
      } finally {
        setCommitBusy(state, false)
      }
    },
  })
}

export async function runCommitAllOpenChanges(api, state, context = {}) {
  if (state.commitBusy) return
  if (state.busy) {
    state.notice = "Wait for the current Git Workbench action to finish, then retry the commit."
    renderAll(state)
    return
  }
  setCommitBusy(state, true)
  let waitingForChoice = false
  setBusy(state, "Resolve commit repository")
  state.error = ""
  state.notice = ""
  renderAll(state)
  try {
    const resolution = await resolveCommitRepository(api, state, context)
    setBusy(state, "")
    if (resolution.kind === "selected") {
      return await runGitAction(
        api,
        state,
        commitAutoInput(state, { directory: resolution.directory }),
        "Commit all open changes",
      )
    }
    if (resolution.kind === "choose") {
      waitingForChoice = true
      promptCommitTarget(api, state, resolution, context)
      return
    }
    state.notice = resolution.reason
  } catch (error) {
    if (isCancellation(error)) return
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (state.busy === "Resolve commit repository") setBusy(state, "")
    if (!waitingForChoice) setCommitBusy(state, false)
    renderAll(state)
  }
}

export async function runGitAction(api, state, input, title) {
  if (state.busy) return
  const directory = actionDirectory(api, state, input)
  if (!directory) {
    state.error = "No project directory is active"
    renderAll(state)
    return
  }
  state.directory = directory
  setBusy(state, title || input.action)
  state.error = ""
  state.notice = ""
  state.lastAction = input
  renderAll(state)
  try {
    const result = await api.host.git.action(withRemoteDefaults(state, { ...input, directory }))
    state.notice = result.ok
      ? result.message || successMessage(input.action, result)
      : result.message || result.output || `${title || input.action} failed`
    state.error = result.ok ? "" : state.notice
    if (result.commit)
      state.notice =
        input.action === "commitAuto" ? `${result.commit}\n\n${state.notice}` : `${state.notice}\n\n${result.commit}`
    await refreshSnapshot(api, state, { force: true })
  } catch (error) {
    if (isCancellation(error)) return
    state.error = error instanceof Error ? error.message : String(error)
  } finally {
    setBusy(state, "")
    renderAll(state)
  }
}

function setBusy(state, busy) {
  state.busy = busy
  state.syncComposerToolbar?.()
}

function setCommitBusy(state, busy) {
  if (state.commitBusy === busy) return
  state.commitBusy = busy
  state.syncComposerToolbar?.()
}

export async function runAutomation(api, state, input) {
  const options = automationInput(input)
  const previous = state.busy
  setBusy(state, "automation")
  renderAll(state)
  try {
    const before = normalizeSnapshot(
      await api.host.git.snapshot({ directory: options.directory, limit: options.limit }),
    )
    const result = options.action
      ? await api.host.git.action(withRemoteDefaults(state, { ...options.action, directory: options.directory }))
      : undefined
    const after = normalizeSnapshot(await api.host.git.snapshot({ directory: options.directory, limit: options.limit }))
    state.directory = options.directory
    state.snapshot = after
    if (!state.selectedCommit && after.history[0]) state.selectedCommit = after.history[0].hash
    if (options.openDock) api.dock.open.item("gitWorkbench")
    return {
      ok: result?.ok !== false,
      result,
      before: automationSnapshot(before),
      after: automationSnapshot(after),
    }
  } catch (error) {
    if (isCancellation(error)) return { ok: false, cancelled: true }
    throw error
  } finally {
    setBusy(state, previous || "")
    renderAll(state)
  }
}

function automationInput(input) {
  if (!input || typeof input !== "object" || typeof input.directory !== "string" || !input.directory.trim()) {
    throw new Error("Git Workbench smoke requires a directory")
  }
  return {
    directory: input.directory,
    action: input.action && typeof input.action === "object" ? input.action : undefined,
    limit: Number.isFinite(Number(input.limit))
      ? Math.max(1, Math.floor(Number(input.limit)))
      : DEFAULT_SETTINGS.historyLimit,
    openDock: input.openDock !== false,
  }
}

function automationSnapshot(snapshot) {
  return {
    branch: snapshot.info?.branch,
    status: snapshot.status.map((file) => ({
      file: file.file,
      code: file.code,
      staged: Boolean(file.staged),
      unstaged: Boolean(file.unstaged),
      untracked: Boolean(file.untracked),
      conflicted: Boolean(file.conflicted),
    })),
    history: snapshot.history.map((commit) => ({
      short: commit.short,
      subject: commit.subject,
      refs: commit.refs,
    })),
    branches: snapshot.branches.map((branch) => ({
      name: branch.name,
      current: Boolean(branch.current),
      remote: Boolean(branch.remote),
    })),
    stashes: snapshot.stashes.map((stash) => ({
      selector: stash.selector,
      message: stash.message,
    })),
    conflicts: snapshot.conflicts.map((conflict) => conflict.file),
    operation: snapshot.operation,
  }
}

function withRemoteDefaults(state, input) {
  if (!state.settings.defaultRemote || input.remote || !["fetch", "pull", "push", "sync"].includes(input.action))
    return input
  return { ...input, remote: state.settings.defaultRemote }
}

export function commitAutoInput(state, input = {}) {
  return { ...input, action: "commitAuto", commitTarget: state.settings.commitChain || DEFAULT_SETTINGS.commitChain }
}

function successMessage(action, result) {
  if (action === "commitAuto") return "Committed all staged changes with an LLM-generated message."
  if (action === "commit") return "Commit created."
  if (action === "sync") return "Sync completed."
  if (action === "fetch") return "Fetch completed."
  if (action === "pull") return "Pull completed."
  if (action === "push") return "Push completed."
  if (action === "stashSave") return "Stash saved."
  if (action === "stashApply") return "Stash applied."
  if (action === "stashPop") return "Stash popped."
  if (action === "stashDrop") return "Stash dropped."
  if (action === "cherryPick") return "Commit cherry-picked."
  if (action === "merge") return "Merge started."
  if (action === "squashRange") return "Squash commit created."
  if (action === "ignore") return result.message || "Updated .gitignore."
  return result.output || "Git action completed."
}

function renderWorkbench(api, state, view) {
  removeContextMenuElement(state)
  const snapshot = state.snapshot
  const shell = node("div", "oc-git-workbench__shell")
  shell.addEventListener("click", (event) => {
    if (
      !state.contextMenu ||
      (event.target instanceof Element && event.target.closest(".oc-git-workbench__context-menu"))
    )
      return
    closeContextMenu(state)
  })
  shell.append(renderHeader(api, state, snapshot))

  if (state.error) shell.append(callout("error", state.error))
  if (state.discoveryError) shell.append(callout("error", `Repository discovery failed: ${state.discoveryError}`))
  if (state.discoveryTruncated) shell.append(callout("notice", "Showing the first 200 discovered repositories."))
  if (!state.error && state.notice) shell.append(callout("notice", state.notice))

  if (!snapshot) {
    shell.append(loadingBlock(state.busy ? "Loading Git repository" : "No Git data loaded"))
    view.replaceChildren(shell)
    return
  }

  if (snapshot.operation?.inProgress) shell.append(renderOperation(api, state, snapshot.operation))
  shell.append(renderTabs(api, state))

  const body = node("div", "oc-git-workbench__body")
  if (state.selectedTab === "working") body.append(renderWorkingTree(api, state, snapshot))
  if (state.selectedTab === "history") body.append(renderHistory(api, state, snapshot))
  if (state.selectedTab === "branches") body.append(renderBranches(api, state, snapshot))
  if (state.selectedTab === "stash") body.append(renderStashes(api, state, snapshot))
  if (state.selectedTab === "conflicts") body.append(renderConflicts(api, state, snapshot))
  shell.append(body)
  view.replaceChildren(shell)
  if (state.contextMenu) {
    const panel = renderContextMenu(state, state.contextMenu)
    document.body.append(panel)
    state.contextMenuElement = panel
    const outside = (event) => {
      if (event.target instanceof Node && panel.contains(event.target)) return
      closeContextMenu(state)
    }
    document.addEventListener("pointerdown", outside)
    state.contextMenuCleanup = () => document.removeEventListener("pointerdown", outside)
  }
  restoreContextFocus(state, shell)
}

function renderHeader(api, state, snapshot) {
  const header = node("div", "oc-git-workbench__header")
  const titleRow = node("div", "oc-git-workbench__title-row")
  const icon = document.createElement("img")
  icon.src = ICON
  icon.alt = ""
  icon.className = "oc-git-workbench__icon"
  const title = node("div", "oc-git-workbench__title")
  title.append(node("strong", "", "Git Workbench"))
  title.append(node("span", "", snapshot?.info?.branch ? `${snapshot.info.branch}` : "Repository tools"))
  titleRow.append(icon, title)
  titleRow.append(renderProjectSelect(api, state))

  const actions = node("div", "oc-git-workbench__toolbar")
  actions.append(
    iconButton(
      "Refresh",
      ACTION_ICONS.refresh,
      () => refreshWorkbench(api, state),
      Boolean(state.busy || state.discoveryBusy),
    ),
  )
  actions.append(
    iconButton(
      "Fetch",
      ACTION_ICONS.fetch,
      () => runGitAction(api, state, { action: "fetch" }, "Fetch"),
      Boolean(state.busy),
    ),
  )
  actions.append(
    iconButton(
      "Pull",
      ACTION_ICONS.pull,
      () => runGitAction(api, state, { action: "pull" }, "Pull"),
      Boolean(state.busy),
    ),
  )
  actions.append(
    iconButton(
      "Push",
      ACTION_ICONS.push,
      () => runGitAction(api, state, { action: "push" }, "Push"),
      Boolean(state.busy),
    ),
  )
  actions.append(
    iconButton(
      "Sync",
      ACTION_ICONS.sync,
      () => {
        if (state.settings.syncMode === "fetch-only") return runGitAction(api, state, { action: "fetch" }, "Fetch")
        return runGitAction(api, state, { action: "sync" }, "Sync")
      },
      Boolean(state.busy),
    ),
  )
  titleRow.append(actions)
  header.append(titleRow)

  const stats = node("div", "oc-git-workbench__stats")
  stats.append(pill(`${snapshot?.status?.length ?? 0} changed`))
  stats.append(pill(`${snapshot?.history?.length ?? 0} commits`))
  stats.append(pill(`${snapshot?.branches?.filter((branch) => !branch.remote).length ?? 0} branches`))
  stats.append(pill(`${snapshot?.remotes?.length ?? 0} remotes`))
  header.append(stats)
  return header
}

function renderProjectSelect(api, state) {
  const selected = selectedDirectory(api, state) || ""
  const groups = projectGroups(state, selected)
  const field = node("label", "oc-git-workbench__project-picker")
  const select = document.createElement("select")
  field.append(node("span", "", "Project"), select)
  select.className = "oc-git-workbench__project-select"
  select.setAttribute("aria-label", "Git Workbench project")
  select.disabled = Boolean(state.busy || state.discoveryBusy) || groups.projects.length + groups.discovered.length < 2
  appendProjectGroup(select, "Open projects", groups.projects)
  appendProjectGroup(select, "Discovered repositories", groups.discovered)
  select.value = selected
  select.addEventListener("change", () =>
    selectProject(api, state, select.value, { openProject: true, rememberForSession: true }),
  )
  return field
}

function appendProjectGroup(select, label, projects) {
  if (!projects.length) return
  const group = document.createElement("optgroup")
  group.label = label
  for (const project of projects) {
    const option = document.createElement("option")
    option.value = project.worktree
    option.textContent = project.name
    option.title = project.worktree
    group.append(option)
  }
  select.append(group)
}

function projectGroups(state, selected) {
  const selectedKey = repositoryKey(selected)
  const projects =
    !selected ||
    state.projects.some((project) => repositoryKey(project.worktree) === selectedKey) ||
    state.discoveredProjects.some((project) => repositoryKey(project.worktree) === selectedKey)
      ? state.projects
      : [{ worktree: selected, name: directoryName(selected) }, ...state.projects]
  const open = new Set(projects.map((project) => repositoryKey(project.worktree)))
  return {
    projects,
    discovered: state.discoveredProjects.filter((project) => !open.has(repositoryKey(project.worktree))),
  }
}

async function selectProject(api, state, directory, options = {}) {
  if (!directory) return
  if (options.rememberForSession) rememberSessionCommitTarget(api, state, directory)
  if (repositoryKey(directory) === repositoryKey(state.directory ?? "")) return
  state.directory = directory
  state.snapshot = undefined
  state.selectedCommit = ""
  state.selectedFile = ""
  state.diffByFile = new Map()
  state.diffBusy = ""
  state.diffError = ""
  state.discoveredProjects = []
  state.discoveryError = ""
  state.discoveryTruncated = false
  state.error = ""
  state.notice = ""
  if (options.openProject) {
    const navigation = api.host.navigation.current()
    const alreadyOpen = api.host.projects
      .list()
      .some((project) => repositoryKey(project.worktree) === repositoryKey(directory))
    state.pendingProjectSelection = alreadyOpen
      ? undefined
      : {
          directory,
          navigationDirectory: navigation.directory,
          navigationSessionID: navigation.sessionID,
        }
    api.host.projects.open(directory)
  }
  renderAll(state)
  await refreshWorkbench(api, state, { force: true })
}

function renderOperation(api, state, operation) {
  const section = node("div", "oc-git-workbench__operation")
  section.append(node("strong", "", `${operation.type || "git"} in progress`))
  section.append(node("span", "", "Resolve conflicts, then continue or abort the operation."))
  const actions = node("div", "oc-git-workbench__inline-actions")
  actions.append(
    textButton(
      "Continue",
      () => runGitAction(api, state, { action: "continueOperation" }, "Continue operation"),
      undefined,
      undefined,
      Boolean(state.busy),
    ),
  )
  actions.append(
    textButton(
      "Abort",
      () =>
        confirmRun(
          state,
          "Abort the current Git operation?",
          () => runGitAction(api, state, { action: "abortOperation" }, "Abort operation"),
          { requireDangerActions: false },
        ),
      "danger",
      undefined,
      Boolean(state.busy),
    ),
  )
  section.append(actions)
  return section
}

function renderTabs(api, state) {
  const tabs = [
    ["working", "Working tree"],
    ["history", "History"],
    ["branches", "Branches"],
    ["stash", "Stash"],
    ["conflicts", "Conflicts"],
  ]
  const nav = node("div", "oc-git-workbench__tabs")
  for (const [id, label] of tabs) {
    const tab = textButton(label, () => {
      state.selectedTab = id
      api.kv.set("selectedTab", id)
      renderAll(state)
    })
    tab.classList.add("oc-git-workbench__tab")
    tab.setAttribute("aria-selected", String(state.selectedTab === id))
    nav.append(tab)
  }
  return nav
}

function renderWorkingTree(api, state, snapshot) {
  const section = node("div", "oc-git-workbench__section")
  const controls = node("div", "oc-git-workbench__action-grid")
  const busy = Boolean(state.busy)
  controls.append(
    iconButton("Stage all", ACTION_ICONS.stage, () => runGitAction(api, state, { action: "stage" }, "Stage all"), busy),
  )
  controls.append(
    iconButton(
      "Unstage all",
      ACTION_ICONS.unstage,
      () => runGitAction(api, state, { action: "unstage" }, "Unstage all"),
      busy,
    ),
  )
  controls.append(
    iconButton(
      "Commit All Open Changes",
      ACTION_ICONS.aiCommit,
      // Commit what the workbench shows: the active tab may still belong to another project.
      () => runCommitAllOpenChanges(api, state, { directory: selectedDirectory(api, state) }),
      busy,
      "primary",
    ),
  )
  controls.append(iconButton("Commit...", ACTION_ICONS.commit, () => promptCommit(api, state), busy))
  controls.append(iconButton("Stash", ACTION_ICONS.stash, () => promptStash(api, state), busy))
  if (state.settings.showDangerActions) {
    controls.append(
      iconButton(
        "Discard all",
        ACTION_ICONS.discard,
        () =>
          confirmRun(state, "Discard all working tree changes and untracked files?", () =>
            runGitAction(api, state, { action: "discard", force: true }, "Discard all"),
          ),
        busy,
        "danger",
      ),
    )
  }
  section.append(controls)

  if (!snapshot.status.length) {
    section.append(emptyBlock("Working tree clean", "No uncommitted changes are visible in this repository."))
    return section
  }

  const summary = node("div", "oc-git-workbench__tree-summary")
  summary.append(node("strong", "", `Changes (${snapshot.status.length})`))
  summary.append(node("span", "", "Right-click files or folders for Git actions. Hover any action for details."))
  section.append(summary)

  const worktree = node("div", "oc-git-workbench__worktree")
  worktree.append(renderStatusTree(api, state, snapshot.status))
  section.append(worktree)
  return section
}

function renderStatusTree(api, state, files) {
  const list = node("div", "oc-git-workbench__file-list oc-git-workbench__tree")
  const tree = buildStatusTree(files)
  for (const directory of sortedDirectories(tree)) list.append(renderTreeDirectory(api, state, directory, 0))
  for (const file of sortedFiles(tree.files)) list.append(renderFileRow(api, state, file, 0))
  return list
}

function renderTreeDirectory(api, state, directory, depth) {
  const group = node("div", "oc-git-workbench__tree-group")
  const expanded = !state.collapsedPaths.has(directory.path)
  const row = node("button", "oc-git-workbench__tree-directory")
  row.type = "button"
  row.style.setProperty("--tree-indent", `${depth * 14}px`)
  row.setAttribute("aria-expanded", String(expanded))
  row.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${directory.path}`)
  row.dataset.path = directory.path
  row.title = `${directory.path}\nRight-click for folder actions`
  row.addEventListener("click", () => toggleTreeDirectory(api, state, directory.path))
  row.addEventListener("contextmenu", (event) => openDirectoryContextMenu(api, state, event, directory, expanded))
  row.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      openDirectoryContextMenu(api, state, event, directory, expanded)
  })
  row.append(node("span", "oc-git-workbench__tree-chevron", expanded ? "v" : ">"))
  row.append(iconImage(FILE_ICONS.folder, "oc-git-workbench__tree-folder"))
  row.append(node("span", "oc-git-workbench__tree-name", directory.name))
  row.append(pill(`${treeFileCount(directory)} files`))
  group.append(row)
  if (expanded) {
    for (const child of sortedDirectories(directory)) group.append(renderTreeDirectory(api, state, child, depth + 1))
    for (const file of sortedFiles(directory.files)) group.append(renderFileRow(api, state, file, depth + 1))
  }
  return group
}

function renderFileRow(api, state, file, depth) {
  const row = node("div", "oc-git-workbench__file-row oc-git-workbench__tree-file")
  row.style.setProperty("--tree-indent", `${depth * 14}px`)
  row.setAttribute("aria-selected", String(state.selectedFile === file.file))
  row.dataset.status = fileStatusTone(file)
  row.dataset.path = file.file
  row.tabIndex = 0
  row.title = `${file.file}\nRight-click for file actions`
  row.addEventListener("contextmenu", (event) => openFileContextMenu(api, state, event, file))
  row.addEventListener("dblclick", () => selectFile(api, state, file.file))
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter") return selectFile(api, state, file.file)
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      openFileContextMenu(api, state, event, file)
  })
  const busy = Boolean(state.busy)
  row.append(statusMark(file))
  row.append(iconImage(fileIcon(file.file), "oc-git-workbench__file-glyph"))
  const info = node("button", "oc-git-workbench__file-main")
  info.type = "button"
  info.title = `Open diff for ${file.file}`
  info.addEventListener("click", () => selectFile(api, state, file.file))
  info.append(node("span", "oc-git-workbench__file-name", fileParts(file.file).name))
  info.append(node("span", "oc-git-workbench__file-meta", fileRowMeta(file)))
  row.append(info)
  const actions = node("div", "oc-git-workbench__row-actions")
  actions.append(
    iconButton("Diff", ACTION_ICONS.diff, () => selectFile(api, state, file.file), Boolean(state.diffBusy)),
  )
  if (file.unstaged || file.untracked)
    actions.append(
      iconButton(
        "Stage",
        ACTION_ICONS.stage,
        () => runGitAction(api, state, { action: "stage", files: [file.file] }, "Stage file"),
        busy,
      ),
    )
  if (file.staged)
    actions.append(
      iconButton(
        "Unstage",
        ACTION_ICONS.unstage,
        () => runGitAction(api, state, { action: "unstage", files: [file.file] }, "Unstage file"),
        busy,
      ),
    )
  if (state.settings.showDangerActions) {
    actions.append(
      iconButton(
        "Discard",
        ACTION_ICONS.undo,
        () =>
          confirmRun(state, `Discard changes in ${file.file}?`, () =>
            runGitAction(api, state, { action: "discard", files: [file.file] }, "Discard file"),
          ),
        busy,
        "danger",
      ),
    )
  }
  row.append(actions)
  return row
}

function renderSelectedFileDiff(api, state, snapshot) {
  const panel = node("div", "oc-git-workbench__diff-panel")
  if (!state.selectedFile) {
    panel.append(emptyBlock("Select a file", "Choose a changed file to open its diff."))
    return panel
  }

  if (!snapshot) {
    panel.append(loadingBlock("Loading Git data"))
    return panel
  }

  const file = snapshot.status.find((item) => item.file === state.selectedFile)
  const header = node("div", "oc-git-workbench__diff-header")
  const title = node("div", "")
  title.append(node("strong", "", state.selectedFile))
  if (file)
    title.append(
      node(
        "span",
        "oc-git-workbench__muted",
        `${fileStatusLabel(file)} ${signed(file.additions)} ${signed(-file.deletions)}`,
      ),
    )
  header.append(title)
  header.append(
    textButton(
      "Refresh diff",
      () => loadFileDiff(api, state, state.selectedFile, { force: true }),
      undefined,
      undefined,
      Boolean(state.diffBusy),
    ),
  )
  panel.append(header)

  if (state.diffError) panel.append(node("div", "oc-git-workbench__diff-error", state.diffError))
  if (state.diffBusy === state.selectedFile || (state.diffBusy && !state.diffByFile.has(state.selectedFile))) {
    panel.append(loadingBlock("Loading diff"))
    return panel
  }

  const diff = state.diffByFile.get(state.selectedFile)
  if (diff === undefined) {
    const empty = emptyBlock("Diff not loaded", "Open the file diff from the tree or refresh it here.")
    empty.append(
      textButton(
        "Load diff",
        () => loadFileDiff(api, state, state.selectedFile),
        undefined,
        undefined,
        Boolean(state.diffBusy),
      ),
    )
    panel.append(empty)
    return panel
  }
  if (!diff.patch) {
    panel.append(emptyBlock("No textual diff", "Git did not return a text patch for this file."))
    return panel
  }
  panel.append(renderPatch(diff.patch))
  return panel
}

function renderPatch(patch) {
  const pre = node("pre", "oc-git-workbench__diff")
  for (const line of String(patch).split(/\r?\n/)) {
    pre.append(node("span", diffLineClass(line), line || " "))
    pre.append(document.createTextNode("\n"))
  }
  return pre
}

function diffLineClass(line) {
  if (line.startsWith("@@")) return "oc-git-workbench__diff-line oc-git-workbench__diff-line--hunk"
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "oc-git-workbench__diff-line oc-git-workbench__diff-line--add"
  if (line.startsWith("-") && !line.startsWith("---"))
    return "oc-git-workbench__diff-line oc-git-workbench__diff-line--del"
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
    return "oc-git-workbench__diff-line oc-git-workbench__diff-line--meta"
  }
  return "oc-git-workbench__diff-line"
}

function selectFile(api, state, file) {
  state.selectedFile = file
  api.kv.set("selectedFile", file)
  api.dock.open.item("gitDiff", { area: "middle" })
  renderAll(state)
  return loadFileDiff(api, state, file)
}

export async function loadFileDiff(api, state, file, options = {}) {
  if (!file || state.diffBusy) return
  if (!options.force && state.diffByFile.has(file)) return
  const directory = actionDirectory(api, state)
  if (!directory) {
    state.diffError = "No project directory is active"
    renderAll(state)
    return
  }
  const previousDiff = state.diffByFile.get(file)
  const hadPreviousDiff = state.diffByFile.has(file)
  state.diffBusy = file
  state.diffError = ""
  if (options.force) state.diffByFile.delete(file)
  renderAll(state)
  try {
    const diffs = await api.host.git.diff({ directory, mode: "git", context: 3 })
    const next = Array.isArray(diffs) ? diffs : []
    if (options.force) state.diffByFile.delete(file)
    next
      .filter((item) => item && typeof item.file === "string")
      .forEach((item) => state.diffByFile.set(item.file, item))
    if (!state.diffByFile.has(file)) state.diffByFile.set(file, { file, patch: "", additions: 0, deletions: 0 })
  } catch (error) {
    if (isCancellation(error)) {
      if (hadPreviousDiff) state.diffByFile.set(file, previousDiff)
      return
    }
    state.diffError = error instanceof Error ? error.message : String(error)
  } finally {
    state.diffBusy = ""
    renderAll(state)
  }
}

function toggleTreeDirectory(api, state, path) {
  if (state.collapsedPaths.has(path)) {
    state.collapsedPaths.delete(path)
  } else {
    state.collapsedPaths.add(path)
  }
  api.kv.set("collapsedPaths", [...state.collapsedPaths])
  renderAll(state)
}

function buildStatusTree(files) {
  const root = { name: "", path: "", directories: new Map(), files: [] }
  for (const file of files) {
    const parts = file.file.split(/[\\/]/).filter(Boolean)
    const name = parts.pop()
    if (!name) continue
    const directory = parts.reduce((current, part) => {
      const path = current.path ? `${current.path}/${part}` : part
      if (!current.directories.has(part))
        current.directories.set(part, { name: part, path, directories: new Map(), files: [] })
      return current.directories.get(part)
    }, root)
    directory.files.push(file)
  }
  return root
}

function sortedDirectories(directory) {
  return [...directory.directories.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function sortedFiles(files) {
  return [...files].sort((a, b) => a.file.localeCompare(b.file))
}

function treeFileCount(directory) {
  return directory.files.length + sortedDirectories(directory).reduce((count, child) => count + treeFileCount(child), 0)
}

function directoryFiles(directory) {
  return [...directory.files, ...sortedDirectories(directory).flatMap((child) => directoryFiles(child))]
}

function openFileContextMenu(api, state, event, file) {
  const busy = Boolean(state.busy)
  const extension = fileExtension(file.file)
  openContextMenu(state, event, {
    title: fileParts(file.file).name,
    detail: file.file,
    items: [
      {
        label: "Open diff",
        description: "Show the selected file diff in the middle dock.",
        run: () => selectFile(api, state, file.file),
        disabled: Boolean(state.diffBusy),
      },
      {
        label: "Stage",
        description: "Add this file to the index.",
        run: () => runGitAction(api, state, { action: "stage", files: [file.file] }, "Stage file"),
        disabled: busy || (!file.unstaged && !file.untracked),
      },
      {
        label: "Unstage",
        description: "Remove this file from the index while keeping local changes.",
        run: () => runGitAction(api, state, { action: "unstage", files: [file.file] }, "Unstage file"),
        disabled: busy || !file.staged,
      },
      state.settings.showDangerActions
        ? {
            label: "Discard",
            description: "Delete local changes for this file after confirmation.",
            tone: "danger",
            run: () =>
              confirmRun(state, `Discard changes in ${file.file}?`, () =>
                runGitAction(api, state, { action: "discard", files: [file.file] }, "Discard file"),
              ),
            disabled: busy,
          }
        : undefined,
      {
        label: "Add exact file to .gitignore",
        description: file.untracked
          ? "Ignore this exact untracked repository-relative file path."
          : "Add this exact path, but keep the already tracked file tracked; .gitignore only affects untracked files.",
        run: () => runGitAction(api, state, { action: "ignore", pattern: file.file }, "Update .gitignore"),
        disabled: busy,
      },
      extension
        ? {
            label: `Add *.${extension} extension to .gitignore`,
            description: `Ignore untracked .${extension} files. Files already tracked by Git stay tracked.`,
            run: () => runGitAction(api, state, { action: "ignore", pattern: `*.${extension}` }, "Update .gitignore"),
            disabled: busy,
          }
        : undefined,
      {
        label: "Copy path",
        description: "Copy the repository-relative path.",
        run: () => copyPath(state, file.file),
      },
    ].filter(Boolean),
  })
}

function openDirectoryContextMenu(api, state, event, directory, expanded) {
  const busy = Boolean(state.busy)
  const files = directoryFiles(directory)
  const stageFiles = files.filter((file) => file.unstaged || file.untracked).map((file) => file.file)
  const unstageFiles = files.filter((file) => file.staged).map((file) => file.file)
  const discardFiles = files.filter((file) => !file.staged).map((file) => file.file)
  openContextMenu(state, event, {
    title: directory.name,
    detail: directory.path,
    items: [
      {
        label: expanded ? "Collapse folder" : "Expand folder",
        description: expanded ? "Hide this folder's changed files." : "Show this folder's changed files.",
        run: () => toggleTreeDirectory(api, state, directory.path),
      },
      {
        label: "Stage folder",
        description: `Stage ${stageFiles.length} changed file${stageFiles.length === 1 ? "" : "s"} in this folder.`,
        run: () => runGitAction(api, state, { action: "stage", files: stageFiles }, "Stage folder"),
        disabled: busy || stageFiles.length === 0,
      },
      {
        label: "Unstage folder",
        description: `Unstage ${unstageFiles.length} indexed file${unstageFiles.length === 1 ? "" : "s"} in this folder.`,
        run: () => runGitAction(api, state, { action: "unstage", files: unstageFiles }, "Unstage folder"),
        disabled: busy || unstageFiles.length === 0,
      },
      state.settings.showDangerActions
        ? {
            label: "Discard folder",
            description: `Discard ${discardFiles.length} unstaged file${discardFiles.length === 1 ? "" : "s"} after confirmation.`,
            tone: "danger",
            run: () =>
              confirmRun(state, `Discard changes in ${directory.path}?`, () =>
                runGitAction(api, state, { action: "discard", files: discardFiles }, "Discard folder"),
              ),
            disabled: busy || discardFiles.length === 0,
          }
        : undefined,
      {
        label: "Add exact folder to .gitignore",
        description: files.some((file) => !file.untracked)
          ? "Ignore this exact folder for untracked files. Files already tracked by Git stay tracked."
          : "Ignore this exact repository-relative folder of untracked files.",
        run: () => runGitAction(api, state, { action: "ignore", pattern: `${directory.path}/` }, "Update .gitignore"),
        disabled: busy,
      },
      {
        label: "Copy folder path",
        description: "Copy the repository-relative folder path.",
        run: () => copyPath(state, directory.path),
      },
    ].filter(Boolean),
  })
}

function openContextMenu(state, event, menu) {
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  const rect = target?.getBoundingClientRect()
  const keyboard = event.clientX === 0 && event.clientY === 0 && rect && (rect.left > 0 || rect.top > 0)
  const x = keyboard ? rect.left + 12 : Number.isFinite(event.clientX) ? event.clientX : rect ? rect.left + 12 : 16
  const y = keyboard ? rect.bottom + 2 : Number.isFinite(event.clientY) ? event.clientY : rect ? rect.bottom + 2 : 16
  state.contextMenu = {
    ...menu,
    restorePath: target?.dataset.path,
    x,
    y,
  }
  renderAll(state)
}

function renderContextMenu(state, menu) {
  const panel = node("div", "oc-git-workbench__context-menu")
  panel.style.left = `${menu.x}px`
  panel.style.top = `${menu.y}px`
  panel.setAttribute("role", "menu")
  panel.addEventListener("contextmenu", (event) => event.preventDefault())
  panel.addEventListener("keydown", (event) => handleContextMenuKeydown(state, panel, event))
  const header = node("div", "oc-git-workbench__context-menu-header")
  header.append(node("strong", "", menu.title), node("span", "", menu.detail))
  panel.append(header)
  for (const item of menu.items) panel.append(contextMenuItem(state, item))
  requestAnimationFrame(() => {
    if (!panel.isConnected) return
    const margin = 8
    const rect = panel.getBoundingClientRect()
    const left = Math.min(Math.max(menu.x, margin), Math.max(margin, window.innerWidth - rect.width - margin))
    const top = Math.min(Math.max(menu.y, margin), Math.max(margin, window.innerHeight - rect.height - margin))
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.querySelector("button:not(:disabled)")?.focus()
  })
  return panel
}

function handleContextMenuKeydown(state, panel, event) {
  if (event.key === "Escape") {
    event.preventDefault()
    closeContextMenu(state)
    return
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  const buttons = [...panel.querySelectorAll("button:not(:disabled)")]
  const current = buttons.indexOf(document.activeElement)
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, current - 1)
          : Math.min(buttons.length - 1, current + 1)
  buttons[next]?.focus()
}

function contextMenuItem(state, item) {
  const button = node(
    "button",
    `oc-git-workbench__context-menu-item${item.tone ? ` oc-git-workbench__context-menu-item--${item.tone}` : ""}`,
  )
  button.type = "button"
  button.disabled = Boolean(item.disabled)
  button.setAttribute("role", "menuitem")
  button.title = item.description || item.label
  const label = node("span", "")
  label.append(node("strong", "", item.label), node("span", "", item.description || ""))
  button.append(label)
  button.addEventListener("click", () => {
    if (button.disabled) return
    state.contextMenu = undefined
    renderAll(state)
    void item.run()
  })
  return button
}

function closeContextMenu(state) {
  state.restoreContextFocus = state.contextMenu?.restorePath
  state.contextMenu = undefined
  removeContextMenuElement(state)
  renderAll(state)
}

function removeContextMenuElement(state) {
  state.contextMenuCleanup?.()
  state.contextMenuCleanup = undefined
  state.contextMenuElement?.remove()
  state.contextMenuElement = undefined
}

function restoreContextFocus(state, shell) {
  if (!state.restoreContextFocus) return
  const path = state.restoreContextFocus
  state.restoreContextFocus = undefined
  requestAnimationFrame(() =>
    [...shell.querySelectorAll("[data-path]")].find((item) => item.dataset.path === path)?.focus(),
  )
}

async function copyPath(state, path) {
  try {
    await navigator.clipboard.writeText(path)
    state.notice = `Copied ${path}`
  } catch {
    state.notice = path
  } finally {
    renderAll(state)
  }
}

function renderHistory(api, state, snapshot) {
  const section = node("div", "oc-git-workbench__history")
  const list = node("div", "oc-git-workbench__history-list")
  if (!snapshot.history.length) {
    list.append(emptyBlock("No commits", "This repository has no commit history yet."))
  }
  for (const [index, commit] of snapshot.history.entries()) {
    list.append(renderCommitRow(api, state, commit, index))
  }
  section.append(list)
  section.append(renderCommitDetails(api, state, snapshot))
  return section
}

function renderCommitRow(api, state, commit, index) {
  const row = node("button", "oc-git-workbench__commit-row")
  row.type = "button"
  row.setAttribute("aria-selected", String(state.selectedCommit === commit.hash))
  row.addEventListener("click", () => {
    state.selectedCommit = commit.hash
    api.kv.set("selectedCommit", commit.hash)
    renderAll(state)
  })
  const graph = node("span", "oc-git-workbench__graph")
  graph.append(node("span", "oc-git-workbench__graph-line"))
  graph.append(
    node(
      "span",
      index === 0 ? "oc-git-workbench__graph-dot oc-git-workbench__graph-dot--head" : "oc-git-workbench__graph-dot",
    ),
  )
  const body = node("span", "oc-git-workbench__commit-body")
  const subject = node("span", "oc-git-workbench__commit-subject", commit.subject || commit.short)
  const meta = node(
    "span",
    "oc-git-workbench__commit-meta",
    `${commit.short} ${commit.author || ""} ${relativeDate(commit.date)}`.trim(),
  )
  body.append(subject, meta)
  const refs = node("span", "oc-git-workbench__refs")
  for (const ref of commit.refs || []) refs.append(pill(ref))
  row.append(graph, body, refs)
  return row
}

function renderCommitDetails(api, state, snapshot) {
  const commit = snapshot.history.find((item) => item.hash === state.selectedCommit) ?? snapshot.history[0]
  const panel = node("div", "oc-git-workbench__details")
  if (!commit) {
    panel.append(emptyBlock("Select a commit", "Commit details and history actions appear here."))
    return panel
  }
  panel.append(node("h3", "", commit.subject || commit.short))
  panel.append(
    node("p", "oc-git-workbench__muted", `${commit.hash}\n${commit.author} <${commit.email}> ${commit.date}`),
  )
  if (commit.body) panel.append(node("pre", "oc-git-workbench__commit-message", commit.body))
  const parents = node("div", "oc-git-workbench__parents")
  parents.append(node("span", "oc-git-workbench__muted", "Parents"))
  for (const parent of commit.parents || []) parents.append(pill(parent.slice(0, 12)))
  panel.append(parents)
  const actions = node("div", "oc-git-workbench__action-grid")
  const busy = Boolean(state.busy)
  actions.append(
    textButton(
      "Cherry-pick",
      () =>
        confirmRun(
          state,
          `Cherry-pick ${commit.short || commit.hash.slice(0, 12)} into the current branch?`,
          () => runGitAction(api, state, { action: "cherryPick", ref: commit.hash }, "Cherry-pick"),
          { requireDangerActions: false },
        ),
      undefined,
      undefined,
      busy,
    ),
  )
  actions.append(
    textButton(
      "Merge",
      () =>
        confirmRun(
          state,
          `Merge ${commit.short || commit.hash.slice(0, 12)} into the current branch?`,
          () => runGitAction(api, state, { action: "merge", ref: commit.hash }, "Merge"),
          { requireDangerActions: false },
        ),
      undefined,
      undefined,
      busy,
    ),
  )
  if (state.settings.showDangerActions && commit.parents?.[0]) {
    actions.append(
      textButton("Squash to parent", () => promptSquash(api, state, commit), "danger-soft", undefined, busy),
    )
  }
  panel.append(actions)
  return panel
}

function renderBranches(api, state, snapshot) {
  const section = node("div", "oc-git-workbench__section")
  const controls = node("div", "oc-git-workbench__action-grid")
  const busy = Boolean(state.busy)
  controls.append(textButton("Create branch", () => promptCreateBranch(api, state), undefined, undefined, busy))
  controls.append(
    textButton("Fetch all", () => runGitAction(api, state, { action: "fetch" }, "Fetch"), undefined, undefined, busy),
  )
  controls.append(
    textButton("Pull", () => runGitAction(api, state, { action: "pull" }, "Pull"), undefined, undefined, busy),
  )
  controls.append(
    textButton("Push", () => runGitAction(api, state, { action: "push" }, "Push"), undefined, undefined, busy),
  )
  if (state.settings.showDangerActions) {
    controls.append(
      textButton(
        "Force push",
        () =>
          confirmRun(state, "Force push with lease?", () =>
            runGitAction(api, state, { action: "push", force: true }, "Force push"),
          ),
        "danger",
        undefined,
        busy,
      ),
    )
  }
  section.append(controls)

  const remotes = node("div", "oc-git-workbench__remote-list")
  if (!snapshot.remotes.length) remotes.append(node("span", "oc-git-workbench__muted", "No remotes configured."))
  for (const remote of snapshot.remotes) {
    const item = node("div", "oc-git-workbench__remote")
    item.append(node("strong", "", remote.name))
    item.append(node("span", "oc-git-workbench__muted", remote.fetch || remote.push || "No URL"))
    const actions = node("div", "oc-git-workbench__inline-actions")
    actions.append(
      textButton("Fetch", () => runGitAction(api, state, { action: "fetch", remote: remote.name }, "Fetch")),
    )
    actions.append(textButton("Pull", () => runGitAction(api, state, { action: "pull", remote: remote.name }, "Pull")))
    actions.append(textButton("Push", () => runGitAction(api, state, { action: "push", remote: remote.name }, "Push")))
    item.append(actions)
    remotes.append(item)
  }
  section.append(remotes)

  const branches = node("div", "oc-git-workbench__branch-list")
  for (const branch of snapshot.branches) branches.append(renderBranchRow(api, state, branch))
  section.append(branches)
  return section
}

function renderBranchRow(api, state, branch) {
  const row = node("div", "oc-git-workbench__branch-row")
  const busy = Boolean(state.busy)
  const main = node("div", "oc-git-workbench__branch-main")
  main.append(badge(branch.current ? "*" : branch.remote ? "R" : "L"))
  const labels = node("div", "")
  labels.append(node("strong", "", branch.name))
  labels.append(
    node("span", "oc-git-workbench__muted", [branch.upstream, branch.tracking, branch.hash].filter(Boolean).join(" ")),
  )
  main.append(labels)
  row.append(main)
  const actions = node("div", "oc-git-workbench__row-actions")
  if (!branch.current && !branch.remote)
    actions.append(
      textButton(
        "Checkout",
        () => runGitAction(api, state, { action: "checkoutBranch", name: branch.name }, "Checkout"),
        undefined,
        undefined,
        busy,
      ),
    )
  actions.append(
    textButton(
      "Merge",
      () =>
        confirmRun(
          state,
          `Merge ${branch.name} into the current branch?`,
          () => runGitAction(api, state, { action: "merge", ref: branch.name }, "Merge"),
          { requireDangerActions: false },
        ),
      undefined,
      undefined,
      busy,
    ),
  )
  if (state.settings.showDangerActions && !branch.current && !branch.remote) {
    actions.append(
      textButton(
        "Delete",
        () =>
          confirmRun(state, `Delete branch ${branch.name}?`, () =>
            runGitAction(api, state, { action: "deleteBranch", name: branch.name }, "Delete branch"),
          ),
        "danger",
        undefined,
        busy,
      ),
    )
  }
  row.append(actions)
  return row
}

function renderStashes(api, state, snapshot) {
  const section = node("div", "oc-git-workbench__section")
  const controls = node("div", "oc-git-workbench__action-grid")
  const busy = Boolean(state.busy)
  controls.append(textButton("Save stash", () => promptStash(api, state), undefined, undefined, busy))
  controls.append(
    textButton("Refresh", () => refreshWorkbench(api, state), undefined, undefined, busy || state.discoveryBusy),
  )
  section.append(controls)
  if (!snapshot.stashes.length) {
    section.append(emptyBlock("No stashes", "Saved working tree snapshots appear here."))
    return section
  }
  const list = node("div", "oc-git-workbench__file-list")
  for (const stash of snapshot.stashes) {
    const row = node("div", "oc-git-workbench__stash-row")
    const main = node("div", "oc-git-workbench__branch-main")
    main.append(badge(stash.selector))
    const labels = node("div", "")
    labels.append(node("strong", "", stash.message || stash.selector))
    labels.append(node("span", "oc-git-workbench__muted", stash.hash || ""))
    main.append(labels)
    row.append(main)
    const actions = node("div", "oc-git-workbench__row-actions")
    actions.append(
      textButton(
        "Apply",
        () => runGitAction(api, state, { action: "stashApply", ref: stash.selector }, "Apply stash"),
        undefined,
        undefined,
        busy,
      ),
    )
    actions.append(
      textButton(
        "Pop",
        () => runGitAction(api, state, { action: "stashPop", ref: stash.selector }, "Pop stash"),
        undefined,
        undefined,
        busy,
      ),
    )
    if (state.settings.showDangerActions) {
      actions.append(
        textButton(
          "Drop",
          () =>
            confirmRun(state, `Drop ${stash.selector}?`, () =>
              runGitAction(api, state, { action: "stashDrop", ref: stash.selector }, "Drop stash"),
            ),
          "danger",
          undefined,
          busy,
        ),
      )
    }
    row.append(actions)
    list.append(row)
  }
  section.append(list)
  return section
}

export function renderConflicts(api, state, snapshot) {
  const section = node("div", "oc-git-workbench__section")
  const controls = node("div", "oc-git-workbench__action-grid")
  const busy = Boolean(state.busy)
  // Git records a manually resolved conflict when its file is staged.
  const conflictFiles = snapshot.conflicts.map((conflict) => conflict.file)
  if (conflictFiles.length) {
    controls.append(
      iconButton(
        "Resolve all conflicts",
        ACTION_ICONS.resolveAll,
        () => runGitAction(api, state, { action: "stage", files: conflictFiles }, "Resolve all conflicts"),
        busy,
        "primary",
      ),
    )
  }
  controls.append(
    textButton(
      "Continue",
      () => runGitAction(api, state, { action: "continueOperation" }, "Continue operation"),
      undefined,
      undefined,
      busy,
    ),
  )
  controls.append(
    textButton(
      "Abort",
      () =>
        confirmRun(
          state,
          "Abort the current Git operation?",
          () => runGitAction(api, state, { action: "abortOperation" }, "Abort operation"),
          { requireDangerActions: false },
        ),
      "danger",
      undefined,
      busy,
    ),
  )
  section.append(controls)
  if (!snapshot.conflicts.length) {
    section.append(emptyBlock("No conflicts", "Merge and cherry-pick conflicts appear here."))
    return section
  }
  const list = node("div", "oc-git-workbench__file-list")
  for (const conflict of snapshot.conflicts) {
    const row = node("div", "oc-git-workbench__file-row oc-git-workbench__conflict-row")
    row.append(badge("UU"))
    row.append(node("span", "oc-git-workbench__file-name", conflict.file))
    const actions = node("div", "oc-git-workbench__row-actions")
    actions.append(
      iconButton(
        "Resolve",
        ACTION_ICONS.resolve,
        () => runGitAction(api, state, { action: "stage", files: [conflict.file] }, "Resolve conflict"),
        busy,
        "primary",
      ),
    )
    row.append(actions)
    list.append(row)
  }
  section.append(list)
  return section
}

function promptCommit(api, state) {
  openTextDialog(state, {
    title: "Commit staged changes",
    description: "Only currently staged changes are included in this commit.",
    fields: [
      {
        id: "message",
        label: "Commit message",
        placeholder: "chore: describe staged changes",
        required: true,
      },
    ],
    confirm: "Commit",
    submit: (values) => runGitAction(api, state, { action: "commit", message: values.message }, "Commit"),
  })
}

function promptStash(api, state) {
  openTextDialog(state, {
    title: "Save stash",
    description: "Stores the current working tree, including untracked files.",
    fields: [
      {
        id: "message",
        label: "Stash message",
        value: "Git Workbench stash",
        placeholder: "WIP: describe stashed work",
      },
    ],
    confirm: "Save stash",
    submit: (values) => runGitAction(api, state, { action: "stashSave", message: values.message }, "Save stash"),
  })
}

export function promptCreateBranch(api, state) {
  openTextDialog(state, {
    title: "Create branch",
    description: "Create a local branch, optionally from another branch, tag, or commit.",
    fields: [
      { id: "name", label: "New branch name", placeholder: "feature-name", required: true, multiline: false },
      { id: "start", label: "Start point (optional)", placeholder: "Current HEAD", multiline: false },
    ],
    confirm: "Create branch",
    submit: (values) =>
      runGitAction(
        api,
        state,
        { action: "createBranch", name: values.name, start: values.start || undefined },
        "Create branch",
      ),
  })
}

export function promptSquash(api, state, commit) {
  const parent = commit.parents?.[0]
  if (!parent) return
  if (!window.confirm(`Squash commits back to ${parent.slice(0, 12)}? This rewrites local history.`)) return
  openTextDialog(state, {
    title: "Squash commits",
    description: `Rewrite the selected range ending at ${commit.hash.slice(0, 12)} with one commit.`,
    fields: [
      {
        id: "message",
        label: "Squash commit message",
        value: commit.subject || "Squashed changes",
        required: true,
      },
    ],
    confirm: "Squash",
    submit: (values) =>
      runGitAction(
        api,
        state,
        { action: "squashRange", start: parent, end: commit.hash, message: values.message },
        "Squash",
      ),
  })
}

function confirmRun(state, message, run, options = {}) {
  if (options.requireDangerActions !== false && !state.settings.showDangerActions) return
  if (!window.confirm(message)) return
  return run()
}

export function openTextDialog(state, dialog) {
  const fields = dialog.fields ?? []
  const values = Object.fromEntries(fields.map((field) => [field.id, field.value ?? ""]))
  state.dialog = {
    ...dialog,
    fields,
    values,
    focus: fields[0]
      ? { control: "field", field: fields[0].id, start: 0, end: String(values[fields[0].id] ?? "").length }
      : { control: "confirm" },
    error: undefined,
  }
  renderAll(state)
}

export function renderTextDialog(state) {
  const dialog = state.dialog
  const overlay = node("div", "oc-git-workbench__modal-backdrop")
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay) return
    closeTextDialog(state)
  })
  const form = node("form", "oc-git-workbench__modal")
  form.setAttribute("role", "dialog")
  form.setAttribute("aria-modal", "true")
  form.setAttribute("aria-labelledby", "oc-git-workbench-dialog-title")
  const title = node("h3", "", dialog.title)
  title.id = "oc-git-workbench-dialog-title"
  form.append(title)
  if (dialog.description) form.append(node("p", "oc-git-workbench__muted", dialog.description))
  const inputs = new Map()
  for (const field of dialog.fields) {
    const label = node("label", "oc-git-workbench__field")
    label.append(node("span", "", field.label))
    const input = node(
      field.type === "select" ? "select" : field.multiline === false ? "input" : "textarea",
      "oc-git-workbench__textarea",
    )
    input.value = dialog.values?.[field.id] ?? ""
    if (input instanceof HTMLSelectElement) {
      input.classList.add("oc-git-workbench__textarea--single-line")
      for (const item of field.options ?? []) {
        const option = document.createElement("option")
        option.value = item.value
        option.textContent = item.label
        option.title = item.description ?? item.value
        input.append(option)
      }
      input.value = dialog.values?.[field.id] ?? ""
    } else {
      input.placeholder = field.placeholder ?? ""
    }
    if (input instanceof HTMLTextAreaElement) input.rows = 4
    if (input instanceof HTMLInputElement) {
      input.type = "text"
      input.classList.add("oc-git-workbench__textarea--single-line")
    }
    const remember = () => rememberTextDialogField(state, dialog, field.id, input)
    input.addEventListener("input", remember)
    input.addEventListener("change", remember)
    input.addEventListener("focus", remember)
    input.addEventListener("select", remember)
    input.addEventListener("keyup", remember)
    input.addEventListener("mouseup", remember)
    label.append(input)
    if (input instanceof HTMLSelectElement && field.showOptionDescriptions) {
      const descriptions = node("div", "oc-git-workbench__option-descriptions")
      for (const item of field.options ?? []) {
        const description = node("div", "oc-git-workbench__option-description")
        description.append(node("strong", "", item.label), node("code", "", item.description ?? item.value))
        descriptions.append(description)
      }
      label.append(descriptions)
    }
    if (dialog.error?.field === field.id) {
      label.append(node("div", "oc-git-workbench__field-error", dialog.error.message))
    }
    inputs.set(field.id, input)
    form.append(label)
  }
  const values = () => Object.fromEntries(Array.from(inputs, ([id, input]) => [id, input.value]))
  const actions = node("div", "oc-git-workbench__modal-actions")
  const cancel = textButton("Cancel", () => closeTextDialog(state))
  const confirm = textButton(dialog.confirm, () => submitTextDialog(state, dialog, values()), "primary")
  cancel.addEventListener("focus", () => rememberTextDialogControl(state, dialog, "cancel"))
  confirm.addEventListener("focus", () => rememberTextDialogControl(state, dialog, "confirm"))
  actions.append(cancel, confirm)
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    submitTextDialog(state, dialog, values())
  })
  form.append(actions)
  overlay.append(form)
  overlay.addEventListener("keydown", (event) => handleTextDialogKeyDown(state, dialog, form, values, event))
  queueMicrotask(() => restoreTextDialogFocus(state, dialog, overlay, inputs, cancel, confirm))
  return overlay
}

function syncTextDialogElement(state) {
  if (state.dialog && state.dialogRendered === state.dialog && state.dialogElement?.isConnected) return
  removeTextDialogElement(state)
  if (!state.dialog) return
  state.dialogStyleElement = styleNode()
  state.dialogElement = renderTextDialog(state)
  state.dialogRendered = state.dialog
  document.body.append(state.dialogStyleElement, state.dialogElement)
}

function removeTextDialogElement(state) {
  state.dialogElement?.remove()
  state.dialogStyleElement?.remove()
  state.dialogElement = undefined
  state.dialogStyleElement = undefined
  state.dialogRendered = undefined
}

function rememberTextDialogField(state, dialog, field, input) {
  if (state.dialog !== dialog) return
  dialog.values = { ...dialog.values, [field]: input.value }
  dialog.focus = {
    control: "field",
    field,
    start: "selectionStart" in input ? (input.selectionStart ?? input.value.length) : 0,
    end: "selectionEnd" in input ? (input.selectionEnd ?? input.value.length) : input.value.length,
  }
}

function rememberTextDialogControl(state, dialog, control) {
  if (state.dialog !== dialog) return
  dialog.focus = { control }
}

function restoreTextDialogFocus(state, dialog, overlay, inputs, cancel, confirm) {
  if (state.dialog !== dialog || !overlay.isConnected) return
  const focus = dialog.focus
  if (focus?.control === "cancel") {
    cancel.focus()
    return
  }
  if (focus?.control === "confirm") {
    confirm.focus()
    return
  }
  const input = inputs.get(focus?.field) ?? inputs.values().next().value
  if (!input) {
    confirm.focus()
    return
  }
  const start = Math.min(Math.max(0, focus?.start ?? 0), input.value.length)
  const end = Math.min(Math.max(start, focus?.end ?? input.value.length), input.value.length)
  if ("setSelectionRange" in input) input.setSelectionRange(start, end)
  input.focus()
}

function handleTextDialogKeyDown(state, dialog, form, values, event) {
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    closeTextDialog(state)
    return
  }
  if (event.key === "Enter" && event.target instanceof HTMLInputElement && !event.isComposing) {
    event.preventDefault()
    submitTextDialog(state, dialog, values())
    return
  }
  if (event.key !== "Tab") return
  const controls = Array.from(
    form.querySelectorAll(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((control) => !control.hidden && control.getAttribute("aria-hidden") !== "true")
  if (!controls.length) {
    event.preventDefault()
    form.focus()
    return
  }
  const index = controls.indexOf(document.activeElement)
  const target = event.shiftKey
    ? index <= 0
      ? controls.at(-1)
      : undefined
    : index === -1 || index === controls.length - 1
      ? controls[0]
      : undefined
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  target.focus()
}

export function submitTextDialog(state, dialog, raw) {
  const values = Object.fromEntries(dialog.fields.map((field) => [field.id, String(raw[field.id] ?? "").trim()]))
  const missing = dialog.fields.find((field) => field.required && !values[field.id])
  if (missing) {
    state.dialog = {
      ...dialog,
      values: Object.fromEntries(dialog.fields.map((field) => [field.id, String(raw[field.id] ?? "")])),
      focus: { control: "field", field: missing.id, start: 0, end: String(raw[missing.id] ?? "").length },
      error: { field: missing.id, message: `${missing.label} is required.` },
    }
    renderAll(state)
    return
  }
  state.dialog = undefined
  renderAll(state)
  return dialog.submit(values)
}

export function closeTextDialog(state) {
  const dialog = state.dialog
  state.dialog = undefined
  dialog?.cancel?.()
  renderAll(state)
}

function normalizeSnapshot(input) {
  return {
    info: input?.info && typeof input.info === "object" ? input.info : {},
    status: Array.isArray(input?.status) ? input.status : [],
    history: Array.isArray(input?.history) ? input.history : [],
    branches: Array.isArray(input?.branches) ? input.branches : [],
    remotes: Array.isArray(input?.remotes) ? input.remotes : [],
    tags: Array.isArray(input?.tags) ? input.tags : [],
    stashes: Array.isArray(input?.stashes) ? input.stashes : [],
    conflicts: Array.isArray(input?.conflicts) ? input.conflicts : [],
    operation: input?.operation && typeof input.operation === "object" ? input.operation : { inProgress: false },
  }
}

function node(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function iconButton(title, icon, run, disabled, tone) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `oc-git-workbench__icon-button${tone ? ` oc-git-workbench__icon-button--${tone}` : ""}`
  button.title = title
  button.setAttribute("aria-label", title)
  button.append(iconImage(icon, "oc-git-workbench__action-icon"))
  button.disabled = Boolean(disabled)
  button.addEventListener("click", () => void run())
  return button
}

function iconImage(src, className) {
  const icon = node("span", className)
  icon.style.setProperty("--icon-url", `url("${src}")`)
  icon.setAttribute("aria-hidden", "true")
  return icon
}

function textButton(label, run, tone, icon, disabled) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `oc-git-workbench__button${tone ? ` oc-git-workbench__button--${tone}` : ""}`
  button.title = label
  if (icon) {
    const image = document.createElement("img")
    image.src = icon
    image.alt = ""
    image.className = "oc-git-workbench__button-icon"
    button.append(image, document.createTextNode(label))
  } else {
    button.textContent = label
  }
  button.disabled = Boolean(disabled)
  button.addEventListener("click", () => void run())
  return button
}

function pill(text) {
  return node("span", "oc-git-workbench__pill", text)
}

function badge(text) {
  return node("span", "oc-git-workbench__badge", text)
}

function statusMark(file) {
  const mark = node(
    "span",
    `oc-git-workbench__status-mark oc-git-workbench__status-mark--${fileStatusTone(file)}`,
    file.code || "?",
  )
  mark.title = fileStatusLabel(file)
  return mark
}

function callout(type, text) {
  const item = node("div", `oc-git-workbench__callout oc-git-workbench__callout--${type}`)
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (index > 0) item.append(document.createElement("br"))
    item.append(document.createTextNode(line))
  }
  return item
}

function loadingBlock(text) {
  const block = node("div", "oc-git-workbench__empty")
  const image = document.createElement("img")
  image.src = EMPTY_IMAGE
  image.alt = ""
  image.className = "oc-git-workbench__empty-image"
  block.append(image, node("strong", "", text))
  return block
}

function emptyBlock(title, detail) {
  const block = node("div", "oc-git-workbench__empty")
  const image = document.createElement("img")
  image.src = EMPTY_IMAGE
  image.alt = ""
  image.className = "oc-git-workbench__empty-image"
  block.append(image, node("strong", "", title), node("span", "", detail))
  return block
}

function fileStatusLabel(file) {
  if (file.conflicted) return "conflict"
  if (file.untracked) return "untracked"
  if (file.staged && file.unstaged) return "staged + modified"
  if (file.staged) return "staged"
  if (file.unstaged) return "modified"
  return file.status || "changed"
}

function fileStatusTone(file) {
  if (file.conflicted) return "conflict"
  if (file.untracked) return "new"
  if (file.staged && file.unstaged) return "mixed"
  if (file.staged) return "staged"
  if (file.unstaged) return "modified"
  return "changed"
}

function fileIcon(filePath) {
  const extension = fileParts(filePath).name.toLowerCase().split(".").at(-1) || ""
  if (["ts", "tsx"].includes(extension)) return FILE_ICONS.ts
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return FILE_ICONS.js
  if (["json", "jsonc"].includes(extension)) return FILE_ICONS.json
  if (["md", "mdx"].includes(extension)) return FILE_ICONS.md
  if (["asset", "dat", "png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension)) return FILE_ICONS.asset
  return FILE_ICONS.file
}

function fileParts(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return {
    name: parts.at(-1) || path,
    directory: parts.slice(0, -1).join("/"),
  }
}

function fileExtension(path) {
  const name = fileParts(path).name
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return
  const extension = name.slice(dot + 1)
  if (!/^[a-z0-9][a-z0-9+_-]*$/i.test(extension)) return
  return extension
}

function directoryName(directory) {
  return fileParts(directory).name || directory
}

function fileRowMeta(file) {
  const parts = fileParts(file.file)
  const metrics = `${signed(file.additions)} ${signed(-file.deletions)}`
  if (parts.directory) return `${parts.directory} - ${fileStatusLabel(file)} ${metrics}`
  return `${fileStatusLabel(file)} ${metrics}`
}

function signed(value) {
  const number = Number(value) || 0
  if (number > 0) return `+${number}`
  if (number < 0) return String(number)
  return "0"
}

function relativeDate(value) {
  if (!value) return ""
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  const diff = Math.max(0, Date.now() - time)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))}m`
  if (diff < day) return `${Math.floor(diff / hour)}h`
  return `${Math.floor(diff / day)}d`
}

function styleNode() {
  const style = document.createElement("style")
  style.textContent = `
    .oc-git-workbench {
      height: 100%;
      min-height: 0;
      --oc-git-accent: #3b82f6;
      --oc-git-success: #22c55e;
      --oc-git-warning: #f59e0b;
      --oc-git-danger: #ef4444;
      color: var(--text-base);
      background: var(--background-base);
      font: 12px/1.45 var(--font-sans, ui-sans-serif, system-ui);
    }
    .oc-git-workbench__view,
    .oc-git-workbench__shell {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .oc-git-workbench__diff-shell {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 10px;
    }
    .oc-git-workbench__header {
      flex: 0 0 auto;
      padding: 10px 10px 9px;
      border-bottom: 1px solid var(--border-weak-base);
      background: linear-gradient(180deg, var(--background-stronger), var(--background-base));
    }
    .oc-git-workbench__title-row {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .oc-git-workbench__icon {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      border-radius: 7px;
      color: var(--text-strong);
    }
    .oc-git-workbench__title {
      min-width: 0;
      display: grid;
      gap: 1px;
      flex: 1;
    }
    .oc-git-workbench__title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      color: var(--text-strong);
    }
    .oc-git-workbench__title span,
    .oc-git-workbench__muted {
      color: var(--text-weak);
      white-space: pre-wrap;
    }
    .oc-git-workbench__project-picker {
      min-width: 130px;
      max-width: 220px;
      display: grid;
      gap: 2px;
      color: var(--text-weak);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .oc-git-workbench__project-select {
      min-width: 0;
      width: 100%;
      height: 26px;
      border: 1px solid var(--border-weak-base);
      border-radius: 5px;
      background: var(--surface-panel, var(--background-stronger));
      color: var(--text-base);
      color-scheme: inherit;
      font: 12px/1.3 var(--font-sans, ui-sans-serif, system-ui);
      text-transform: none;
      letter-spacing: normal;
      padding: 0 7px;
    }
    .oc-git-workbench__project-select option {
      background: var(--surface-panel, var(--background-stronger));
      color: var(--text-base);
    }
    .oc-git-workbench__project-select option:checked {
      background: var(--oc-git-accent);
      color: white;
    }
    .oc-git-workbench__project-select:focus-visible {
      outline: 2px solid rgba(59, 130, 246, .55);
      outline-offset: 1px;
    }
    .oc-git-workbench__toolbar,
    .oc-git-workbench__inline-actions,
    .oc-git-workbench__row-actions,
    .oc-git-workbench__stats,
    .oc-git-workbench__parents {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .oc-git-workbench__toolbar {
      flex: 0 0 auto;
      flex-wrap: nowrap;
    }
    .oc-git-workbench__stats {
      margin-top: 8px;
    }
    .oc-git-workbench__file-row .oc-git-workbench__row-actions {
      flex-wrap: nowrap;
      gap: 4px;
      justify-content: flex-end;
    }
    .oc-git-workbench__icon-button,
    .oc-git-workbench__button {
      border: 1px solid var(--border-weak-base);
      background: var(--surface-panel);
      color: var(--text-base);
      border-radius: 4px;
      height: 24px;
      padding: 0 8px;
      font: inherit;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      cursor: default;
      transition: background .12s ease, border-color .12s ease, color .12s ease, transform .12s ease;
    }
    .oc-git-workbench__icon-button {
      width: 26px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .oc-git-workbench__action-icon,
    .oc-git-workbench__button-icon,
    .oc-git-workbench__tree-folder,
    .oc-git-workbench__file-glyph {
      width: 16px;
      height: 16px;
      display: block;
      flex: 0 0 auto;
      background: currentColor;
      -webkit-mask: var(--icon-url) center / contain no-repeat;
      mask: var(--icon-url) center / contain no-repeat;
    }
    .oc-git-workbench__button-icon {
      display: inline-block;
    }
    .oc-git-workbench__icon-button:hover,
    .oc-git-workbench__button:hover {
      background: var(--surface-hover-base);
      border-color: var(--border-strong, var(--border-weak-base));
      color: var(--text-strong);
    }
    .oc-git-workbench__icon-button:focus-visible,
    .oc-git-workbench__button:focus-visible,
    .oc-git-workbench__file-row:focus-visible,
    .oc-git-workbench__file-main:focus-visible,
    .oc-git-workbench__tree-directory:focus-visible,
    .oc-git-workbench__commit-row:focus-visible {
      outline: 2px solid rgba(59, 130, 246, .55);
      outline-offset: 1px;
    }
    .oc-git-workbench__icon-button:disabled,
    .oc-git-workbench__button:disabled {
      opacity: .45;
      cursor: default;
    }
    .oc-git-workbench__button--primary {
      border-color: rgba(59, 130, 246, .55);
      color: #dbeafe;
      background: rgba(59, 130, 246, .16);
    }
    .oc-git-workbench__icon-button--primary {
      border-color: rgba(59, 130, 246, .55);
      color: #dbeafe;
      background: rgba(59, 130, 246, .16);
    }
    .oc-git-workbench__button--danger,
    .oc-git-workbench__button--danger-soft,
    .oc-git-workbench__icon-button--danger {
      border-color: rgba(248, 113, 113, .45);
      color: #fecaca;
      background: rgba(248, 113, 113, .09);
    }
    .oc-git-workbench__callout,
    .oc-git-workbench__operation {
      margin: 8px 10px 0;
      padding: 8px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--surface-panel);
    }
    .oc-git-workbench__callout--error {
      border-color: rgba(248, 113, 113, .5);
      color: #fecaca;
    }
    .oc-git-workbench__callout--notice {
      border-color: rgba(34, 211, 238, .4);
      color: #dffbff;
    }
    .oc-git-workbench__operation {
      display: grid;
      gap: 6px;
    }
    .oc-git-workbench__tabs {
      flex: 0 0 auto;
      display: flex;
      gap: 4px;
      overflow-x: auto;
      padding: 8px 10px 0;
    }
    .oc-git-workbench__tab {
      flex: 0 0 auto;
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
    }
    .oc-git-workbench__tab[aria-selected="true"] {
      color: var(--text-strong);
      border-color: rgba(59, 130, 246, .6);
      background: rgba(59, 130, 246, .14);
    }
    .oc-git-workbench__body {
      min-height: 0;
      flex: 1;
      overflow: auto;
      padding: 10px;
    }
    .oc-git-workbench__section {
      display: grid;
      gap: 10px;
    }
    .oc-git-workbench__action-grid {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
      padding: 3px 0;
    }
    .oc-git-workbench__tree-summary {
      display: grid;
      gap: 2px;
      border: 1px solid var(--border-weak-base);
      border-left: 3px solid var(--oc-git-accent);
      border-radius: 7px;
      background: var(--background-stronger);
      padding: 7px 9px;
    }
    .oc-git-workbench__tree-summary strong {
      color: var(--text-strong);
    }
    .oc-git-workbench__tree-summary span {
      color: var(--text-weak);
      font-size: 11px;
    }
    .oc-git-workbench__worktree {
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      align-items: start;
    }
    .oc-git-workbench__file-list,
    .oc-git-workbench__branch-list,
    .oc-git-workbench__remote-list {
      display: grid;
      gap: 6px;
    }
    .oc-git-workbench__tree {
      align-content: start;
      gap: 1px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: color-mix(in srgb, var(--background-stronger) 82%, transparent);
      padding: 4px;
    }
    .oc-git-workbench__tree-group {
      display: grid;
      gap: 2px;
    }
    .oc-git-workbench__tree-directory {
      min-width: 0;
      display: grid;
      grid-template-columns: 12px 18px minmax(0, 1fr) auto;
      align-items: center;
      gap: 4px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: inherit;
      text-align: left;
      font: inherit;
      min-height: 23px;
      padding: 1px 5px 1px calc(5px + var(--tree-indent, 0px));
    }
    .oc-git-workbench__tree-directory:hover {
      background: var(--surface-hover-base);
      border-color: var(--border-weak-base);
    }
    .oc-git-workbench__tree-chevron {
      color: var(--text-weak);
      font-size: 11px;
      line-height: 1;
    }
    .oc-git-workbench__tree-folder {
      color: var(--text-weak);
    }
    .oc-git-workbench__tree-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .oc-git-workbench__branch-row,
    .oc-git-workbench__stash-row,
    .oc-git-workbench__remote {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-stronger);
      padding: 6px;
    }
    .oc-git-workbench__file-row {
      min-width: 0;
      display: grid;
      grid-template-columns: 20px 18px minmax(0, 1fr) auto;
      align-items: center;
      gap: 5px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      min-height: 24px;
      padding: 1px 5px;
    }
    .oc-git-workbench__conflict-row {
      grid-template-columns: 20px minmax(0, 1fr) auto;
    }
    .oc-git-workbench__tree-file {
      padding-left: calc(18px + var(--tree-indent, 0px));
    }
    .oc-git-workbench__file-row:hover {
      background: var(--surface-hover-base);
      border-color: var(--border-weak-base);
    }
    .oc-git-workbench__file-row[aria-selected="true"] {
      border-color: rgba(59, 130, 246, .55);
      background: rgba(59, 130, 246, .13);
    }
    .oc-git-workbench__remote {
      align-items: flex-start;
      flex-direction: column;
    }
    .oc-git-workbench__file-main {
      min-width: 0;
      flex: 1;
      display: grid;
      gap: 1px;
      border: 0;
      background: transparent;
      color: inherit;
      text-align: left;
      padding: 0;
      font: inherit;
      cursor: default;
    }
    .oc-git-workbench__file-glyph {
      color: var(--text-weak);
      opacity: .9;
    }
    .oc-git-workbench__file-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .oc-git-workbench__file-meta {
      color: var(--text-weak);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-git-workbench__diff-panel {
      min-width: 0;
      min-height: 260px;
      display: grid;
      align-content: start;
      gap: 8px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-stronger);
      padding: 8px;
    }
    .oc-git-workbench--diff-dock .oc-git-workbench__diff-panel {
      flex: 1;
      min-height: 0;
      align-content: stretch;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .oc-git-workbench__diff-header {
      min-width: 0;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    .oc-git-workbench__diff-header > div {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .oc-git-workbench__diff-header strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .oc-git-workbench__diff-error,
    .oc-git-workbench__field-error {
      border: 1px solid rgba(248, 113, 113, .45);
      border-radius: 6px;
      background: rgba(248, 113, 113, .08);
      color: #fecaca;
      padding: 8px;
    }
    .oc-git-workbench__diff {
      max-height: min(60vh, 640px);
      overflow: auto;
      margin: 0;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-base);
      color: var(--text-base);
      font: 12px/1.45 var(--font-mono, ui-monospace, monospace);
      tab-size: 2;
    }
    .oc-git-workbench--diff-dock .oc-git-workbench__diff {
      max-height: none;
      min-height: 0;
      height: 100%;
    }
    .oc-git-workbench__diff-line {
      display: block;
      min-width: max-content;
      padding: 0 8px;
      white-space: pre;
    }
    .oc-git-workbench__diff-line--add {
      background: rgba(34, 197, 94, .12);
      color: #bbf7d0;
    }
    .oc-git-workbench__diff-line--del {
      background: rgba(248, 113, 113, .12);
      color: #fecaca;
    }
    .oc-git-workbench__diff-line--hunk {
      background: rgba(59, 130, 246, .14);
      color: #bfdbfe;
    }
    .oc-git-workbench__diff-line--meta {
      color: var(--text-weak);
    }
    .oc-git-workbench__badge,
    .oc-git-workbench__pill {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      max-width: 180px;
      height: 20px;
      padding: 0 6px;
      border-radius: 5px;
      border: 1px solid var(--border-weak-base);
      background: var(--surface-panel);
      color: var(--text-weak);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-git-workbench__pill {
      max-width: 120px;
    }
    .oc-git-workbench__status-mark {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 18px;
      border-radius: 4px;
      border: 1px solid var(--border-weak-base);
      background: var(--surface-panel);
      color: var(--text-strong);
      font-size: 10px;
      font-weight: 650;
      letter-spacing: .02em;
    }
    .oc-git-workbench__status-mark--modified,
    .oc-git-workbench__status-mark--mixed {
      border-color: rgba(245, 158, 11, .55);
      color: #fde68a;
      background: rgba(245, 158, 11, .14);
    }
    .oc-git-workbench__status-mark--new {
      border-color: rgba(34, 197, 94, .55);
      color: #bbf7d0;
      background: rgba(34, 197, 94, .14);
    }
    .oc-git-workbench__status-mark--staged {
      border-color: rgba(59, 130, 246, .58);
      color: #bfdbfe;
      background: rgba(59, 130, 246, .16);
    }
    .oc-git-workbench__status-mark--conflict {
      border-color: rgba(239, 68, 68, .6);
      color: #fecaca;
      background: rgba(239, 68, 68, .18);
    }
    .oc-git-workbench__history {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(220px, .8fr);
      gap: 10px;
    }
    .oc-git-workbench__history-list {
      min-height: 0;
      display: grid;
      align-content: start;
      gap: 4px;
    }
    .oc-git-workbench__commit-row {
      position: relative;
      min-width: 0;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 42px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-stronger);
      color: inherit;
      text-align: left;
      font: inherit;
      padding: 4px 6px 4px 0;
    }
    .oc-git-workbench__commit-row[aria-selected="true"] {
      border-color: rgba(34, 211, 238, .45);
      background: rgba(34, 211, 238, .08);
    }
    .oc-git-workbench__graph {
      position: relative;
      height: 100%;
      min-height: 34px;
      display: grid;
      place-items: center;
    }
    .oc-git-workbench__graph-line {
      position: absolute;
      top: -8px;
      bottom: -8px;
      width: 2px;
      background: rgba(148, 163, 184, .3);
    }
    .oc-git-workbench__graph-dot {
      position: relative;
      z-index: 1;
      width: 10px;
      height: 10px;
      border-radius: 99px;
      background: #22d3ee;
      box-shadow: 0 0 0 3px #06111c;
    }
    .oc-git-workbench__graph-dot--head {
      background: #a3e635;
    }
    .oc-git-workbench__commit-body {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .oc-git-workbench__commit-subject {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .oc-git-workbench__commit-meta {
      color: var(--text-weak);
      font-size: 11px;
    }
    .oc-git-workbench__refs {
      max-width: 160px;
      display: flex;
      gap: 4px;
      overflow: hidden;
    }
    .oc-git-workbench__details {
      min-width: 0;
      align-self: start;
      position: sticky;
      top: 0;
      display: grid;
      gap: 8px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-stronger);
      padding: 10px;
    }
    .oc-git-workbench__details h3 {
      margin: 0;
      font-size: 13px;
      color: var(--text-strong);
    }
    .oc-git-workbench__details p {
      margin: 0;
    }
    .oc-git-workbench__commit-message {
      max-height: 180px;
      overflow: auto;
      margin: 0;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-base);
      padding: 8px;
      white-space: pre-wrap;
      color: var(--text-base);
      font: 12px/1.4 var(--font-mono, ui-monospace, monospace);
    }
    .oc-git-workbench__branch-main {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .oc-git-workbench__branch-main > div {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .oc-git-workbench__branch-main strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .oc-git-workbench__context-menu {
      position: fixed;
      z-index: 1100;
      width: min(260px, calc(100vw - 16px));
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      overscroll-behavior: contain;
      display: grid;
      gap: 3px;
      border: 1px solid var(--border-strong, var(--border-weak-base));
      border-radius: 8px;
      background: var(--background-stronger);
      box-shadow: 0 18px 60px rgba(0, 0, 0, .38);
      padding: 5px;
    }
    .oc-git-workbench__context-menu-header {
      display: grid;
      gap: 1px;
      border-bottom: 1px solid var(--border-weak-base);
      padding: 5px 6px 7px;
      margin-bottom: 2px;
    }
    .oc-git-workbench__context-menu-header strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .oc-git-workbench__context-menu-header span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-weak);
      font-size: 11px;
    }
    .oc-git-workbench__context-menu-item {
      width: 100%;
      min-width: 0;
      display: grid;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: var(--text-base);
      text-align: left;
      font: inherit;
      padding: 6px;
    }
    .oc-git-workbench__context-menu-item:hover:not(:disabled),
    .oc-git-workbench__context-menu-item:focus-visible {
      border-color: var(--border-weak-base);
      background: var(--surface-hover-base);
      outline: none;
    }
    .oc-git-workbench__context-menu-item:disabled {
      opacity: .45;
    }
    .oc-git-workbench__context-menu-item--danger {
      color: #fecaca;
    }
    .oc-git-workbench__context-menu-item > span {
      min-width: 0;
      display: grid;
      gap: 1px;
    }
    .oc-git-workbench__context-menu-item strong,
    .oc-git-workbench__context-menu-item span span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-git-workbench__context-menu-item strong {
      color: inherit;
    }
    .oc-git-workbench__context-menu-item span span {
      color: var(--text-weak);
      font-size: 11px;
    }
    .oc-git-workbench__empty {
      min-height: 180px;
      display: grid;
      place-items: center;
      align-content: center;
      gap: 8px;
      color: var(--text-weak);
      text-align: center;
      padding: 20px;
    }
    .oc-git-workbench__empty strong {
      color: var(--text-strong);
      font-size: 13px;
    }
    .oc-git-workbench__empty-image {
      width: min(190px, 75%);
      max-height: 96px;
      object-fit: contain;
      opacity: .88;
    }
    .oc-git-workbench__modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(0, 0, 0, .45);
    }
    .oc-git-workbench__modal {
      width: min(520px, 100%);
      display: grid;
      gap: 10px;
      border: 1px solid var(--border-strong, var(--border-weak-base));
      border-radius: 10px;
      background: var(--background-stronger);
      box-shadow: 0 24px 70px rgba(0, 0, 0, .35);
      padding: 16px;
    }
    .oc-git-workbench__modal h3,
    .oc-git-workbench__modal p {
      margin: 0;
    }
    .oc-git-workbench__field {
      display: grid;
      gap: 6px;
      color: var(--text-strong);
    }
    .oc-git-workbench__textarea {
      width: 100%;
      resize: vertical;
      min-height: 88px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-base);
      color: var(--text-base);
      padding: 8px;
      font: inherit;
    }
    .oc-git-workbench__textarea:focus {
      outline: 2px solid rgba(34, 211, 238, .35);
      outline-offset: 1px;
    }
    .oc-git-workbench__textarea--single-line {
      min-height: 38px;
      resize: none;
    }
    .oc-git-workbench__option-descriptions {
      display: grid;
      gap: 6px;
      max-height: 160px;
      overflow: auto;
    }
    .oc-git-workbench__option-description {
      display: grid;
      gap: 2px;
      padding: 6px 8px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-base);
      font-size: 11px;
    }
    .oc-git-workbench__option-description code {
      color: var(--text-muted);
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .oc-git-workbench__modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
    }
    @media (max-width: 760px) {
      .oc-git-workbench__worktree,
      .oc-git-workbench__history {
        grid-template-columns: 1fr;
      }
      .oc-git-workbench__details {
        position: static;
      }
      .oc-git-workbench__title-row,
      .oc-git-workbench__file-row,
      .oc-git-workbench__branch-row,
      .oc-git-workbench__stash-row {
        align-items: stretch;
      }
      .oc-git-workbench__title-row {
        flex-wrap: wrap;
      }
      .oc-git-workbench__project-picker {
        max-width: none;
        flex: 1 1 160px;
      }
      .oc-git-workbench__row-actions {
        justify-content: flex-end;
      }
      .oc-git-workbench__file-row {
        grid-template-columns: 22px 18px minmax(0, 1fr);
      }
      .oc-git-workbench__file-row .oc-git-workbench__row-actions {
        grid-column: 1 / -1;
      }
    }
  `
  return style
}
