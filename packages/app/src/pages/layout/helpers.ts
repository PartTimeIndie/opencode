import { getFilename } from "@opencode-ai/core/util/path"
import { type Project, type Session, type SessionStatus } from "@opencode-ai/sdk/v2/client"
import { directoryKey, pathKey, projectWorktreeKey } from "@/utils/path-key"
import type { ServerConnection } from "@/context/server"

type SessionStore = {
  session?: Session[]
  path: { directory: string }
  session_status?: Record<string, SessionStatus | undefined>
}

const activeSessionSortTimes = new Map<string, number>()

export function resumedProjectDirectories(input: {
  current?: string
  projects: readonly string[]
  questions: readonly string[]
  loaded: (directory: string) => boolean
}) {
  const directories = [input.current, ...input.questions, ...input.projects.filter(input.loaded)]
  return directories.filter(
    (directory, index): directory is string =>
      !!directory && directories.findIndex((item) => item && directoryKey(item) === directoryKey(directory)) === index,
  )
}

function sessionUpdated(session: Session) {
  return session.time.updated ?? session.time.created
}

function activeSessionKey(store: SessionStore, session: Session) {
  return `${directoryKey(session.directory || store.path.directory)}\n${session.id}`
}

function sessionSortTime(store: SessionStore, session: Session, now: number) {
  const key = activeSessionKey(store, session)
  const status = store.session_status?.[session.id]
  if (status?.type && status.type !== "idle") {
    const existing = activeSessionSortTimes.get(key)
    if (existing !== undefined) return existing
    const started = Math.max(sessionUpdated(session), now)
    activeSessionSortTimes.set(key, started)
    return started
  }
  activeSessionSortTimes.delete(key)
  return sessionUpdated(session)
}

function compareSessions(aStore: SessionStore, a: Session, bStore: SessionStore, b: Session, now: number) {
  const aUpdated = sessionSortTime(aStore, a, now)
  const bUpdated = sessionSortTime(bStore, b, now)
  return bUpdated - aUpdated || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
}

function sortSessions(store: SessionStore, now: number) {
  return (a: Session, b: Session) => {
    return compareSessions(store, a, store, b, now)
  }
}

const isRootVisibleSession = (session: Session, directory: string) =>
  !!session?.id &&
  !!session.time &&
  directoryKey(session.directory || directory) === directoryKey(directory) &&
  !session.parentID &&
  !session.time.archived

export const roots = (store: SessionStore) =>
  (store.session ?? []).filter((session) => isRootVisibleSession(session, store.path.directory))

export const sortedRootSessions = (store: SessionStore, now: number) => roots(store).sort(sortSessions(store, now))

export const visibleRootSessions = (
  directories: readonly string[],
  child: (directory: string, options: { bootstrap: false }) => { 0: SessionStore },
  now: number,
) =>
  directories.flatMap((directory) => sortedRootSessions(child(directory, { bootstrap: false })[0], now))

export const latestRootSession = (stores: SessionStore[], now: number) =>
  stores
    .flatMap((store) => roots(store).map((session) => ({ store, session })))
    .sort((a, b) => compareSessions(a.store, a.session, b.store, b.session, now))[0]?.session

export function hasProjectPermissions<T>(
  request: Record<string, T[] | undefined> | undefined,
  include: (item: T) => boolean = () => true,
) {
  return Object.values(request ?? {}).some((list) => list?.some(include))
}

export const childSessionOnPath = (sessions: Session[] | undefined, rootID: string, activeID?: string) => {
  if (!activeID || activeID === rootID) return
  const map = new Map((sessions ?? []).map((session) => [session.id, session]))
  let id = activeID

  while (id) {
    const session = map.get(id)
    if (!session?.parentID) return
    if (session.parentID === rootID) return session
    id = session.parentID
  }
}

export const displayName = (project: { name?: string; worktree: string }) =>
  project.name || getFilename(project.worktree) || project.worktree

export type HomeProjectSelection = { server: ServerConnection.Key; directory?: string }
type HomeProject = Partial<Project> & { worktree: string; expanded: boolean }

export function projectInventory<T extends Partial<Project> & { worktree: string }>(projects: readonly T[]) {
  const byPath = new Map<string, T>()
  for (const project of projects) {
    const key = projectWorktreeKey(project.worktree)
    const previous = byPath.get(key)
    if (!previous || (project.time?.updated ?? 0) > (previous.time?.updated ?? 0)) byPath.set(key, project)
  }
  return [...byPath.values()]
}

export function homeProjectsFor(
  persisted: HomeProject[],
  api: Array<Partial<Project> & { worktree?: string }>,
): HomeProject[] {
  if (persisted.length > 0) return persisted
  return projectInventory(api.flatMap((project): HomeProject[] => {
    if (!project.worktree) return []
    return [{ ...project, worktree: project.worktree, expanded: true }]
  }))
}

export function projectsForDirectorySelection(
  persisted: HomeProject[],
  api: Array<Partial<Project> & { worktree?: string }>,
  directory: string,
) {
  const projects = homeProjectsFor(persisted, api)
  const key = pathKey(directory)
  if (
    projects.some(
      (project) =>
        pathKey(project.worktree) === key || project.sandboxes?.some((sandbox) => pathKey(sandbox) === key),
    )
  )
    return projects
  return [{ worktree: directory, expanded: true }, ...projects]
}

export function selectHomeProjectSelection(
  current: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  directory: string,
  projects: { worktree: string }[],
) {
  if (!projects.some((project) => pathKey(project.worktree) === pathKey(directory))) return
  if (current?.server === server && current.directory === directory) return current
  return { server, directory }
}

export function activateHomeProjectSelection(
  current: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  directory: string,
  projects: { worktree: string }[],
  store: { open: (directory: string) => void; touch: (directory: string) => void },
) {
  const next = selectHomeProjectSelection(current, server, directory, projects)
  if (!next) return
  store.open(directory)
  store.touch(directory)
  return next
}

export function closeHomeProject(
  selected: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  projects: { close: (directory: string) => void },
  directory: string,
) {
  projects.close(directory)
  if (selected?.server === server && selected.directory === directory) return { server }
  return selected
}

export function homeProjectNavigation(active: ServerConnection.Key, server: ServerConnection.Key, href: string) {
  if (active === server) return { href }
  return { server, href }
}

export function homeProjectDirectories(result: string | string[] | null) {
  if (!result) return []
  return Array.isArray(result) ? result : [result]
}

export function homeSessionServerStatus(active: boolean, status: () => { working: boolean; tint?: string }) {
  if (!active) return { working: false, tint: undefined }
  return status()
}

const OPENCODE_PROJECT_ID = "4b0ea68d7af9a6031a7ffda7ad66e0cb83315750"
const OPENCODE_PROJECT_AVATAR = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" color="white"><path d="M320 224V352H192V224H320Z" fill="currentColor" opacity=".45"/><path fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="currentColor"/></svg>`,
)}`

export function getProjectAvatarSource(
  id?: string,
  icon?: { color?: string; url?: string; override?: string; generated?: string },
) {
  if (icon?.override) return icon.override
  if (id === OPENCODE_PROJECT_ID) return OPENCODE_PROJECT_AVATAR
  if (icon?.url && !icon.color) return icon.url
  return icon?.generated
}

export function getProjectAvatarMonochrome(id?: string, icon?: { override?: string }) {
  return id === OPENCODE_PROJECT_ID && !icon?.override
}

export function projectForSession<T extends { id?: string; worktree: string; sandboxes?: string[] }>(
  session: Session,
  projects: T[],
  byID: Map<string, T> = new Map(projects.flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  byDirectory?: Map<string, T>,
) {
  const direct = byID.get(session.projectID)
  if (direct) return direct
  const directory = pathKey(session.directory)
  if (byDirectory) return byDirectory.get(directory)
  return projects.find(
    (project) =>
      pathKey(project.worktree) === directory || project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
  )
}

export const errorMessage = (err: unknown, fallback: string) => {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}

export const effectiveWorkspaceOrder = (local: string, dirs: string[], persisted?: string[]) => {
  const root = pathKey(local)
  const live = new Map<string, string>()

  for (const dir of dirs) {
    const key = pathKey(dir)
    if (key === root) continue
    if (!live.has(key)) live.set(key, dir)
  }

  if (!persisted?.length) return [local, ...live.values()]

  const result = [local]
  for (const dir of persisted) {
    const key = pathKey(dir)
    if (key === root) continue
    const match = live.get(key)
    if (!match) continue
    result.push(match)
    live.delete(key)
  }

  return [...result, ...live.values()]
}
