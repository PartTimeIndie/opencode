const DEFAULT_PREVIEW_LIMIT = 4
const FETCH_PAGE_LIMIT = 50
const MORE_STEP = 5
const SEARCH_DELAY = 120
const SEARCH_LOADING_DELAY = 500
const SEARCH_CONTENT_CONCURRENCY = 6
const PREVIEW_LIMIT_STORAGE_KEY = "opencode.settings.sidebarSessionLimit"
const PREVIEW_LIMIT_EVENT = "opencode:sidebar-session-limit"
const FAVORITES_STORAGE_KEY = "favorites.v1"
const AUTO_OPEN_STORAGE_KEY = "opencode.app-plugin.session-navigator-app.auto-opened.v1"
const SHOW_SUBAGENTS_STORAGE_KEY = "show-subagents.v1"
const SHOW_SUBAGENTS_LOCAL_STORAGE_KEY = "opencode.app-plugin.session-navigator-app.show-subagents.v1"
const HIDDEN_PROJECTS_STORAGE_KEY = "hidden-projects.v1"
const MOBILE_DOCK_MEDIA_QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 600px)"
const navigatorStatesByHost = new WeakMap()

export default {
  id: "session-navigator-app",
  app(api) {
    const previous = api.dock.state.item("sessionNavigator")
    api.dock.register({
      id: "sessionNavigator",
      title: "Session Navigator",
      icon: "session-navigator",
      defaultArea: "left",
      minWidth: 220,
      preferredWidth: 300,
      mount(context) {
        return mountNavigator(api, context)
      },
    })
    if (localStorage.getItem(AUTO_OPEN_STORAGE_KEY) !== "true") {
      api.dock.open.item("sessionNavigator", { area: previous.area ?? "left", reveal: false })
      localStorage.setItem(AUTO_OPEN_STORAGE_KEY, "true")
    }
  },
}

function mountNavigator(api, context) {
  const state = restoreNavigatorState(api, context)
  syncActiveSessions(api, state)
  const mobile = window.matchMedia(MOBILE_DOCK_MEDIA_QUERY)

  const root = document.createElement("section")
  root.className = "oc-session-nav"
  root.dataset.preventAutofocus = ""
  root.append(styleNode())
  state.root = root
  context.element.replaceChildren(root)

  const unsubscribeProjects = api.host.projects.subscribe((projects) => {
    state.projects = groupNavigatorProjects(projects)
    const keys = new Set(state.projects.map(projectGroupKey))
    for (const key of state.groups.keys()) if (!keys.has(key)) state.groups.delete(key)
    for (const project of state.projects) {
      const group = ensureProjectGroup(state, project)
      if (group.expanded && group.reloadPreview && !group.loading) {
        group.reloadPreview = false
        void loadGroup(api, group, state, group.loadedAll ? "all" : group.sessions.length || undefined)
      }
    }
    render()
  })
  const unsubscribeFavorites = subscribeFavorites(api, state)
  const unsubscribeSessionStatus = subscribeSessionStatus(api, state)
  const unsubscribeAttention = api.host.sessions.attention?.subscribe?.(() => updateVisibleSessionRows(api, state)) ?? (() => {})
  const closeContextMenu = () => {
    if (!state.contextMenu) return
    state.contextMenu = undefined
    scheduleRender()
  }
  const closeContextMenuOnEscape = (event) => {
    if (event.key !== "Escape") return
    closeContextMenu()
  }
  const trackSearchFocusPointer = (event) => {
    if (!state.query.trim()) return
    state.searchFocused = root.contains(event.target)
  }
  const releaseSessionActivation = (event) => {
    const pending = state.pendingSessionActivation
    if (!pending || pending.pointerID !== event.pointerId) return
    state.pendingSessionActivation = undefined
    // A status reorder replaces the pressed row before the browser can emit its click.
    // Preserve only that interrupted activation; normal releases outside a connected
    // button must keep the browser's usual cancellation behavior.
    if (pending.target.isConnected) return
    if (Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) > 8) return
    if (pending.favorite) toggleFavorite(pending.api, state, pending.session, pending.directory)
    if (!pending.favorite) openSession(pending.api, state, pending.session, pending.directory)
    state.suppressedSessionActivation = pending
    setTimeout(() => {
      if (state.suppressedSessionActivation === pending) state.suppressedSessionActivation = undefined
    })
  }
  const cancelSessionActivation = (event) => {
    if (state.pendingSessionActivation?.pointerID === event.pointerId) state.pendingSessionActivation = undefined
  }
  const suppressReorderedSessionClick = (event) => {
    if (!state.suppressedSessionActivation) return
    const selector = state.suppressedSessionActivation.favorite
      ? ".oc-session-nav__favorite"
      : ".oc-session-nav__session-main"
    if (!(event.target instanceof Element) || !event.target.closest(selector)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    state.suppressedSessionActivation = undefined
  }

  const abort = () => {
    closeSessionRenameDialog(state)
    unsubscribeProjects()
    unsubscribeFavorites()
    unsubscribeSessionStatus()
    unsubscribeAttention()
    unsubscribeSessionEvents()
    state.render = undefined
    state.root = undefined
    document.removeEventListener("pointerdown", closeContextMenu)
    document.removeEventListener("pointerdown", trackSearchFocusPointer, true)
    window.removeEventListener("keydown", closeContextMenuOnEscape)
    window.removeEventListener(PREVIEW_LIMIT_EVENT, reloadPreviewGroups)
    mobile.removeEventListener("change", scheduleRender)
    root.removeEventListener("pointerup", releaseSessionActivation)
    root.removeEventListener("pointercancel", cancelSessionActivation)
    root.removeEventListener("click", suppressReorderedSessionClick, true)
    context.element.replaceChildren()
  }
  context.signal.addEventListener("abort", abort, { once: true })
  document.addEventListener("pointerdown", closeContextMenu)
  document.addEventListener("pointerdown", trackSearchFocusPointer, true)
  window.addEventListener("keydown", closeContextMenuOnEscape)
  window.addEventListener(PREVIEW_LIMIT_EVENT, reloadPreviewGroups)
  mobile.addEventListener("change", scheduleRender)
  root.addEventListener("pointerup", releaseSessionActivation)
  root.addEventListener("pointercancel", cancelSessionActivation)
  root.addEventListener("click", suppressReorderedSessionClick, true)
  const unsubscribeSessionEvents = subscribeSessionEvents(api, state)

  void refreshLoadedNavigatorGroups(api, state)
  render()

  function reloadPreviewGroups() {
    for (const group of [state.recent, ...state.groups.values()]) {
      if (group.loading) {
        group.reloadPreview = true
        continue
      }
      if (!group.loaded || group.loadedAll) continue
      void loadGroup(api, group, state)
    }
    render()
  }

  function scheduleRender() {
    if (state.renderQueued) return
    state.renderQueued = true
    queueMicrotask(() => {
      state.renderQueued = false
      render()
    })
  }

  state.render = scheduleRender
  if (!state.showSubagents) void refreshFavoriteParents(api, state)

  function render() {
    const shell = document.createElement("div")
    shell.className = "oc-session-nav__shell"

    const searchRow = document.createElement("div")
    searchRow.className = "oc-session-nav__search-row"
    const search = document.createElement("label")
    search.className = "oc-session-nav__search"
    const searchIcon = document.createElement("span")
    searchIcon.textContent = "Search"
    searchIcon.className = "oc-session-nav__search-icon"
    const input = document.createElement("input")
    input.type = "search"
    input.placeholder = "Search sessions"
    input.value = state.query
    input.addEventListener("focus", () => {
      state.searchFocused = true
    })
    input.addEventListener("blur", (event) => {
      if (root.contains(event.relatedTarget)) return
      if (state.query.trim() && event.relatedTarget === null) return
      state.searchFocused = false
    })
    input.addEventListener("input", () => {
      state.query = input.value
      state.searchFocused = true
      startSearch(api, state)
    })
    search.append(searchIcon, input)
    if (state.search.showLoading && state.query.trim()) {
      const status = document.createElement("span")
      status.className = "oc-session-nav__search-status"
      status.title = "Searching session contents"
      status.setAttribute("aria-label", "Searching session contents")
      status.append(spinner())
      search.append(status)
    }
    const addProject = document.createElement("button")
    addProject.type = "button"
    addProject.className = "oc-session-nav__project-open"
    addProject.textContent = "+"
    addProject.title = "Add project"
    addProject.setAttribute("aria-label", "Add project")
    addProject.addEventListener("click", () => navigatorApi(api, state)?.host.projects.open?.())
    searchRow.append(search, addProject)
    shell.append(searchRow)

    const subagentFilter = document.createElement("label")
    subagentFilter.className = "oc-session-nav__filter"
    const showSubagents = document.createElement("input")
    showSubagents.type = "checkbox"
    showSubagents.checked = state.showSubagents
    showSubagents.addEventListener("change", () => setShowSubagents(api, state, showSubagents.checked))
    const showSubagentsText = document.createElement("span")
    showSubagentsText.textContent = "Show subagents"
    subagentFilter.append(showSubagents, showSubagentsText)
    shell.append(subagentFilter)

    const body = document.createElement("div")
    body.className = "oc-session-nav__body"
    const manage = actionButton("Manage hidden projects")
    manage.setAttribute("aria-pressed", String(state.manageHiddenProjects))
    manage.dataset.visibilityControl = "manage"
    manage.addEventListener("click", () => {
      state.manageHiddenProjects = !state.manageHiddenProjects
      state.contextMenu = undefined
      renderLater(state)
    })
    shell.append(manage)
    if (state.manageHiddenProjects) renderProjectVisibility(api, state, body)
    else if (state.query.trim()) renderSearch(api, state, body)
    else {
      state.favorites.sessions = favoriteSessions(state)
      state.favorites.loaded = true
      state.favorites.loadedAll = true
      state.favorites.hasMore = false
      const primaryGroups = mobile.matches ? [state.recent, state.favorites] : [state.favorites, state.recent]
      for (const group of primaryGroups) renderGroup(api, state, body, renderInputForGroup(state, group))
      for (const [index, project] of state.projects.entries()) {
        if (state.hiddenProjects.has(projectGroupKey(project))) continue
        renderProject(api, state, body, project, index)
      }
    }
    if (state.contextMenu) shell.append(sessionContextMenu(api, state))
    shell.append(body)

    const scrollTop = navigatorScrollTop(state)
    const previousInput = root.querySelector("input")
    const focused = previousInput === document.activeElement || (state.searchFocused && state.query.trim())
    const selectionStart = previousInput?.selectionStart ?? input.value.length
    const selectionEnd = previousInput?.selectionEnd ?? selectionStart
    const visibilityFocus = root.contains(document.activeElement) ? document.activeElement?.dataset.visibilityControl : undefined
    root.replaceChildren(root.querySelector("style") || styleNode(), shell)
    restoreNavigatorScroll(state, scrollTop)
    if (visibilityFocus) {
      const control = [...root.querySelectorAll("[data-visibility-control]")].find(
        (button) => button.dataset.visibilityControl === visibilityFocus,
      ) ?? manage
      control.focus({ preventScroll: true })
    } else if (focused && !state.manageHiddenProjects) {
      const next = root.querySelector("input")
      next?.focus({ preventScroll: true })
      next?.setSelectionRange(selectionStart, selectionEnd)
    }
  }

  return abort
}

export function restoreNavigatorState(api, context) {
  const host = navigatorHost(api)
  const existing = navigatorStatesByHost.get(host)
  if (existing) {
    existing.api = api
    existing.projects = groupNavigatorProjects(api.host.projects.list())
    existing.favorites ??= createGroup(undefined, true)
    existing.favorites.key ??= "favorites"
    existing.active ??= createGroup(undefined, true, "active")
    existing.active.loaded = true
    existing.active.loadedAll = true
    existing.active.hasMore = false
    existing.favoriteItems ??= readFavorites(api)
    existing.activeSortTimes ??= {}
    existing.activeSortSequence ??= Date.now()
    existing.search ??= createSearchState()
    existing.search.sequence ??= 0
    existing.search.showLoading ??= false
    existing.search.duration ??= 0
    existing.searchContent ??= {}
    existing.missingSessions ??= new Set()
    existing.missingFavorites ??= new Set()
    existing.showSubagents ??= readShowSubagents(api)
    existing.hiddenProjects = readHiddenProjects(api)
    existing.manageHiddenProjects = false
    existing.recent.key ??= "recent"
    for (const group of existing.groups.values()) group.key ??= `project:${group.directory}`
    existing.dockArea = context.area
    existing.renderQueued = false
    existing.pendingSessionActivation = undefined
    existing.suppressedSessionActivation = undefined
    return existing
  }
  const state = {
    api,
    host,
    query: "",
    projects: groupNavigatorProjects(api.host.projects.list()),
    groups: new Map(),
    active: createGroup(undefined, true, "active"),
    favorites: createGroup(undefined, true, "favorites"),
    favoriteItems: readFavorites(api),
    activeSortTimes: {},
    activeSortSequence: Date.now(),
    recent: createGroup(undefined, true, "recent"),
    search: createSearchState(),
    searchContent: {},
    missingSessions: new Set(),
    missingFavorites: new Set(),
    showSubagents: readShowSubagents(api),
    hiddenProjects: readHiddenProjects(api),
    manageHiddenProjects: false,
    confirmDelete: undefined,
    contextMenu: undefined,
    pendingSessionActivation: undefined,
    suppressedSessionActivation: undefined,
    dockArea: context.area,
    renderQueued: false,
  }
  navigatorStatesByHost.set(host, state)
  state.active.loaded = true
  state.active.loadedAll = true
  return state
}

function navigatorHost(api) {
  return api.host ?? api
}

function navigatorApi(api, state) {
  if (state.host !== navigatorHost(api)) return undefined
  return state.api
}

function readHiddenProjects(api) {
  try {
    const paths = api.kv?.get?.(HIDDEN_PROJECTS_STORAGE_KEY)
    return new Set(Array.isArray(paths) ? paths.filter((path) => typeof path === "string" && path) : [])
  } catch {
    return new Set()
  }
}

function readShowSubagents(api) {
  const stored = api.kv?.get?.(SHOW_SUBAGENTS_STORAGE_KEY)
  if (typeof stored === "boolean") return stored
  try {
    const local = localStorage.getItem(SHOW_SUBAGENTS_LOCAL_STORAGE_KEY)
    if (local !== null) return local !== "false"
  } catch {}
  return true
}

function saveShowSubagents(api, showSubagents) {
  if (api.kv?.set) {
    api.kv.set(SHOW_SUBAGENTS_STORAGE_KEY, showSubagents)
    return
  }
  try {
    localStorage.setItem(SHOW_SUBAGENTS_LOCAL_STORAGE_KEY, String(showSubagents))
  } catch {}
}

function setShowSubagents(api, state, showSubagents) {
  if (state.showSubagents === showSubagents) return
  state.showSubagents = showSubagents
  saveShowSubagents(api, showSubagents)
  if (!showSubagents) void refreshFavoriteParents(api, state)
  reloadGroupsForSubagentFilter(api, state)
  if (state.query.trim()) {
    startSearch(api, state)
    return
  }
  renderLater(state)
}

function reloadGroupsForSubagentFilter(api, state) {
  for (const group of [state.recent, ...state.groups.values()]) {
    if (group.loading) {
      group.reloadPreview = true
      continue
    }
    if (!group.loaded) continue
    const target = group.loadedAll ? "all" : group.sessions.length > previewLimit() ? group.sessions.length : undefined
    void loadGroup(api, group, state, target)
  }
}

function sessionVisible(state, session) {
  if (state.missingSessions?.has(sessionKey(session, session.directory))) return false
  return state.showSubagents || !sessionParentID(state, session)
}

function visibleSessions(state, sessions) {
  return subagentFilteredSessions(state, sessions).filter((session) => {
    if (!session.directory || !state.hiddenProjects?.size) return true
    const project = projectForDirectory(state, session.directory)
    return !state.hiddenProjects.has(projectWorktreeKey(project?.worktree ?? session.directory))
  })
}

function subagentFilteredSessions(state, sessions) {
  return state.showSubagents ? sessions : sessions.filter((session) => sessionVisible(state, session))
}

function sessionParentID(state, session) {
  if (session.parentID) return session.parentID
  const favorite = Object.values(state.favoriteItems ?? {}).find(
    (item) => item.id === session.id && (!session.directory || item.directory === session.directory),
  )
  if (favorite?.parentID) return favorite.parentID
  for (const group of [...(state.active ? [state.active] : []), state.recent, ...state.groups.values(), state.search]) {
    const match = (group.sessions ?? []).find(
      (item) => item.id === session.id && (!session.directory || (item.directory || group.directory) === session.directory),
    )
    if (match?.parentID) return match.parentID
  }
}

function createGroup(directory, expanded, key) {
  return {
    key: key ?? `project:${directory}`,
    directory,
    expanded,
    loading: false,
    reloadPreview: false,
    loaded: false,
    loadedAll: false,
    hasMore: false,
    sessions: [],
  }
}

function createSearchState(sequence = 0) {
  return {
    sequence,
    loading: false,
    showLoading: false,
    sessions: [],
    duration: 0,
  }
}

function projectGroupKey(project) {
  return projectWorktreeKey(project.worktree)
}

export function groupNavigatorProjects(projects) {
  const grouped = new Map()
  for (const project of projects) {
    const key = projectGroupKey(project)
    const previous = grouped.get(key)
    const directories = [...new Set([
      ...(previous?.sessionDirectories ?? []), project.worktree, ...(project.sessionDirectories ?? []),
    ])]
    grouped.set(key, { ...(previous ?? project), sessionDirectories: directories })
  }
  // Canonical worktrees own their paths; an alias claimed by multiple worktrees belongs to neither.
  const owners = new Map()
  for (const [key, project] of grouped) {
    for (const directory of project.sessionDirectories) {
      const alias = projectWorktreeKey(directory)
      const owner = owners.get(alias)
      owners.set(alias, grouped.has(alias) ? alias : owner === undefined || owner === key ? key : null)
    }
  }
  return [...grouped].map(([key, project]) => ({
    ...project,
    sessionDirectories: project.sessionDirectories.filter((directory) => owners.get(projectWorktreeKey(directory)) === key),
  }))
}

function ensureProjectGroup(state, project) {
  const key = projectGroupKey(project)
  const current = state.groups.get(key)
  const group = current ?? createGroup(project.worktree, false, `project:${key}`)
  const known = project.sessionDirectories ?? [project.worktree]
  const keys = new Set(known.map(projectWorktreeKey))
  const eventDirectories = [...(group.eventDirectories ?? [])].filter((directory) => keys.has(projectWorktreeKey(directory)))
  const directories = [...new Set([...known, ...eventDirectories])]
  group.eventDirectories = new Set(eventDirectories)
  if (current && (group.directories?.length !== directories.length || directories.some((dir) => !group.directories?.includes(dir)))) {
    if (group.loading || group.expanded) group.reloadPreview = true
    else group.loaded = false
  }
  group.directory = project.worktree
  group.directories = directories
  group.sessions = group.sessions.filter((session) => groupOwnsDirectory(group, session.directory))
  state.groups.set(key, group)
  return group
}

function groupOwnsDirectory(group, directory) {
  if (!directory) return false
  const key = projectWorktreeKey(directory)
  return (group.directories ?? [group.directory]).some((candidate) => candidate && projectWorktreeKey(candidate) === key)
}

export async function refreshLoadedNavigatorGroups(api, state) {
  const loaded = [state.recent, ...[...state.groups.values()].filter((group) => group.loaded)]
  await Promise.all(
    loaded.map((group) => {
      if (group.loading) {
        group.reloadPreview = true
        return
      }
      const target = group.sessions.length > previewLimit() ? (group.loadedAll ? "all" : group.sessions.length) : undefined
      return loadGroup(api, group, state, target)
    }),
  )
}

async function loadGroup(api, group, state, target) {
  if (group.loading) return
  const accepts = (session) => group === state.recent || groupOwnsDirectory(group, session.directory)
  const pinned = group.sessions.filter(
    (session) => accepts(session) && sessionVisible(state, session) && sessionActiveRank(api, state, session, group.directory) < 2,
  )
  const showSubagents = state.showSubagents
  group.loading = true
  renderGroupLater(api, state, group)
  try {
    const limit = previewLimit()
    const wantAll = target === "all"
    const want = wantAll
      ? Number.POSITIVE_INFINITY
      : typeof target === "number"
        ? target
        : target === "more"
          ? group.sessions.length + MORE_STEP
          : limit
    const sessions = []
    const directories = group.directories ?? [group.directory]
    const pages = await Promise.all(directories.map((directory) => loadNavigatorDirectory(api, state, directory, want, accepts)))
    for (const page of pages) mergeRecentSessions(sessions, page.filter(accepts))
    mergeRecentSessions(sessions, pinned.filter(accepts))
    if (group === state.recent) {
      mergeRecentSessions(sessions, state.active?.sessions ?? [])
    }
    sessions.sort(compareSessions(api, state, group.directory))
    const visible = Math.max(want, pinned.length)
    // Hide only in the view so showing a project again restores cached rows.
    const displayable = subagentFilteredSessions(state, sessions)
    group.sessions = wantAll ? displayable : displayable.slice(0, visible)
    group.hasMore = wantAll ? false : displayable.length > visible
    group.loaded = true
    group.loadedAll = wantAll || !group.hasMore
  } finally {
    group.loading = false
    const reload = group.reloadPreview || state.showSubagents !== showSubagents
    const reloadTarget = target === "all" ? "all" : typeof target === "number" ? target : undefined
    group.reloadPreview = false
    renderGroupLater(api, state, group)
    if (reload) void loadGroup(api, group, state, reloadTarget)
  }
}

export async function loadNavigatorDirectory(api, state, directory, want, accepts = () => true) {
  const result = []
  const cursors = new Set()
  let cursor
  while (result.length <= want) {
    const limit = Math.min(FETCH_PAGE_LIMIT, want + 1 - result.length)
    const page = await listSessionPage(api, { directory, limit, cursor }, state)
    mergeRecentSessions(result, page.sessions.filter(accepts))
    if (!page.cursor || cursors.has(page.cursor)) break
    cursors.add(page.cursor)
    cursor = page.cursor
  }
  return result
}

function previewLimit() {
  try {
    const stored = localStorage.getItem(PREVIEW_LIMIT_STORAGE_KEY)
    if (stored !== null) return normalizePreviewLimit(JSON.parse(stored))
    const raw = localStorage.getItem("settings.v3")
    return normalizePreviewLimit(raw ? JSON.parse(raw)?.general?.sidebarSessionLimit : DEFAULT_PREVIEW_LIMIT)
  } catch {
    return DEFAULT_PREVIEW_LIMIT
  }
}

function normalizePreviewLimit(value) {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number)) return DEFAULT_PREVIEW_LIMIT
  return Math.min(50, Math.max(1, Math.round(number)))
}

function collapseGroup(group, state) {
  group.sessions = group.sessions.slice(0, previewLimit())
  group.hasMore = true
  group.loadedAll = false
  renderLater(state)
}

let searchTimer
let searchLoadingTimer
function startSearch(api, state) {
  clearTimeout(searchTimer)
  clearTimeout(searchLoadingTimer)
  const query = state.query.trim()
  if (!query) {
    state.search = createSearchState(state.search.sequence + 1)
    renderLater(state)
    return
  }
  const sequence = state.search.sequence + 1
  state.search = {
    ...createSearchState(sequence),
    sessions: rankedSearchSessions(state, query, searchCandidates(state)),
  }
  renderLater(state)
  searchTimer = setTimeout(() => loadSearch(api, state, query, sequence), SEARCH_DELAY)
}

async function loadSearch(api, state, query, sequence) {
  const started = performance.now()
  state.search.loading = true
  state.search.showLoading = false
  searchLoadingTimer = setTimeout(() => {
    if (state.search.sequence !== sequence || !state.search.loading) return
    state.search.showLoading = true
    renderLater(state)
  }, SEARCH_LOADING_DELAY)
  try {
    const sessions = searchCandidates(state)
    mergeSearchServerRows(sessions, await listSessions(api, { search: query, limit: 100 }, state))
    if (!searchCurrent(state, query, sequence)) return
    state.search.sessions = rankedSearchSessions(state, query, sessions)
    renderLater(state)
    await searchSessionContents(api, state, query, sequence, sessions, sessions)

    let cursor
    let guard = 0
    while (searchCurrent(state, query, sequence)) {
      const page = await listSessions(api, { limit: FETCH_PAGE_LIMIT, cursor }, state)
      if (!searchCurrent(state, query, sequence)) return
      mergeSearchServerRows(sessions, page)
      state.search.sessions = rankedSearchSessions(state, query, sessions)
      renderLater(state)
      await searchSessionContents(api, state, query, sequence, sessions, page)
      const last = page.at(-1)
      if (!last || page.length < FETCH_PAGE_LIMIT) break
      cursor = sessionUpdated(last)
      guard++
      if (guard > 100) break
    }
  } finally {
    clearTimeout(searchLoadingTimer)
    if (state.search.sequence === sequence) {
      state.search.loading = false
      state.search.showLoading = false
      state.search.duration = performance.now() - started
      renderLater(state)
    }
  }
}

async function listSessions(api, input, state) {
  return (await listSessionPage(api, input, state)).sessions
}

async function listSessionPage(api, input, state) {
  const response = await api.client.experimental.session.list({
    roots: state?.showSubagents === false ? true : undefined,
    archived: false,
    directory: input.directory,
    cursor: input.cursor,
    search: input.search,
    limit: input.limit,
  })
  const data = response?.data ?? response
  if (!Array.isArray(data)) return { sessions: [] }
  return {
    sessions: data.filter((session) => !state?.missingSessions?.has(sessionKey(session, session.directory || input.directory))),
    cursor: response?.response?.headers?.get("x-next-cursor") || undefined,
  }
}

function mergeSessions(target, next, fallbackDirectory) {
  const seen = new Set(target.map((session) => sessionKey(session, session.directory || fallbackDirectory)))
  for (const session of next) {
    const key = session?.id && sessionKey(session, session.directory || fallbackDirectory)
    if (!key || seen.has(key)) continue
    target.push(session)
    seen.add(key)
  }
}

function mergeRecentSessions(target, next) {
  // Host projections can repeat a durable Recent row with a missing or
  // aliased directory, which sessionKey would treat as a second session.
  // Session ids are unique within one host state, so an already-present row
  // stays authoritative (durable title, directory, and project badge) and
  // only unknown sessions join Recent.
  const known = new Set(target.map((session) => session.id))
  for (const session of next) {
    if (!session?.id || known.has(session.id)) continue
    target.push(session)
    known.add(session.id)
  }
}

function mergeSearchServerRows(target, next) {
  // Server rows are durable and authoritative: every candidate row sharing a
  // host session id with a server row is removed — favorite, project, and
  // active copies included — and only ids unknown to the server rows survive
  // from the candidates.
  const incoming = next.filter((session) => session?.id)
  if (incoming.length === 0) return
  const serverIDs = new Set(incoming.map((session) => session.id))
  let write = 0
  for (const session of target) {
    if (session?.id && serverIDs.has(session.id)) continue
    target[write++] = session
  }
  target.length = write
  const seen = new Set()
  for (const session of incoming) {
    if (seen.has(session.id)) continue
    seen.add(session.id)
    target.push(session)
  }
}

function searchCurrent(state, query, sequence) {
  return state.search.sequence === sequence && state.query.trim() === query
}

function searchCandidates(state) {
  const sessions = []
  // One host-scoped id canonicalization across all candidate sources: recent,
  // project, and favorite rows precede host active projections, and the first
  // durable row for a session id wins — path-keyed merging would otherwise
  // count missing or aliased directory copies as second candidates with
  // stale metadata.
  const known = new Set()
  const addCandidates = (rows) => {
    for (const session of subagentFilteredSessions(state, rows)) {
      if (!session?.id || known.has(session.id)) continue
      sessions.push(session)
      known.add(session.id)
    }
  }
  addCandidates(state.recent.sessions)
  for (const group of state.groups.values()) addCandidates(group.sessions)
  addCandidates(state.favorites.sessions)
  addCandidates(state.active?.sessions ?? [])
  return sessions
}

async function searchSessionContents(api, state, query, sequence, allSessions, pendingSessions) {
  if (!hostHttpAvailable(api)) return
  const pending = pendingSessions.filter((session) => {
    if (!session?.id || !session.directory) return false
    return state.searchContent[searchContentKey(session)] === undefined
  })
  for (
    let index = 0;
    index < pending.length && searchCurrent(state, query, sequence);
    index += SEARCH_CONTENT_CONCURRENCY
  ) {
    await Promise.allSettled(
      pending
        .slice(index, index + SEARCH_CONTENT_CONCURRENCY)
        .map((session) => loadSessionContent(api, state, session)),
    )
    if (!searchCurrent(state, query, sequence)) return
    state.search.sessions = rankedSearchSessions(state, query, allSessions)
    renderLater(state)
  }
}

async function loadSessionContent(api, state, session) {
  const key = searchContentKey(session)
  if (state.searchContent[key] !== undefined) return state.searchContent[key]
  const response = await api.host.http.request({
    path: `/session/${encodeURIComponent(session.id)}/message`,
    query: { directory: session.directory },
  })
  const text = response.ok ? searchText(response.body).toLowerCase() : ""
  state.searchContent[key] = text
  return text
}

function rankedSearchSessions(state, query, sessions) {
  return sessions
    .filter((session) => sessionVisible(state, session))
    .map((session) => ({ session, rank: searchRank(state, query, session) }))
    .filter((item) => item.rank)
    .sort((a, b) => compareSearchRanks(a, b))
    .map((item) => item.session)
}

function searchRank(state, query, session) {
  const title = matchText(sessionTitleText(session), query)
  if (title.full) return { bucket: 0, count: title.count, updated: sessionUpdated(session), id: session.id }
  const content = matchText(state.searchContent[searchContentKey(session)] ?? "", query)
  if (content.full) return { bucket: 1, count: content.count, updated: sessionUpdated(session), id: session.id }
  if (title.count) return { bucket: 2, count: title.count, updated: sessionUpdated(session), id: session.id }
  if (content.count) return { bucket: 3, count: content.count, updated: sessionUpdated(session), id: session.id }
}

function compareSearchRanks(a, b) {
  const bucket = a.rank.bucket - b.rank.bucket
  if (bucket) return bucket
  const matches = b.rank.count - a.rank.count
  if (matches) return matches
  const updated = b.rank.updated - a.rank.updated
  if (updated) return updated
  return String(a.rank.id).localeCompare(String(b.rank.id))
}

function matchText(text, query) {
  const full = normalizeSearchText(query)
  const terms = full.split(/\s+/).filter(Boolean)
  const value = normalizeSearchText(text)
  if (!value || terms.length === 0) return { full: false, count: 0 }
  if (value.includes(full)) return { full: true, count: terms.length }
  return { full: false, count: terms.filter((term) => value.includes(term)).length }
}

function sessionTitleText(session) {
  return `${session.title || ""} ${session.slug || ""}`
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
}

function searchContentKey(session) {
  return `${session.directory || ""}:${session.id}:${sessionUpdated(session)}`
}

function searchText(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(searchText).join("\n")
  if (typeof value !== "object") return ""
  return ["text", "content", "output", "summary", "title", "name", "filename", "parts"]
    .map((key) => searchText(value[key]))
    .join("\n")
}

function readFavorites(api) {
  const hostFavorites = api.host?.sessions?.favorites?.list?.()
  if (Array.isArray(hostFavorites)) return favoriteItemsFromList(hostFavorites)
  const stored = api.kv?.get?.(FAVORITES_STORAGE_KEY, {})
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
  // Older builds persisted entries under a directory:id key; the session id is the key now.
  return favoriteItemsFromList(Object.values(stored))
}

function favoriteItemsFromList(items) {
  const favorites = {}
  // One session can be stored under two directories, for example after a repository
  // move. The host lists the newest entry first; that row wins and its twin is dropped.
  for (const item of items) {
    if (!item?.id || !item?.directory || favorites[item.id]) continue
    favorites[item.id] = {
      id: item.id,
      parentID: typeof item.parentID === "string" || item.parentID === null ? item.parentID : undefined,
      title: item.title,
      slug: item.slug,
      directory: item.directory,
      time: item.time,
    }
  }
  return favorites
}

function saveFavorites(api, state) {
  if (api.host?.sessions?.favorites) return
  api.kv?.set?.(FAVORITES_STORAGE_KEY, state.favoriteItems)
}

function favoriteSessions(state) {
  return Object.values(state.favoriteItems)
    .filter((session) => sessionVisible(state, session))
    .sort(compareSessionsByUpdated)
}

export async function refreshFavoriteParents(api, state) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  if (state.refreshingFavoriteParents) return
  const favorites = Object.values(state.favoriteItems).filter(
    (session) => session.id && session.directory && session.parentID === undefined,
  )
  if (favorites.length === 0) return
  state.refreshingFavoriteParents = true
  try {
    const results = await Promise.allSettled(
      favorites.map(async (favorite) => {
        const result = await probeSession(serverApi, { directory: favorite.directory, sessionID: favorite.id })
        if (!result.exists) return { favorite, missing: true }
        return { favorite, parentID: result.session.parentID ?? null }
      }),
    )
    const updates = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    if (updates.length === 0) return
    for (const update of updates) {
      const current = state.favoriteItems[update.favorite.id]
      if (!current) continue
      if (update.missing) {
        // A favorite whose session is gone stays listed until the user removes it.
        state.missingFavorites ??= new Set()
        state.missingFavorites.add(update.favorite.id)
        continue
      }
      state.missingFavorites?.delete(update.favorite.id)
      const favorite = { ...current, parentID: update.parentID }
      state.favoriteItems[update.favorite.id] = favorite
      serverApi.host?.sessions?.favorites?.set?.(favorite, true)
    }
    saveFavorites(serverApi, state)
    renderLater(state)
  } finally {
    state.refreshingFavoriteParents = false
  }
}

function subscribeSessionStatus(api, state) {
  const sessions = api.host?.sessions
  if (!sessions?.subscribe) return () => {}
  return sessions.subscribe(() => {
    const hadActiveSessions = state.active.sessions.length > 0
    const groups = [state.active, state.favorites, state.recent, ...state.groups.values()]
    const previousOrder = groupOrderSnapshot(groups)
    syncActiveSessions(api, state)
    if (hadActiveSessions !== (state.active.sessions.length > 0)) {
      renderLater(state)
      return
    }
    resortGroups(api, state)
    if (groupOrderChanged(groups, previousOrder)) {
      updateVisibleGroupSections(api, state, groups)
      return
    }
    updateVisibleSessionRows(api, state)
  })
}

export function syncActiveSessions(api, state) {
  const previous = new Set(state.active.sessions.map((session) => sessionKey(session, session.directory)))
  const active = []
  mergeSessions(active, api.host?.sessions?.active?.() ?? [])
  for (const session of active) {
    const key = sessionKey(session, session.directory)
    if (previous.has(key)) continue
    state.activeSortSequence = Math.max(state.activeSortSequence ?? Date.now(), Date.now(), sessionUpdated(session)) + 1
    state.activeSortTimes[key] = state.activeSortSequence
  }
  state.active.sessions = active
  state.active.expanded = true
  state.active.loaded = true
  state.active.loadedAll = true
  state.active.hasMore = false
  mergeRecentSessions(state.recent.sessions, active)
  sortGroup(api, state, state.active)
  sortGroup(api, state, state.recent)
}

function favoriteSession(session, directory) {
  return {
    id: session.id,
    parentID: session.parentID ?? null,
    title: session.title,
    slug: session.slug,
    directory,
    time: session.time,
  }
}

// The host identifies a favorite by session id: set(input, true) adds or updates that
// entry and set(input, false) removes it, whatever directory the input carries.
function isFavorite(state, session) {
  return Boolean(state.favoriteItems[session?.id])
}

function toggleFavorite(api, state, session, directory) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  if (serverApi.host?.sessions?.favorites) {
    serverApi.host.sessions.favorites.set(favoriteSession(session, directory), !isFavorite(state, session))
    state.favoriteItems = readFavorites(serverApi)
  } else {
    if (state.favoriteItems[session.id]) delete state.favoriteItems[session.id]
    else state.favoriteItems[session.id] = favoriteSession(session, directory)
    saveFavorites(serverApi, state)
  }
  // A favorite added again starts visible; the next probe re-marks it if still gone.
  state.missingFavorites?.delete(session.id)
  renderLater(state)
}

function syncFavorite(api, state, session, directory) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi || !state.favoriteItems[session.id]) return
  // A live session event proves the favorite still exists.
  state.missingFavorites?.delete(session.id)
  if (serverApi.host?.sessions?.favorites) {
    serverApi.host.sessions.favorites.set(favoriteSession(session, directory), true)
    state.favoriteItems = readFavorites(serverApi)
    return
  }
  state.favoriteItems[session.id] = favoriteSession(session, directory)
  saveFavorites(serverApi, state)
}

function removeFavorite(api, state, session, directory) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi || !state.favoriteItems[session.id]) return
  if (serverApi.host?.sessions?.favorites) {
    serverApi.host.sessions.favorites.set(favoriteSession(session, directory), false)
    state.favoriteItems = readFavorites(serverApi)
    return
  }
  delete state.favoriteItems[session.id]
  saveFavorites(serverApi, state)
}

function removeFavoriteByID(api, state, id) {
  const serverApi = navigatorApi(api, state)
  if (!id) return
  const favorite = state.favoriteItems[id]
  if (!serverApi || !favorite) return
  if (serverApi.host?.sessions?.favorites) {
    serverApi.host.sessions.favorites.set(favorite, false)
    state.favoriteItems = readFavorites(serverApi)
    return
  }
  delete state.favoriteItems[id]
  saveFavorites(serverApi, state)
}

function subscribeFavorites(api, state) {
  const favorites = api.host?.sessions?.favorites
  if (!favorites?.subscribe) return () => {}
  return favorites.subscribe((items) => {
    state.favoriteItems = favoriteItemsFromList(items)
    // A missing marker never outlives the favorite it describes.
    for (const id of state.missingFavorites ?? []) if (!state.favoriteItems[id]) state.missingFavorites.delete(id)
    renderLater(state)
  })
}

export function subscribeSessionEvents(api, state) {
  if (!api.event?.on) return () => {}
  const off = [
    api.event.on("session.created", (event, context) => upsertSessionFromEvent(api, state, event, context)),
    api.event.on("session.updated", (event, context) => upsertSessionFromEvent(api, state, event, context)),
    api.event.on("session.next.title.updated", (event, context) =>
      updateSessionTitleFromEvent(api, state, event, context),
    ),
    api.event.on("session.deleted", (event, context) => removeSessionFromEvent(api, state, event, context)),
  ]
  return () => off.forEach((dispose) => dispose?.())
}

export function updateSessionTitleFromEvent(api, state, event, context) {
  const properties = event?.properties
  if (!properties?.sessionID || typeof properties.title !== "string") return
  const eventDirectory = directoryIdentity(context?.directory)
  const matchesEvent = (session, fallbackDirectory) =>
    session.id === properties.sessionID &&
    (!eventDirectory || directoryIdentity(session.directory || fallbackDirectory) === eventDirectory)

  const groups = [...(state.active ? [state.active] : []), state.recent, ...state.groups.values()]
  const visibleGroups = [state.favorites, ...groups]
  const previousOrder = groupOrderSnapshot(visibleGroups)
  const previousSearchOrder = sessionOrder(state.search)
  const updated = timestamp(properties.timestamp)
  const matches = []
  groups.forEach((group) => {
    group.sessions = group.sessions.map((session) => {
      if (!matchesEvent(session, group.directory)) return session
      const next = {
        ...session,
        title: properties.title,
        time: updated ? { ...session.time, updated } : session.time,
      }
      matches.push({ session: next, directory: session.directory || group.directory })
      return next
    })
  })

  const searchMatches = []
  const searchSessions = state.search.sessions.map((session) => {
    if (!matchesEvent(session)) return session
    const next = {
      ...session,
      title: properties.title,
      time: updated ? { ...session.time, updated } : session.time,
    }
    searchMatches.push({ session: next, directory: session.directory })
    return next
  })
  const favorite = Object.values(state.favoriteItems || {}).find((session) => session && matchesEvent(session))
  const favoriteMatch = favorite
    ? {
        session: {
          ...favorite,
          title: properties.title,
          time: updated ? { ...favorite.time, updated } : favorite.time,
        },
        directory: favorite.directory,
      }
    : undefined
  const cachedMatches = [...matches, ...searchMatches, ...(favoriteMatch ? [favoriteMatch] : [])]

  if (matches.length === 0) {
    const reload = [
      state.recent,
      ...[...state.groups.values()].filter(
        (group) => eventDirectory && (group.directories ?? [group.directory]).some((dir) => directoryIdentity(dir) === eventDirectory),
      ),
    ]
    reload.forEach((group) => {
      if (group.loading) {
        group.reloadPreview = true
        return
      }
      if (group.loaded) void loadGroup(api, group, state)
    })
    if (cachedMatches.length === 0) return
  }

  state.search.sessions = searchSessions
  const persistedMatch = favoriteMatch || cachedMatches[0]
  syncFavorite(api, state, persistedMatch.session, persistedMatch.directory)
  state.favorites.sessions = favoriteSessions(state)
  resortGroups(api, state)

  const query = String(state.query || "").trim()
  if (query) {
    mergeSessions(
      searchSessions,
      cachedMatches.map((match) => match.session),
    )
    state.search.sessions = rankedSearchSessions(state, query, searchSessions)
  }

  if (query && previousSearchOrder !== sessionOrder(state.search)) {
    renderLater(state)
    return
  }
  if (groupOrderChanged(visibleGroups, previousOrder)) {
    if (!updateVisibleGroupSections(api, state, visibleGroups)) renderLater(state)
    return
  }
  if (!updateVisibleSessionRows(api, state)) renderLater(state)
}

function upsertSessionFromEvent(api, state, event, context) {
  const info = eventSession(event)
  if (!info?.id) return
  const session = { ...info }
  // The SSE scope may be canonicalized; only the payload has the stored path.
  if (
    !session.directory &&
    typeof context?.directory === "string" &&
    directoryIdentity(context.directory) !== "global"
  ) {
    session.directory = context.directory
  }
  if (session.time?.archived) {
    removeFavoriteByID(api, state, session.id)
    removeSessionByID(state, session.id, session.directory)
    if (
      !updateVisibleGroupSections(api, state, [
        ...(state.active ? [state.active] : []),
        state.favorites,
        state.recent,
        ...state.groups.values(),
      ])
    )
      renderLater(state)
    return
  }
  state.missingSessions?.delete(sessionKey(session, session.directory))
  upsertSessionInGroup(api, state, state.recent, session)
  syncFavorite(api, state, session, session.directory)
  const project = projectForDirectory(state, session.directory)
  const group = project ? ensureProjectGroup(state, project) : legacyGroupForDirectory(state, session.directory)
  if (group) {
    const directories = group.directories ?? [group.directory]
    if (session.directory && !directories.includes(session.directory)) {
      group.eventDirectories ??= new Set()
      group.eventDirectories.add(session.directory)
      group.directories = [...directories, session.directory]
    }
    upsertSessionInGroup(api, state, group, session)
  }
  upsertSessionInSearch(api, state, session)
  if (state.query.trim()) {
    renderLater(state)
    return
  }
  if (
    !updateVisibleGroupSections(api, state, [
      ...(state.active ? [state.active] : []),
      state.favorites,
      state.recent,
      ...state.groups.values(),
    ])
  )
    renderLater(state)
}

function removeSessionFromEvent(api, state, event, context) {
  const id = eventSession(event)?.id || event.properties?.sessionID || event.sessionID
  let directory = eventSession(event)?.directory
  if (
    !directory &&
    typeof context?.directory === "string" &&
    directoryIdentity(context.directory) !== "global"
  ) {
    directory = context.directory
  }
  removeFavoriteByID(api, state, id)
  removeSessionByID(state, id, directory)
  if (
    !updateVisibleGroupSections(api, state, [
      ...(state.active ? [state.active] : []),
      state.favorites,
      state.recent,
      ...state.groups.values(),
    ])
  )
    renderLater(state)
}

function eventSession(event) {
  return event?.properties?.info || event?.info
}

function upsertSessionInGroup(api, state, group, session) {
  if (!group.loaded) return
  const directory = session.directory || group.directory
  const identity = directoryIdentity(directory)
  const sameDirectory = (item) => directoryIdentity(item.directory || group.directory) === identity
  if (!sessionVisible(state, session)) {
    group.sessions = group.sessions.filter((item) => item.id !== session.id || !sameDirectory(item))
    return
  }
  const visible = Math.max(previewLimit(), group.sessions.length)
  group.sessions = group.sessions.filter((item) => item.id !== session.id || !sameDirectory(item))
  group.sessions.push(session)
  sortGroup(api, state, group)
  if (group.loadedAll) return
  group.hasMore = group.hasMore || group.sessions.length > visible
  group.sessions = group.sessions.slice(0, visible)
}

function upsertSessionInSearch(api, state, session) {
  const query = state.query.trim().toLowerCase()
  if (!query) return
  state.search.sessions = state.search.sessions.filter((item) => item.id !== session.id)
  if (!sessionVisible(state, session)) return
  if (`${session.title || ""} ${session.slug || ""} ${session.directory || ""}`.toLowerCase().includes(query)) {
    state.search.sessions.push(session)
    state.search.sessions.sort(compareSessions(api, state, undefined))
  }
}

function compareSessionsByUpdated(a, b) {
  const updated = sessionUpdated(b) - sessionUpdated(a)
  if (updated) return updated
  return String(a.id).localeCompare(String(b.id))
}

function resortGroups(api, state) {
  for (const group of [...(state.active ? [state.active] : []), state.recent, ...state.groups.values()])
    sortGroup(api, state, group)
  state.search.sessions.sort(compareSessions(api, state, undefined))
}

function sortGroup(api, state, group) {
  group.sessions.sort(compareSessions(api, state, group.directory))
}

function groupOrderSnapshot(groups) {
  return new Map(groups.map((group) => [group.key, sessionOrder(group)]))
}

function groupOrderChanged(groups, previousOrder) {
  return groups.some((group) => previousOrder.get(group.key) !== sessionOrder(group))
}

function sessionOrder(group) {
  return (group.sessions ?? []).map((session) => sessionKey(session, session.directory || group.directory)).join("\n")
}

function updateVisibleGroupSections(api, state, groups) {
  const root = state.root
  if (!root) return false
  const scrollTop = navigatorScrollTop(state)
  let updated = false
  for (const group of groups) {
    const section = [...root.querySelectorAll("[data-group-key]")].find((node) => node.dataset.groupKey === group.key)
    const input = renderInputForGroup(state, group)
    if (!section || !input) continue
    section.replaceWith(createGroupSection(api, state, input))
    updated = true
  }
  if (!updated) updateVisibleSessionRows(api, state)
  restoreNavigatorScroll(state, scrollTop)
  return updated
}

function navigatorScrollTop(state) {
  return state.root?.querySelector(".oc-session-nav__body")?.scrollTop ?? 0
}

function restoreNavigatorScroll(state, scrollTop) {
  state.root?.querySelector(".oc-session-nav__body")?.scrollTo({ top: scrollTop })
}

function renderGroupLater(api, state, group) {
  if (!updateVisibleGroupSections(api, state, [group])) renderLater(state)
}

function renderInputForGroup(state, group) {
  if (group === state.favorites) {
    state.favorites.sessions = favoriteSessions(state)
    return {
      title: "Favorites",
      icon: "favorite",
      key: group.key,
      group,
      project: undefined,
      indent: true,
      projectBadges: true,
    }
  }
  if (group === state.recent) {
    return {
      title: "Recent sessions",
      icon: "recent",
      key: group.key,
      group,
      project: undefined,
      indent: true,
      projectBadges: true,
    }
  }
  const project = projectForDirectory(state, group.directory)
  if (!project) return
  return {
    title: undefined,
    key: group.key,
    group,
    project,
    indent: true,
  }
}

function updateVisibleSessionRows(api, state) {
  const root = state.root
  if (!root) return false
  let updated = false
  for (const row of root.querySelectorAll(".oc-session-nav__session")) {
    const session = sessionFromState(state, row.dataset.sessionId, row.dataset.directory)
    if (!session) continue
    updateSessionRow(api, state, row, session, row.dataset.directory)
    updated = true
  }
  return updated
}

function sessionFromState(state, id, directory) {
  if (!id) return
  return [...(state.active ? [state.active] : []), state.favorites, state.recent, ...state.groups.values(), state.search]
    .flatMap((group) => group.sessions ?? [])
    .find((session) => session.id === id && (!directory || (session.directory || directory) === directory))
}

function updateSessionRow(api, state, row, session, directory) {
  updatePriorityRow(api, row, session, directory)
  const title = session.title || session.slug || "New session"
  const titleNode = row.querySelector(".oc-session-nav__session-title")
  if (titleNode) titleNode.textContent = title

  const meta = row.querySelector(".oc-session-nav__session-meta")
  if (meta) updateSessionMeta(api, meta, session, directory)

  const favorite = row.querySelector(".oc-session-nav__favorite")
  if (!favorite) return
  const picked = isFavorite(state, session)
  favorite.title = picked ? `Remove ${title} from favorites` : `Add ${title} to favorites`
  favorite.setAttribute("aria-label", favorite.title)
  favorite.setAttribute("aria-pressed", String(picked))
  favorite.replaceChildren(navIcon("favorite", picked))
}

function updatePriorityRow(api, row, session, directory) {
  const priority = directory && api.host.sessions.attention?.get?.({ directory, sessionID: session.id })
  row.classList.toggle("oc-session-nav__session--important", !!priority?.available && !!priority?.enabled)
  row.classList.toggle("oc-session-nav__session--unseen", !!priority?.pendingCount)
  let label = row.querySelector(".oc-session-nav__important-label")
  if (!priority?.available || !priority.enabled) {
    label?.remove()
    return
  }
  if (!label) {
    label = document.createElement("span")
    label.className = "oc-session-nav__important-label"
    row.querySelector(".oc-session-nav__session-main")?.append(label)
  }
  label.textContent = priority.pendingCount ? (priority.error ? "! Wichtig: Fehler" : "! Wichtig: Ergebnis") : "✦ Wichtig"
  label.setAttribute("aria-label", label.textContent)
}

export function sessionVisualStatus(api, session, directory) {
  const status = api.host?.sessions?.status?.({ directory, sessionID: session.id })
  // The host resolver collapses open questions and plan_ready into a single "attention"
  // status (orange). running/done/incomplete are terminal/active states as-is.
  if (status === "running" || status === "attention" || status === "done" || status === "incomplete") return status
}

export function statusLabel(status) {
  if (status === "running") return "Session is running"
  if (status === "attention") return "Session needs attention"
  if (status === "done") return "Session completed"
  return "Session incomplete"
}

function statusDot(status) {
  const dot = document.createElement("span")
  dot.className = `oc-session-nav__status-dot oc-session-nav__status-dot--${status}`
  dot.dataset.slot = "session-status-dot"
  dot.dataset.status = status
  dot.title = statusLabel(status)
  dot.setAttribute("aria-label", statusLabel(status))
  return dot
}

export function updateSessionMeta(api, meta, session, directory) {
  // Single resolved host status drives the indicator, so the navigator can never diverge
  // from the tab avatar (which uses the same resolveSessionStatus priority). Running wins,
  // then the orange attention dot (open question or plan_ready), then the terminal
  // done/incomplete dots, then the timestamp.
  const status = sessionVisualStatus(api, session, directory)
  const running = status === "running"
  meta.classList.toggle("oc-session-nav__session-meta--loading", running)
  meta.replaceChildren()
  if (running) {
    meta.setAttribute("aria-label", statusLabel(status))
    meta.append(spinner())
    return
  }
  if (status) {
    meta.setAttribute("aria-label", statusLabel(status))
    meta.append(statusDot(status), document.createTextNode(relativeTime(sessionUpdated(session))))
    return
  }
  meta.removeAttribute("aria-label")
  meta.textContent = relativeTime(sessionUpdated(session))
}

function removeSessionByID(state, id, directory) {
  if (!id) return
  const identity = directoryIdentity(directory)
  if (!identity) return
  for (const group of [...(state.active ? [state.active] : []), state.recent, ...state.groups.values()]) {
    group.sessions = group.sessions.filter(
      (session) => session.id !== id || directoryIdentity(session.directory || group.directory) !== identity,
    )
  }
  state.search.sessions = state.search.sessions.filter(
    (session) => session.id !== id || directoryIdentity(session.directory) !== identity,
  )
}

function compareSessions(api, state, directory) {
  return (a, b) => {
    const activeRank = sessionActiveRank(api, state, a, directory) - sessionActiveRank(api, state, b, directory)
    if (activeRank) return activeRank
    const updated = sessionSortTime(api, state, b, directory) - sessionSortTime(api, state, a, directory)
    if (updated) return updated
    return String(a.id).localeCompare(String(b.id))
  }
}

function sessionActiveRank(api, state, session, fallbackDirectory) {
  const directory = session.directory || fallbackDirectory
  const status = directory && sessionVisualStatus(api, session, directory)
  if (status !== "running" && status !== "attention") return 2
  return sessionParentID(state, session) ? 1 : 0
}

function sessionWorking(api, session, fallbackDirectory) {
  const directory = session.directory || fallbackDirectory
  return Boolean(directory && api.host?.sessions?.working?.({ directory, sessionID: session.id }))
}

function sessionSortTime(api, state, session, fallbackDirectory) {
  const directory = session.directory || fallbackDirectory
  const key = sessionKey(session, directory)
  if (directory && sessionActiveRank(api, state, session, fallbackDirectory) < 2) {
    state.activeSortTimes[key] ??= Math.max(sessionUpdated(session), Date.now())
    return state.activeSortTimes[key]
  }
  delete state.activeSortTimes[key]
  return sessionUpdated(session)
}

function renderSearch(api, state, body) {
  const projectMatches = state.projects.filter((project) =>
    !state.hiddenProjects.has(projectGroupKey(project)) &&
    `${project.name} ${project.worktree}`.toLowerCase().includes(state.query.trim().toLowerCase()),
  )
  const section = document.createElement("div")
  section.className = "oc-session-nav__section"
  const title = document.createElement("div")
  title.className = "oc-session-nav__section-title"
  title.textContent = "Search"
  section.append(title)
  const sessions = visibleSessions(state, state.search.sessions)
  for (const project of projectMatches) {
    const row = document.createElement("button")
    row.type = "button"
    row.className = "oc-session-nav__project-result"
    row.textContent = projectLabel(state, project)
    row.addEventListener("click", () =>
      navigatorApi(api, state)?.host.navigation.newSession({ directory: project.worktree }),
    )
    section.append(row)
  }
  if (state.search.loading) section.append(empty("Loading"))
  if (!state.search.loading && sessions.length === 0 && projectMatches.length === 0)
    section.append(empty("No sessions found"))
  for (const session of sessions) {
    section.append(sessionRow(api, state, session, session.directory))
  }
  body.append(section)
}

function renderProjectVisibility(api, state, body) {
  const projects = new Map(state.projects.map((project) => [projectGroupKey(project), project.worktree]))
  for (const key of state.hiddenProjects) if (!projects.has(key)) projects.set(key, key)
  if (!projects.size) body.append(empty("No projects"))
  for (const [key, worktree] of projects) {
    const row = document.createElement("div")
    row.className = "oc-session-nav__visibility-row"
    const path = document.createElement("span")
    path.textContent = worktree
    const button = actionButton(state.hiddenProjects.has(key) ? "Show" : "Hide")
    button.setAttribute("aria-label", `${button.textContent} ${worktree} in Navigator`)
    button.dataset.visibilityControl = key
    button.addEventListener("click", () => {
      const hostApi = navigatorApi(api, state)
      if (!hostApi?.kv?.set) return
      const next = new Set(state.hiddenProjects)
      if (!next.delete(key)) next.add(key)
      try {
        hostApi.kv.set(HIDDEN_PROJECTS_STORAGE_KEY, [...next])
      } catch {
        path.textContent = `${worktree} — could not save visibility`
        return
      }
      state.hiddenProjects = next
      renderLater(state)
    })
    row.append(path, button)
    body.append(row)
  }
}

function renderProject(api, state, body, project, index) {
  const group = ensureProjectGroup(state, project)
  const section = document.createElement("div")
  section.className = "oc-session-nav__project"

  const header = document.createElement("div")
  header.className = "oc-session-nav__project-header"
  const toggle = document.createElement("button")
  toggle.type = "button"
  toggle.className = "oc-session-nav__project-toggle"
  toggle.addEventListener("click", () => {
    group.expanded = !group.expanded
    if (group.expanded && !group.loaded) void loadGroup(api, group, state)
    renderLater(state)
  })
  const chevron = document.createElement("span")
  chevron.className = "oc-session-nav__chevron"
  chevron.textContent = group.expanded ? "v" : ">"
  const avatar = projectAvatar(project)
  const name = document.createElement("span")
  name.className = "oc-session-nav__project-name"
  name.textContent = projectLabel(state, project)
  toggle.title = project.worktree
  toggle.append(chevron, avatar, name)
  const previous = state.projects.findLastIndex((item, position) => position < index && !state.hiddenProjects.has(projectGroupKey(item)))
  const next = state.projects.findIndex((item, position) => position > index && !state.hiddenProjects.has(projectGroupKey(item)))
  const moveUp = projectMoveButton("↑", `Move ${project.name} up`, previous < 0, (event) => {
    event.preventDefault()
    event.stopPropagation()
    moveProject(api, state, project.worktree, previous)
  })
  const moveDown = projectMoveButton("↓", `Move ${project.name} down`, next < 0, (event) => {
    event.preventDefault()
    event.stopPropagation()
    moveProject(api, state, project.worktree, next)
  })
  const add = document.createElement("button")
  add.type = "button"
  add.className = "oc-session-nav__project-add"
  add.textContent = "+"
  add.title = `New session for ${project.name}`
  add.setAttribute("aria-label", `New session for ${project.name}`)
  add.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    navigatorApi(api, state)?.host.navigation.newSession({ directory: project.worktree, area: "middle" })
  })
  header.append(toggle, moveUp, moveDown, add)
  section.append(header)

  if (group.expanded) {
    renderGroup(api, state, section, {
      title: undefined,
      key: group.key,
      group,
      project,
      indent: true,
    })
  }
  body.append(section)
}

function renderGroup(api, state, body, input) {
  body.append(createGroupSection(api, state, input))
}

function createGroupSection(api, state, input) {
  const section = document.createElement("div")
  section.className = "oc-session-nav__section"
  if (input.key) section.dataset.groupKey = input.key
  if (input.title) {
    const title = document.createElement(input.alwaysExpanded ? "div" : "button")
    if (!input.alwaysExpanded) title.type = "button"
    title.className = "oc-session-nav__group-header"
    if (!input.alwaysExpanded)
      title.addEventListener("click", () => {
        input.group.expanded = !input.group.expanded
        if (input.group.expanded && !input.group.loaded) void loadGroup(api, input.group, state)
        renderLater(state)
      })
    const chevron = document.createElement("span")
    chevron.className = "oc-session-nav__chevron"
    chevron.textContent = input.group.expanded ? "v" : ">"
    const text = document.createElement("span")
    text.className = "oc-session-nav__group-title"
    text.textContent = input.title
    if (input.icon) title.append(groupAvatar(input.icon))
    title.append(text)
    if (!input.alwaysExpanded) title.append(chevron)
    section.append(title)
  }

  if (input.group.expanded) {
    const sessions = visibleSessions(state, input.group.sessions)
    if (input.group.loading && !input.group.loaded) section.append(empty("Loading"))
    if (!input.group.loading && input.group.loaded && sessions.length === 0) section.append(empty("No sessions"))
    for (const session of sessions) {
      section.append(
        sessionRow(
          api,
          state,
          session,
          input.project?.worktree ?? session.directory,
          input.indent,
          input.projectBadges,
        ),
      )
    }
    const limit = previewLimit()
    const showControls = !input.alwaysExpanded && (input.group.hasMore || sessions.length > limit)
    if (showControls) {
      const controls = document.createElement("div")
      controls.className = "oc-session-nav__controls"
      controls.append(
        controlButton(input.group.loading ? "Loading" : "More", input.group.loading || !input.group.hasMore, () =>
          loadGroup(api, input.group, state, "more"),
        ),
        controlButton("Less", input.group.loading || sessions.length <= limit, () => collapseGroup(input.group, state)),
        controlButton("All", input.group.loading || input.group.loadedAll, () =>
          loadGroup(api, input.group, state, "all"),
        ),
      )
      section.append(controls)
    }
  }
  return section
}

function sessionRow(api, state, session, fallbackDirectory, indented, projectBadges) {
  const directory = session.directory || fallbackDirectory
  const row = document.createElement("div")
  row.className = "oc-session-nav__session"
  if (indented) row.classList.add("oc-session-nav__session--indented")
  if (state.missingFavorites?.has(session.id)) row.classList.add("oc-session-nav__session--missing")
  row.dataset.sessionId = session.id
  row.dataset.directory = directory || ""

  const open = document.createElement("button")
  open.type = "button"
  open.className = "oc-session-nav__session-main"
  open.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !directory) return
    state.pendingSessionActivation = {
      api,
      session,
      directory,
      pointerID: event.pointerId,
      target: open,
      clientX: event.clientX,
      clientY: event.clientY,
    }
  })
  open.addEventListener("click", (event) => {
    event.preventDefault()
    if (!directory) return
    void openSession(api, state, session, directory)
  })
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!directory) return
    state.contextMenu = { session, directory, x: event.clientX, y: event.clientY }
    renderLater(state)
  })

  const title = document.createElement("span")
  title.className = "oc-session-nav__session-title"
  title.textContent = session.title || session.slug || "New session"
  const meta = document.createElement("span")
  meta.className = "oc-session-nav__session-meta"
  updateSessionMeta(api, meta, session, directory)
  const project = projectBadges ? projectForSession(state, { ...session, directory }) : undefined
  if (project) {
    open.classList.add("oc-session-nav__session-main--project")
    open.append(projectAvatar(project))
  }
  open.append(title, meta)
  row.append(open)
  updatePriorityRow(api, row, session, directory)

  const favorite = favoriteButton(state, session)
  favorite.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !directory) return
    state.pendingSessionActivation = {
      api,
      session,
      directory,
      favorite: true,
      pointerID: event.pointerId,
      target: favorite,
      clientX: event.clientX,
      clientY: event.clientY,
    }
  })
  favorite.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    // The first click of a double-click re-renders the list, so the second one lands on
    // whichever star took this row's place. Only a single click toggles.
    if (event.detail > 1) return
    toggleFavorite(api, state, session, directory)
  })
  row.append(favorite)

  const key = sessionKey(session, directory)
  if (state.confirmDelete === key) {
    const confirm = document.createElement("div")
    confirm.className = "oc-session-nav__confirm"
    const label = document.createElement("span")
    label.textContent = "Delete?"
    const yes = actionButton("Yes")
    yes.addEventListener("click", () => deleteSession(api, state, session, directory))
    const no = actionButton("No")
    no.addEventListener("click", () => {
      state.confirmDelete = undefined
      renderLater(state)
    })
    confirm.append(label, yes, no)
    row.append(confirm, favorite)
    return row
  }

  const actions = document.createElement("div")
  actions.className = "oc-session-nav__actions"
  const archive = actionButton("Archive")
  archive.addEventListener("click", () => archiveSession(api, state, session, directory))
  const remove = actionButton("Delete")
  remove.addEventListener("click", () => {
    state.confirmDelete = key
    renderLater(state)
  })
  actions.append(archive, remove)
  // Keep the favorite at the trailing edge: revealing hover actions must not
  // move the target away from the pointer (or put Delete underneath it).
  row.append(actions, favorite)
  return row
}

function sessionContextMenu(api, state) {
  const input = state.contextMenu
  const menu = document.createElement("div")
  menu.className = "oc-session-nav__context-menu"
  menu.style.left = `${Math.max(8, Math.min(input.x, window.innerWidth - 190))}px`
  menu.style.top = `${Math.max(8, Math.min(input.y, window.innerHeight - 160))}px`
  menu.addEventListener("pointerdown", (event) => event.stopPropagation())
  menu.addEventListener("contextmenu", (event) => event.preventDefault())

  const rename = contextMenuButton("Rename", () => openSessionRenameDialog(api, state, input.session, input.directory))
  const favorite = contextMenuButton(
    isFavorite(state, input.session) ? "Remove from favorites" : "Add to favorites",
    () => {
      toggleFavorite(api, state, input.session, input.directory)
      state.contextMenu = undefined
      renderLater(state)
    },
  )
  const separator = document.createElement("div")
  separator.className = "oc-session-nav__context-menu-separator"
  const archive = contextMenuButton("Archive", () => archiveSession(api, state, input.session, input.directory))
  const remove = contextMenuButton("Delete", () => {
    state.confirmDelete = sessionKey(input.session, input.directory)
    state.contextMenu = undefined
    renderLater(state)
  })

  menu.append(rename, favorite, separator, archive, remove)
  return menu
}

function contextMenuButton(text, onClick) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "oc-session-nav__context-menu-item"
  button.textContent = text
  button.addEventListener("click", onClick)
  return button
}

export function openSessionRenameDialog(api, state, session, directory) {
  if (!directory) return
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  const current = session.title || session.slug || "New session"
  state.contextMenu = undefined
  renderLater(state)
  closeSessionRenameDialog(state)

  const doc = state.root?.ownerDocument ?? document
  const overlay = doc.createElement("div")
  overlay.className = "oc-session-nav__rename-overlay"
  const form = doc.createElement("form")
  form.className = "oc-session-nav__rename-dialog"
  form.setAttribute("role", "dialog")
  form.setAttribute("aria-modal", "true")
  form.setAttribute("aria-labelledby", "oc-session-nav-rename-title")

  const heading = doc.createElement("h2")
  heading.id = "oc-session-nav-rename-title"
  heading.textContent = "Rename session"
  const label = doc.createElement("label")
  label.htmlFor = "oc-session-nav-rename-input"
  label.textContent = "Session title"
  const input = doc.createElement("input")
  input.id = "oc-session-nav-rename-input"
  input.name = "title"
  input.type = "text"
  input.autocomplete = "off"
  input.value = current
  input.setAttribute("aria-required", "true")
  input.setAttribute("aria-describedby", "oc-session-nav-rename-error")
  const error = doc.createElement("div")
  error.id = "oc-session-nav-rename-error"
  error.className = "oc-session-nav__rename-error"
  error.setAttribute("aria-live", "polite")
  error.hidden = true

  const actions = doc.createElement("div")
  actions.className = "oc-session-nav__rename-actions"
  const cancel = doc.createElement("button")
  cancel.type = "button"
  cancel.textContent = "Cancel"
  const save = doc.createElement("button")
  save.type = "submit"
  save.textContent = "Save"
  save.className = "oc-session-nav__rename-save"
  actions.append(cancel, save)
  form.append(heading, label, input, error, actions)
  overlay.append(form)

  let saving = false
  const close = () => {
    overlay.remove()
    if (state.renameDialog?.element === overlay) state.renameDialog = undefined
  }
  state.renameDialog = { element: overlay, close }
  cancel.addEventListener("click", close)
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay && !saving) close()
  })
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !saving) {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== "Tab") return
    const focusable = [input, cancel, save].filter((item) => !item.disabled)
    if (focusable.length === 0) return
    event.preventDefault()
    const index = focusable.indexOf(doc.activeElement)
    const next = event.shiftKey
      ? focusable[(index <= 0 ? focusable.length : index) - 1]
      : focusable[(index + 1) % focusable.length]
    next.focus()
  })
  input.addEventListener("input", () => {
    error.hidden = true
    input.removeAttribute("aria-invalid")
  })
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    if (saving) return
    const next = input.value.trim()
    if (!next) {
      error.textContent = "Enter a session title."
      error.hidden = false
      input.setAttribute("aria-invalid", "true")
      input.focus()
      return
    }
    if (next === current.trim()) {
      close()
      return
    }

    saving = true
    form.setAttribute("aria-busy", "true")
    input.readOnly = true
    cancel.disabled = true
    save.disabled = true
    save.textContent = "Saving..."
    void updateSession(serverApi, state, { directory, sessionID: session.id, title: next })
      .then(() => {
        renameSessionInState(state, session.id, directory, next)
        syncFavorite(serverApi, state, { ...session, title: next }, directory)
        close()
        renderLater(state)
      })
      .catch((cause) => {
        saving = false
        form.removeAttribute("aria-busy")
        input.readOnly = false
        cancel.disabled = false
        save.disabled = false
        save.textContent = "Save"
        error.textContent = cause instanceof Error && cause.message ? cause.message : "Request failed"
        error.hidden = false
        input.setAttribute("aria-invalid", "true")
        input.focus()
      })
  })

  doc.body.append(overlay)
  queueMicrotask(() => {
    input.focus()
    input.select()
  })
}

function closeSessionRenameDialog(state) {
  state.renameDialog?.close()
}

function renameSessionInState(state, id, directory, title) {
  const identity = directoryIdentity(directory)
  for (const group of [...(state.active ? [state.active] : []), state.recent, ...state.groups.values()]) {
    group.sessions = group.sessions.map((session) => {
      if (session.id !== id || directoryIdentity(session.directory || group.directory) !== identity) return session
      return { ...session, title }
    })
  }
  state.search.sessions = state.search.sessions.map((session) => {
    if (session.id !== id || directoryIdentity(session.directory) !== identity) return session
    return { ...session, title }
  })
  state.favoriteItems = Object.fromEntries(
    Object.entries(state.favoriteItems).map((entry) => {
      if (entry[1]?.id !== id || entry[1]?.directory !== directory) return entry
      return [entry[0], { ...entry[1], title }]
    }),
  )
}

async function archiveSession(api, state, session, directory) {
  if (!directory) return
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  await updateSession(serverApi, state, {
    directory,
    sessionID: session.id,
    time: { archived: Date.now() },
  })
  removeFavorite(serverApi, state, session, directory)
  removeSessionFromState(serverApi, state, session.id, directory)
  navigateAfterRemoval(serverApi, state, session.id, directory)
  renderLater(state)
}

async function deleteSession(api, state, session, directory) {
  if (!directory) return
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  // A favorite whose session is already gone must still leave the list.
  await removeSession(serverApi, state, { directory, sessionID: session.id }).catch((error) => {
    if (!isSessionNotFound(error)) throw error
  })
  removeFavorite(serverApi, state, session, directory)
  removeSessionFromState(serverApi, state, session.id, directory)
  navigateAfterRemoval(serverApi, state, session.id, directory)
  renderLater(state)
}

export function openSession(api, state, session, directory) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi || !state.root?.isConnected) return
  const favorite = isFavorite(state, session)
  if (!favorite) serverApi.host.navigation.openSession({ directory, sessionID: session.id, area: "middle" })
  return sessionExists(serverApi, { directory, sessionID: session.id })
    .then((exists) => {
      if (navigatorApi(api, state) !== serverApi) return
      if (exists) {
        if (favorite) serverApi.host.navigation.openSession({ directory, sessionID: session.id, area: "middle" })
        state.missingFavorites?.delete(session.id)
        return
      }
      // A favorite whose session is gone stays listed (dimmed) until the user removes it.
      if (favorite) {
        state.missingFavorites ??= new Set()
        state.missingFavorites.add(session.id)
      }
      if (!favorite) {
        state.missingSessions ??= new Set()
        state.missingSessions.add(sessionKey(session, directory))
      }
      removeSessionByID(state, session.id, directory)
      renderLater(state)
    })
    .catch((error) => {
      if (favorite && navigatorApi(api, state) === serverApi) {
        serverApi.host.navigation.openSession({ directory, sessionID: session.id, area: "middle" })
      }
      console.error(
        `Session navigator could not validate session ${session.id}; keeping the optimistic navigation.`,
        error,
      )
    })
}

async function updateSession(api, state, input) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi) throw new Error("Session navigator host changed")
  if (hostHttpAvailable(serverApi)) {
    try {
      return await sessionRequest(serverApi, {
        method: "PATCH",
        directory: input.directory,
        sessionID: input.sessionID,
        body: {
          title: input.title,
          metadata: input.metadata,
          permission: input.permission,
          time: input.time,
        },
      })
    } catch (error) {
      if (!isCapabilityDenied(error)) throw error
    }
  }
  return serverApi.client.session.update(input)
}

async function removeSession(api, state, input) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi) throw new Error("Session navigator host changed")
  if (hostHttpAvailable(serverApi)) {
    try {
      return await sessionRequest(serverApi, {
        method: "DELETE",
        directory: input.directory,
        sessionID: input.sessionID,
      })
    } catch (error) {
      if (!isCapabilityDenied(error)) throw error
    }
  }
  return serverApi.client.session.delete(input)
}

async function sessionExists(api, input) {
  return (await probeSession(api, input)).exists
}

export async function probeSession(api, input) {
  if (hostHttpAvailable(api)) {
    const response = await api.host.http.request({
      path: `/session/${encodeURIComponent(input.sessionID)}/exists`,
      method: "GET",
      query: { directory: input.directory },
    })
    if (response.ok) {
      const result =
        response.body && typeof response.body === "object" && response.body.data && typeof response.body.data === "object"
          ? response.body.data
          : response.body
      if (result?.exists === false) return { exists: false }
      if (result?.exists === true && result.session && typeof result.session === "object") {
        return { exists: true, session: result.session }
      }
      throw new Error("Session existence response was invalid")
    }
    // The app runtime exposes host.http even without a grant and fail-closes
    // with a synthetic 403. Method presence is not proof of grant, so treat
    // that sentinel as "transport unavailable" and validate through the
    // client SDK instead of failing the click.
    if (!capabilityDenied(response)) {
      throw new Error(response.text || response.statusText || `Session request failed with ${response.status}`)
    }
  }
  try {
    const response = await api.client.session.get(input)
    return { exists: true, session: response?.data ?? response }
  } catch (error) {
    if (isSessionNotFound(error)) return { exists: false }
    throw error
  }
}

function hostHttpAvailable(api) {
  if (!api.host?.http?.request) return false
  // Runtimes that do not expose a capability set keep the legacy
  // method-presence behavior.
  if (api.capabilities?.has) return api.capabilities.has("host:http")
  return true
}

function capabilityDenied(response) {
  return response.status === 403 && response.statusText === "Missing host:http capability"
}

function isCapabilityDenied(error) {
  return error?.status === 403 && error?.statusText === "Missing host:http capability"
}

function isSessionNotFound(error) {
  if (!error || typeof error !== "object") return false
  if (error.status === 404) return true
  return Boolean(error.cause && typeof error.cause === "object" && error.cause.status === 404)
}

async function sessionRequest(api, input) {
  const response = await api.host.http.request({
    path: `/session/${encodeURIComponent(input.sessionID)}`,
    method: input.method,
    query: { directory: input.directory },
    body: input.body,
  })
  if (response.ok) return response.body
  const error = new Error(response.text || response.statusText || `Session request failed with ${response.status}`)
  error.status = response.status
  error.statusText = response.statusText
  throw error
}

function removeSessionFromState(api, state, id, directory) {
  state.confirmDelete = undefined
  const identity = directoryIdentity(directory)
  if (!identity) return
  for (const group of [...(state.active ? [state.active] : []), state.recent, ...state.groups.values()]) {
    group.sessions = group.sessions.filter(
      (session) => session.id !== id || directoryIdentity(session.directory || group.directory) !== identity,
    )
    refillGroupAfterRemoval(api, state, group)
  }
  state.search.sessions = state.search.sessions.filter(
    (session) => session.id !== id || directoryIdentity(session.directory) !== identity,
  )
}

function refillGroupAfterRemoval(api, state, group) {
  if (!group.loaded || group.loadedAll || !group.hasMore) return
  if (group.sessions.length >= previewLimit()) return
  if (group.loading) {
    group.reloadPreview = true
    return
  }
  void loadGroup(api, group, state)
}

function navigateAfterRemoval(api, state, id, directory) {
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  const current = serverApi.host.navigation.current()
  if (current.sessionID !== id || current.directory !== directory) return
  const project = projectForDirectory(state, directory)
  const group = project ? state.groups.get(projectGroupKey(project)) : legacyGroupForDirectory(state, directory)
  const sameWorkspace = (session) => session.id !== id && !!session.directory && (
    project ? projectForDirectory(state, session.directory) === project :
      projectWorktreeKey(session.directory) === projectWorktreeKey(directory)
  )
  const next = group?.sessions.find(sameWorkspace) || state.recent.sessions.find(sameWorkspace)
  if (next) {
    serverApi.host.navigation.openSession({ directory: next.directory, sessionID: next.id })
    return
  }
  serverApi.host.navigation.newSession({ directory: project?.worktree ?? directory })
}

function moveProjectOptimistic(state, worktree, toIndex) {
  const from = state.projects.findIndex((project) => project.worktree === worktree)
  if (from < 0) return
  const next = state.projects.slice()
  const item = next.splice(from, 1)[0]
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, item)
  state.projects = next
}

function moveProject(api, state, worktree, toIndex) {
  if (toIndex < 0 || toIndex >= state.projects.length) return
  const serverApi = navigatorApi(api, state)
  if (!serverApi) return
  moveProjectOptimistic(state, worktree, toIndex)
  serverApi.host.projects.move(worktree, toIndex)
  renderLater(state)
}

function projectMoveButton(text, label, disabled, onClick) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "oc-session-nav__project-move"
  button.textContent = text
  button.title = label
  button.disabled = disabled
  button.setAttribute("aria-label", label)
  button.addEventListener("click", onClick)
  return button
}

function actionButton(text) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "oc-session-nav__action"
  button.textContent = text
  return button
}

function controlButton(text, disabled, onClick) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "oc-session-nav__more"
  button.textContent = text
  button.disabled = disabled
  button.addEventListener("click", onClick)
  return button
}

function empty(text) {
  const node = document.createElement("div")
  node.className = "oc-session-nav__empty"
  node.textContent = text
  return node
}

function renderLater(state) {
  if (typeof state.render === "function") state.render()
}

function sessionUpdated(session) {
  return timestamp(session?.time?.updated ?? session?.time?.created)
}

function timestamp(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0
  if (typeof value !== "string") return 0
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function sessionKey(session, directory) {
  return `${directoryIdentity(directory || session.directory)}:${session.id}`
}

function directoryIdentity(directory) {
  const value = String(directory || "").replace(/\\/g, "/").replace(/\/+$/, "")
  if (/^[a-zA-Z]:\//.test(value) || value.startsWith("//")) return value.toLowerCase()
  return value
}

function initial(value) {
  const trimmed = String(value || "?").trim()
  return trimmed.slice(0, 1).toUpperCase()
}

function projectAvatar(project) {
  const avatar = document.createElement("span")
  avatar.className = "oc-session-nav__avatar"
  const url = project.icon?.url
  // Layout can keep a cached fallback color after an ICO is discovered.
  const favicon = typeof url === "string" && url.length <= 512 * 1024 &&
    /^data:image\/(?:vnd\.microsoft\.icon|x-icon);base64,[A-Za-z0-9+/]+=*$/i.test(url) ? url : undefined
  const artwork = project.icon?.override || favicon
  if (artwork) {
    const image = document.createElement("img")
    image.src = artwork
    image.draggable = false
    image.alt = ""
    avatar.append(image)
    return avatar
  }
  const src = !project.icon?.color ? project.icon?.url : undefined
  if (src) {
    avatar.className = "oc-session-nav__avatar oc-session-nav__avatar--mask"
    const mask = document.createElement("span")
    mask.className = "oc-session-nav__avatar-mask"
    mask.style.setProperty("--oc-session-nav-avatar-mask", cssUrl(src))
    avatar.append(mask)
    return avatar
  }
  if (safeGeneratedIcon(project.icon?.generated)) {
    const image = document.createElement("img")
    image.src = project.icon.generated
    image.draggable = false
    image.alt = ""
    avatar.append(image)
    return avatar
  }
  avatar.dataset.color = projectAvatarColor(project.icon?.color)
  avatar.textContent = initial(project.name)
  return avatar
}

function safeGeneratedIcon(value) {
  return typeof value === "string" && value.length <= 512 * 1024 && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)
}

function cssUrl(src) {
  return `url("${src.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, "")}")`
}

function projectForDirectory(state, directory) {
  if (!directory) return undefined
  const key = projectWorktreeKey(directory)
  return state.projects?.find((project) =>
    projectWorktreeKey(project.worktree) === key ||
    project.sessionDirectories?.some((alias) => projectWorktreeKey(alias) === key),
  )
}

function projectForSession(state, session) {
  return projectForDirectory(state, session.directory)
}

function legacyGroupForDirectory(state, directory) {
  if (!directory || state.projects?.length) return undefined
  const key = projectWorktreeKey(directory)
  return [...state.groups.values()].find((group) => group.directory && projectWorktreeKey(group.directory) === key)
}

function projectWorktreeKey(path) {
  const windows = /^[a-z]:/i.test(path) || path.startsWith("\\\\")
  const value = (windows ? path.replaceAll("\\", "/") : path).replace(/\/\.(?=\/|$)\/?/g, "/")
  const trimmed = value.replace(/\/+$/, "") || "/"
  return windows || value.startsWith("//") ? trimmed.toLowerCase() : trimmed
}

function projectLabel(state, project) {
  return state.projects.some((other) => other !== project && other.name === project.name)
    ? `${project.name} — ${project.worktree}`
    : project.name
}

function spinner() {
  // Simple circular spinner: 12px box, 2px border, transparent except border-top in
  // currentColor, spinning at 800ms linear. Keeps the oc-session-nav__spinner class so the
  // CSS rule owns the look and there is exactly one spinner implementation.
  const node = document.createElement("span")
  node.setAttribute("class", "oc-session-nav__spinner")
  node.setAttribute("aria-hidden", "true")
  return node
}

function projectAvatarColor(color) {
  if (color === "orange") return "orange"
  if (color === "pink") return "pink"
  if (color === "cyan" || color === "mint") return "cyan"
  if (color === "purple") return "purple"
  if (color === "lime") return "green"
  return "gray"
}

function groupAvatar(kind) {
  const avatar = document.createElement("span")
  avatar.className = "oc-session-nav__avatar oc-session-nav__avatar--icon"
  avatar.append(navIcon(kind, false))
  return avatar
}

function favoriteButton(state, session) {
  const picked = isFavorite(state, session)
  const title = session.title || session.slug || "session"
  const button = document.createElement("button")
  button.type = "button"
  button.className = "oc-session-nav__favorite"
  button.title = picked ? `Remove ${title} from favorites` : `Add ${title} to favorites`
  button.setAttribute("aria-label", button.title)
  button.setAttribute("aria-pressed", String(picked))
  button.append(navIcon("favorite", picked))
  return button
}

function navIcon(kind, filled) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "none")
  svg.setAttribute("stroke", "currentColor")
  svg.setAttribute("stroke-width", "2")
  svg.setAttribute("stroke-linecap", "round")
  svg.setAttribute("stroke-linejoin", "round")
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  if (kind === "recent") {
    path.setAttribute("d", "M9 2h6m-3 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 4v4l3 2")
    svg.append(path)
    return svg
  }
  path.setAttribute("d", "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z")
  if (filled) path.setAttribute("fill", "currentColor")
  svg.append(path)
  return svg
}

function relativeTime(time) {
  const updated = timestamp(time)
  if (!updated) return ""
  const diff = Math.max(0, Date.now() - updated)
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
    .oc-session-nav {
      height: 100%;
      min-height: 0;
      background: var(--background-stronger);
      color: var(--text-base);
      font: 13px/1.4 var(--font-sans, ui-sans-serif, system-ui);
    }
    .oc-session-nav__shell {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .oc-session-nav__search-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px;
    }
    .oc-session-nav__search {
      min-width: 0;
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      height: 40px;
      padding: 0 10px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-base);
    }
    .oc-session-nav__project-open {
      width: 36px;
      height: 40px;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      background: var(--background-base);
      color: var(--text-weak);
      display: grid;
      place-items: center;
      font: 20px/1 var(--font-sans, ui-sans-serif, system-ui);
    }
    .oc-session-nav__search-icon {
      color: var(--text-weak);
      font-size: 11px;
    }
    .oc-session-nav__search input {
      min-width: 0;
      flex: 1;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text-base);
      font: inherit;
    }
    .oc-session-nav__search-status {
      color: var(--text-interactive-base, var(--text-base));
      flex: 0 0 12px;
      display: grid;
      place-items: center;
    }
    .oc-session-nav__filter {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: -2px 8px 6px;
      padding: 0 2px;
      color: var(--text-weak);
      font-size: 12px;
      user-select: none;
    }
    .oc-session-nav__filter input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--text-interactive-base, var(--text-base));
    }
    .oc-session-nav__body {
      min-height: 0;
      flex: 1;
      overflow: auto;
      padding: 0 8px 12px;
    }
    .oc-session-nav__visibility-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px;
      overflow-wrap: anywhere;
    }
    .oc-session-nav__section,
    .oc-session-nav__project {
      margin-top: 8px;
    }
    .oc-session-nav__project {
      position: relative;
    }
    .oc-session-nav__section-title,
    .oc-session-nav__group-header,
    .oc-session-nav__project-header,
    .oc-session-nav__project-toggle {
      width: 100%;
      height: 30px;
      border: 0;
      background: transparent;
      color: var(--text-base);
      text-align: left;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 6px;
      border-radius: 6px;
      font: inherit;
    }
    .oc-session-nav__project-header {
      padding: 0;
    }
    .oc-session-nav__project-toggle {
      min-width: 0;
      flex: 1;
    }
    .oc-session-nav__project-move,
    .oc-session-nav__project-add {
      width: 26px;
      height: 26px;
      margin-right: 2px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-weak);
      display: grid;
      place-items: center;
    }
    .oc-session-nav__project-move {
      font: 13px/1 var(--font-sans, ui-sans-serif, system-ui);
    }
    .oc-session-nav__project-add {
      font: 18px/1 var(--font-sans, ui-sans-serif, system-ui);
    }
    .oc-session-nav__project-move:disabled {
      opacity: 0.28;
    }
    .oc-session-nav__project-move:not(:disabled):hover,
    .oc-session-nav__project-add:hover,
    .oc-session-nav__project-open:hover {
      color: var(--text-base);
      background: var(--surface-hover-base);
    }
    .oc-session-nav__group-header:hover,
    .oc-session-nav__project-toggle:hover,
    .oc-session-nav__project-result:hover,
    .oc-session-nav__session:hover {
      background: var(--surface-hover-base);
    }
    .oc-session-nav__section-title {
      color: var(--text-weak);
      font-size: 12px;
      text-transform: none;
    }
    .oc-session-nav__chevron {
      width: 12px;
      color: var(--text-weak);
      font-size: 11px;
      flex: 0 0 12px;
    }
    .oc-session-nav__group-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-session-nav__avatar {
      width: 18px;
      height: 18px;
      overflow: hidden;
      border-radius: 5px;
      display: grid;
      place-items: center;
      background:
        linear-gradient(180deg, var(--v2-alpha-light-16, rgba(255, 255, 255, 0.16)) 0%, var(--v2-alpha-light-0, rgba(255, 255, 255, 0)) 100%),
        var(--oc-session-nav-avatar-bg, var(--surface-panel));
      color: var(--v2-avatar-fg, var(--text-base));
      font-size: 11px;
      font-weight: 530;
      line-height: 1;
      text-transform: uppercase;
      box-shadow: inset 0 0 0 1px var(--oc-session-nav-avatar-border, var(--border-weak-base));
    }
    .oc-session-nav__avatar[data-color="orange"] {
      --oc-session-nav-avatar-bg: var(--v2-avatar-bg-orange, var(--avatar-background-orange, var(--surface-panel)));
      --oc-session-nav-avatar-border: var(--v2-avatar-border-orange, var(--border-weak-base));
    }
    .oc-session-nav__avatar[data-color="pink"] {
      --oc-session-nav-avatar-bg: var(--v2-avatar-bg-pink, var(--avatar-background-pink, var(--surface-panel)));
      --oc-session-nav-avatar-border: var(--v2-avatar-border-pink, var(--border-weak-base));
    }
    .oc-session-nav__avatar[data-color="cyan"] {
      --oc-session-nav-avatar-bg: var(--v2-avatar-bg-cyan, var(--avatar-background-cyan, var(--surface-panel)));
      --oc-session-nav-avatar-border: var(--v2-avatar-border-cyan, var(--border-weak-base));
    }
    .oc-session-nav__avatar[data-color="purple"] {
      --oc-session-nav-avatar-bg: var(--v2-avatar-bg-purple, var(--avatar-background-purple, var(--surface-panel)));
      --oc-session-nav-avatar-border: var(--v2-avatar-border-purple, var(--border-weak-base));
    }
    .oc-session-nav__avatar[data-color="green"] {
      --oc-session-nav-avatar-bg: var(--v2-avatar-bg-green, var(--avatar-background-lime, var(--surface-panel)));
      --oc-session-nav-avatar-border: var(--v2-avatar-border-green, var(--border-weak-base));
    }
    .oc-session-nav__avatar[data-color="gray"] {
      --oc-session-nav-avatar-bg: var(--v2-avatar-bg-gray, var(--surface-panel));
      --oc-session-nav-avatar-border: var(--v2-avatar-border-gray, var(--border-weak-base));
    }
    .oc-session-nav__avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .oc-session-nav__avatar-mask {
      width: 100%;
      height: 100%;
      display: block;
      background: currentColor;
      -webkit-mask: var(--oc-session-nav-avatar-mask) center / contain no-repeat;
      mask: var(--oc-session-nav-avatar-mask) center / contain no-repeat;
    }
    .oc-session-nav__avatar--mask {
      color: var(--text-base);
    }
    .oc-session-nav__avatar--icon {
      color: var(--text-weak);
    }
    .oc-session-nav__avatar--icon svg {
      width: 13px;
      height: 13px;
    }
    .oc-session-nav__project-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-session-nav__project-result {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--text-base);
      text-align: left;
      border-radius: 6px;
      padding: 7px 8px;
      font: inherit;
    }
    .oc-session-nav__session {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      border-radius: 6px;
      padding: 2px 4px;
    }
    .oc-session-nav__session--indented {
      margin-left: 20px;
    }
    .oc-session-nav__session--important .oc-session-nav__important-label {
      color: var(--text-interactive-base, var(--text-base));
      font-size: 11px;
      grid-column: 1 / -1;
    }
    .oc-session-nav__session--unseen {
      outline: 2px solid var(--border-focus, currentColor);
      background: var(--surface-hover-base);
    }
    .oc-session-nav__session--missing .oc-session-nav__session-main {
      color: var(--text-weak);
      opacity: 0.6;
    }
    .oc-session-nav__session-main {
      min-width: 0;
      flex: 1;
      border: 0;
      background: transparent;
      color: var(--text-base);
      text-align: left;
      padding: 6px 4px;
      font: inherit;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
    }
    .oc-session-nav__session-main--project {
      grid-template-columns: 18px minmax(0, 1fr) auto;
      align-items: center;
    }
    .oc-session-nav__favorite {
      width: 32px;
      height: 32px;
      flex: 0 0 32px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--text-weak);
      display: grid;
      place-items: center;
      padding: 0;
    }
    .oc-session-nav__favorite svg {
      width: 14px;
      height: 14px;
    }
    .oc-session-nav__favorite[aria-pressed="true"] {
      color: var(--text-interactive-base, var(--text-base));
    }
    .oc-session-nav__favorite:hover {
      color: var(--text-base);
      background: var(--surface-hover-base);
    }
    .oc-session-nav__favorite:focus-visible {
      outline: 2px solid var(--border-focus, currentColor);
      outline-offset: -2px;
    }
    @media (pointer: coarse) {
      .oc-session-nav__favorite {
        width: 44px;
        height: 44px;
        flex-basis: 44px;
      }
    }
    .oc-session-nav__session-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .oc-session-nav__session-meta {
      color: var(--text-weak);
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      min-width: 14px;
    }
    .oc-session-nav__session-meta--loading {
      color: var(--text-interactive-base, var(--text-base));
    }
    .oc-session-nav__status-dot {
      width: 6px;
      height: 6px;
      flex: 0 0 6px;
      border-radius: 999px;
    }
    .oc-session-nav__status-dot--attention {
      background: var(--v2-state-fg-warning, var(--surface-warning-strong, #f59e0b));
    }
    .oc-session-nav__status-dot--done {
      background: var(--v2-state-fg-success, #22c55e);
    }
    .oc-session-nav__status-dot--incomplete {
      background: var(--v2-state-fg-danger, #ef4444);
    }
    .oc-session-nav__spinner {
      width: 12px;
      height: 12px;
      flex: 0 0 12px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 999px;
      animation: oc-session-nav-spin 800ms linear infinite;
    }
    @keyframes oc-session-nav-spin {
      to {
        transform: rotate(360deg);
      }
    }
    .oc-session-nav__actions,
    .oc-session-nav__confirm {
      display: none;
      align-items: center;
      gap: 4px;
      color: var(--text-weak);
      font-size: 11px;
    }
    .oc-session-nav__session:hover .oc-session-nav__actions,
    .oc-session-nav__confirm {
      display: flex;
    }
    .oc-session-nav__action,
    .oc-session-nav__more {
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--text-weak);
      font: inherit;
      padding: 3px 5px;
    }
    .oc-session-nav__action:not(:disabled):hover,
    .oc-session-nav__more:not(:disabled):hover {
      color: var(--text-base);
      background: var(--surface-hover-base);
    }
    .oc-session-nav__more {
      margin: 4px 0 0 24px;
    }
    .oc-session-nav__more:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .oc-session-nav__controls {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 4px 0 0 24px;
    }
    .oc-session-nav__controls .oc-session-nav__more {
      margin: 0;
    }
    .oc-session-nav__context-menu {
      position: fixed;
      z-index: 1000;
      min-width: 170px;
      padding: 4px;
      border: 1px solid var(--border-weak-base);
      border-radius: 8px;
      background: var(--background-base);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
    }
    .oc-session-nav__context-menu-item {
      width: 100%;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--text-base);
      font: inherit;
      padding: 6px 8px;
      text-align: left;
    }
    .oc-session-nav__context-menu-item:hover {
      background: var(--surface-hover-base);
    }
    .oc-session-nav__context-menu-separator {
      height: 1px;
      margin: 4px;
      background: var(--border-weak-base);
    }
    .oc-session-nav__rename-overlay {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: grid;
      place-items: center;
      padding: 16px;
      background: rgba(0, 0, 0, 0.5);
    }
    .oc-session-nav__rename-dialog {
      width: min(420px, calc(100vw - 32px));
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 20px;
      border: 1px solid var(--border-weak-base);
      border-radius: 10px;
      background: var(--background-base);
      color: var(--text-base);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
      font: 13px/1.4 var(--font-sans, ui-sans-serif, system-ui);
    }
    .oc-session-nav__rename-dialog h2 {
      margin: 0 0 2px;
      font-size: 15px;
      font-weight: 600;
    }
    .oc-session-nav__rename-dialog label {
      color: var(--text-weak);
      font-size: 12px;
    }
    .oc-session-nav__rename-dialog input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      outline: 0;
      padding: 8px 10px;
      background: var(--background-stronger);
      color: var(--text-base);
      font: inherit;
    }
    .oc-session-nav__rename-dialog input:focus {
      border-color: var(--text-interactive-base, var(--text-base));
      box-shadow: 0 0 0 1px var(--text-interactive-base, var(--text-base));
    }
    .oc-session-nav__rename-dialog input[aria-invalid="true"] {
      border-color: var(--surface-critical-strong, #ef4444);
    }
    .oc-session-nav__rename-error {
      min-height: 17px;
      color: var(--surface-critical-strong, #ef4444);
      font-size: 12px;
    }
    .oc-session-nav__rename-error[hidden] {
      visibility: hidden;
    }
    .oc-session-nav__rename-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 4px;
    }
    .oc-session-nav__rename-actions button {
      border: 1px solid var(--border-weak-base);
      border-radius: 6px;
      padding: 7px 12px;
      background: transparent;
      color: var(--text-base);
      font: inherit;
    }
    .oc-session-nav__rename-actions button:not(:disabled):hover {
      background: var(--surface-hover-base);
    }
    .oc-session-nav__rename-actions button:disabled {
      opacity: 0.55;
    }
    .oc-session-nav__rename-actions .oc-session-nav__rename-save {
      border-color: var(--text-interactive-base, var(--border-strong-base));
      background: var(--text-interactive-base, var(--surface-hover-base));
      color: var(--text-on-interactive-base, var(--background-base));
    }
    .oc-session-nav__empty {
      color: var(--text-weak);
      padding: 8px 12px;
      font-size: 12px;
    }
  `
  return style
}
