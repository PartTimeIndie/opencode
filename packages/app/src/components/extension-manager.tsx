import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { projectDirectoryKey } from "@/utils/path-key"
import { useAppPluginRuntime } from "@/plugin/app-runtime"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"
import {
  extensionStatusText,
  extensionTargetText,
  filterAndSortExtensions,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionSortDirection,
  type ExtensionSortField,
} from "./extension-manager-model"
import "./extension-manager.css"

type ExtensionTab = "plugins" | "skills"

type ExtensionList = {
  plugins: ExtensionItem[]
  skills: ExtensionItem[]
}
type SkillScope = { mode: "global" | "projects"; projects?: string[] }

type InstallResult =
  | { ok: true; item: ExtensionItem }
  | { ok: false; code: "target_exists"; target: string; message?: string }
  | { ok: false; code: string; message?: string }

function currentDirectory(layout: ReturnType<typeof useLayout>) {
  const route = layout.route()
  if (route.type === "session") return route.dir
  if (route.type === "dir-new-session") return route.dir
  return layout.projects.list()[0]?.worktree
}

function authHeaders(conn: ReturnType<typeof useServer>["current"]) {
  if (!conn?.http.password) return undefined
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}`,
  }
}

function selectedPath(value: string | string[] | null) {
  if (Array.isArray(value)) return value[0]
  return value ?? undefined
}

function responseMessage(data: unknown) {
  if (!data || typeof data !== "object") return "Request failed"
  const message = "message" in data && typeof data.message === "string" ? data.message : undefined
  const error = "error" in data && typeof data.error === "string" ? data.error : undefined
  return message ?? error ?? "Request failed"
}

function skillAvailability(item: ExtensionItem, scope: SkillScope) {
  if (!item.path) return "Nicht verfügbar"
  if (scope.mode === "global") return "Global (auch neue Projekte)"
  return `Projekt (${scope.projects?.length ?? 0})`
}

export function ExtensionManager() {
  const command = useCommand()
  const dialog = useDialog()

  const openManager = (tab: ExtensionTab) => {
    dialog.show(() => <DialogExtensionManager initialTab={tab} />)
  }

  command.register("extension-manager", () => [
    {
      id: "plugins.manager",
      title: "Plugin Manager...",
      category: "Plugins",
      onSelect: () => openManager("plugins"),
    },
  ])

  return null
}

function DialogExtensionManager(props: { initialTab: ExtensionTab }) {
  const dialog = useDialog()
  return <ExtensionManagerContent initialTab={props.initialTab} onClose={() => dialog.close()} />
}

export function ExtensionManagerDockPane(props: { initialTab?: ExtensionTab }) {
  return <ExtensionManagerContent initialTab={props.initialTab ?? "plugins"} embedded />
}

function ExtensionManagerContent(props: { initialTab: ExtensionTab; embedded?: boolean; onClose?: () => void }) {
  const layout = useLayout()
  const platform = usePlatform()
  const server = useServer()
  const serverSync = useServerSync()
  const plugins = useAppPluginRuntime()
  const [data, setData] = createSignal<ExtensionList>({ plugins: [], skills: [] })
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal<string>()
  const [pendingScopes, setPendingScopes] = createSignal<Record<string, SkillScope>>({})
  const projects = () => {
    const known = new Map<string, { directory: string; name: string }>()
    for (const project of layout.projects.list()) known.set(projectDirectoryKey(project.worktree), { directory: project.worktree, name: project.name || project.worktree })
    const active = currentDirectory(layout)
    if (active && !known.has(projectDirectoryKey(active))) known.set(projectDirectoryKey(active), { directory: active, name: active })
    return [...known.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  const scopes = () => (serverSync().data.config as { skill_scopes?: Record<string, SkillScope> }).skill_scopes ?? {}
  const skillScope = (item: ExtensionItem): SkillScope => {
    if (!item.path) return { mode: "global" }
    const pending = pendingScopes()[projectDirectoryKey(item.path)]
    if (pending) return pending
    const saved = Object.entries(scopes()).find(([key]) => projectDirectoryKey(key) === projectDirectoryKey(item.path!))?.[1]
    if (saved) return saved
    if (item.scope !== "project") return { mode: "global" }
    const owner = projects().find((project) => projectDirectoryKey(item.path!).startsWith(`${projectDirectoryKey(project.directory)}/`))
    return { mode: "projects", projects: owner ? [owner.directory] : [] }
  }
  const updateSkillScope = async (item: ExtensionItem, scope: SkillScope) => {
    if (!item.path) return
    const key = projectDirectoryKey(item.path)
    const previous = skillScope(item)
    setPendingScopes((current) => ({ ...current, [key]: scope }))
    setBusy(item.id)
    try {
      await serverSync().updateConfig((current) => ({
        skill_scopes: {
          ...Object.fromEntries(Object.entries(current.skill_scopes ?? {}).filter(([key]) => projectDirectoryKey(key) !== projectDirectoryKey(item.path!))),
          [item.path!]: scope,
        },
      }))
      plugins.refresh()
      showToast({ title: "Skill-Verfügbarkeit gespeichert", description: item.name })
    } catch (error) {
      setPendingScopes((current) => ({ ...current, [key]: previous }))
      showToast({ title: "Skill-Verfügbarkeit konnte nicht gespeichert werden", description: responseMessage(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const endpoint = (path: string) => {
    if (!server.current) throw new Error("No server connection")
    return `${server.current.http.url.replace(/\/+$/, "")}${path}`
  }

  const fetchJson = async <T,>(path: string, init?: RequestInit) => {
    const response = await (platform.fetch ?? fetch)(endpoint(path), {
      ...init,
      headers: {
        ...authHeaders(server.current),
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    })
    const body = (await response.json().catch(() => undefined)) as T
    if (!response.ok && !(body && typeof body === "object" && "code" in body)) throw new Error(responseMessage(body))
    return body
  }

  const directory = () => {
    const dir = currentDirectory(layout)
    if (dir) return dir
    showToast({ title: "Open a project first" })
  }

  const refresh = async () => {
    const dir = directory()
    if (!dir) return
    setLoading(true)
    try {
      setData(await fetchJson<ExtensionList>(`/app/extensions?directory=${encodeURIComponent(dir)}`))
    } catch (error) {
      showToast({ title: "Manager konnte nicht geladen werden", description: responseMessage(error) })
    } finally {
      setLoading(false)
    }
  }

  const chooseFolder = async (kind: ExtensionKind) => {
    if (platform.platform !== "desktop") {
      showToast({ title: "Lokale Installation ist nur in der Desktop-App verfuegbar" })
      return
    }
    return selectedPath(
      await platform.openDirectoryPickerDialog({
        title: `${kind === "plugin" ? "Plugin" : "Skill"}-Ordner installieren`,
      }),
    )
  }

  const chooseArchive = async (kind: ExtensionKind) => {
    if (platform.platform !== "desktop" || !platform.openAttachmentPickerDialog) {
      showToast({ title: "Archiv-Installation ist nur in der Desktop-App verfuegbar" })
      return
    }
    let picked: string | undefined
    await platform.openAttachmentPickerDialog(
      {
        title: `${kind === "plugin" ? "Plugin" : "Skill"}-Archiv installieren`,
        extensions: ["zip", "tar", "gz", "tgz"],
      },
      async (file) => {
        picked = platform.getPathForFile?.(file)
      },
    )
    return picked
  }

  const install = async (kind: ExtensionKind, source: "folder" | "archive") => {
    const dir = directory()
    if (!dir) return
    const picked = source === "folder" ? await chooseFolder(kind) : await chooseArchive(kind)
    if (!picked) return
    const route = kind === "plugin" ? "/app/extensions/plugin/install" : "/app/extensions/skill/install"
    const run = (force = false) =>
      fetchJson<InstallResult>(route, {
        method: "POST",
        body: JSON.stringify({ directory: dir, source: picked, force }),
      })

    setBusy(`${kind}:${source}`)
    try {
      const result = await run()
      const finalResult =
        !result.ok &&
        result.code === "target_exists" &&
        "target" in result &&
        window.confirm(`${responseMessage(result)}\n\nUeberschreiben?`)
          ? await run(true)
          : result
      if (!finalResult.ok) {
        showToast({ title: "Install failed", description: responseMessage(finalResult) })
        return
      }

      plugins.refresh()
      await refresh()
      showToast({ title: `${kind === "plugin" ? "Plugin" : "Skill"} installed`, description: finalResult.item.name })
    } catch (error) {
      showToast({ title: "Install failed", description: responseMessage(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const uninstall = async (item: ExtensionItem) => {
    const dir = directory()
    if (!dir || !item.removable) return
    if (!window.confirm(`${item.name} deinstallieren?`)) return
    setBusy(item.id)
    try {
      if (item.kind === "plugin") {
        if (!item.spec) return
        await fetchJson("/app/extensions/plugin/uninstall", {
          method: "POST",
          body: JSON.stringify({ directory: dir, spec: item.spec, file: item.configFile ?? item.file, deleteFiles: true }),
        })
      } else {
        await fetchJson("/app/extensions/skill/uninstall", {
          method: "POST",
          body: JSON.stringify({ directory: dir, name: item.name, path: item.path }),
        })
      }
      plugins.refresh()
      await refresh()
      showToast({ title: `${item.kind === "plugin" ? "Plugin" : "Skill"} uninstalled`, description: item.name })
    } catch (error) {
      showToast({ title: "Uninstall failed", description: responseMessage(error) })
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => void refresh())

  const content = (
      <Tabs defaultValue={props.initialTab} class="flex flex-col min-h-0 h-full">
        <div class="flex items-center justify-between gap-3 px-5 pt-4 shrink-0">
          <Tabs.List class="bg-transparent border-b-0 gap-2 h-9">
            <Tabs.Trigger value="plugins">Plugins</Tabs.Trigger>
            <Tabs.Trigger value="skills">Skills</Tabs.Trigger>
          </Tabs.List>
          <Button variant="ghost" size="small" onClick={() => void refresh()} disabled={loading()}>
            Neu laden
          </Button>
        </div>

        <Tabs.Content value="plugins" class="min-h-0 flex-1 overflow-hidden">
          <ExtensionPanel
            kind="plugin"
            items={data().plugins}
            loading={loading()}
            busy={busy()}
            refresh={refresh}
            install={install}
            uninstall={uninstall}
            projects={projects()}
            skillScope={skillScope}
            updateSkillScope={updateSkillScope}
          />
        </Tabs.Content>
        <Tabs.Content value="skills" class="min-h-0 flex-1 overflow-hidden">
          <ExtensionPanel
            kind="skill"
            items={data().skills}
            loading={loading()}
            busy={busy()}
            refresh={refresh}
            install={install}
            uninstall={uninstall}
            projects={projects()}
            skillScope={skillScope}
            updateSkillScope={updateSkillScope}
          />
        </Tabs.Content>

        <Show when={props.onClose}>
          <div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-subtle-base shrink-0">
            <Button variant="ghost" size="large" onClick={() => props.onClose?.()}>
              Schliessen
            </Button>
          </div>
        </Show>
      </Tabs>
  )

  if (props.embedded) {
    return <div class="flex h-full min-h-0 flex-col overflow-hidden bg-background-stronger">{content}</div>
  }

  return (
    <Dialog
      title="Plugin Manager"
      size="x-large"
      fit
      class="w-[min(calc(100vw-32px),980px)] h-[min(calc(100vh-48px),720px)] min-h-0 overflow-hidden"
    >
      {content}
    </Dialog>
  )
}

function ExtensionPanel(props: {
  kind: ExtensionKind
  items: ExtensionItem[]
  loading: boolean
  busy?: string
  refresh: () => Promise<void>
  install: (kind: ExtensionKind, source: "folder" | "archive") => Promise<void>
  uninstall: (item: ExtensionItem) => Promise<void>
  projects: { directory: string; name: string }[]
  skillScope: (item: ExtensionItem) => SkillScope
  updateSkillScope: (item: ExtensionItem, scope: SkillScope) => Promise<void>
}) {
  const label = () => (props.kind === "plugin" ? "Plugin" : "Skill")
  const emptyMessage = () => {
    if (props.loading) return "Lade..."
    if (props.items.length > 0) return `Keine ${label()}s entsprechen den Filtern.`
    return `Keine ${label()}s gefunden.`
  }
  const [filter, setFilter] = createSignal("")
  const [sourceFilter, setSourceFilter] = createSignal<string>()
  const [removableFilter, setRemovableFilter] = createSignal<boolean>()
  const [sortBy, setSortBy] = createSignal<ExtensionSortField>("name")
  const [sortDirection, setSortDirection] = createSignal<ExtensionSortDirection>("asc")
  const sources = () => [...new Set(props.items.map((item) => item.source))].sort((a, b) => a.localeCompare(b))
  const sortOptions: { value: ExtensionSortField; label: string }[] = [
    { value: "name", label: "Name" },
    { value: "target", label: "Target" },
    { value: "source", label: "Quelle" },
    { value: "location", label: "Pfad / Spec" },
    ...(props.kind === "skill" ? [{ value: "availability" as const, label: "Verfügbarkeit" }] : []),
    { value: "status", label: "Status" },
  ]
  const visibleItems = createMemo(() =>
    filterAndSortExtensions(props.items, {
      query: filter(),
      source: sourceFilter(),
      removable: removableFilter(),
      sortBy: sortBy(),
      direction: sortDirection(),
      availableIn:
        props.kind === "skill" ? (item) => skillAvailability(item, props.skillScope(item)) : undefined,
    }),
  )

  return (
    <div class="flex flex-col min-h-0 h-full px-5 py-4 gap-4">
      <div class="flex flex-col gap-3 shrink-0">
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="small"
            icon="folder-add-left"
            data-action={`${props.kind}-install-folder`}
            onClick={() => void props.install(props.kind, "folder")}
            disabled={Boolean(props.busy)}
          >
            Ordner installieren...
          </Button>
          <Button
            size="small"
            icon="archive"
            data-action={`${props.kind}-install-archive`}
            onClick={() => void props.install(props.kind, "archive")}
            disabled={Boolean(props.busy)}
          >
            Archiv installieren...
          </Button>
        </div>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex min-w-[180px] flex-1 flex-col gap-1 text-11-medium text-text-weak">
            <span>Filtern</span>
            <TextInputV2
              type="search"
              appearance="base"
              class="w-full"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
              placeholder="Name, Quelle, Pfad oder Status"
              spellcheck={false}
              aria-label={`Filter ${label()}s`}
            />
          </label>
          <label class="flex min-w-[120px] flex-col gap-1 text-11-medium text-text-weak">
            <span>Quelle</span>
            <select
              class="h-7 rounded-md border border-border-subtle-base bg-surface-base px-2 text-12-regular text-text-base"
              aria-label="Quelle filtern"
              value={sourceFilter() ?? ""}
              onChange={(event) => setSourceFilter(event.currentTarget.value || undefined)}
            >
              <option value="">Alle Quellen</option>
              <For each={sources()}>{(source) => <option value={source}>{source}</option>}</For>
            </select>
          </label>
          <label class="flex min-w-[125px] flex-col gap-1 text-11-medium text-text-weak">
            <span>Status</span>
            <select
              class="h-7 rounded-md border border-border-subtle-base bg-surface-base px-2 text-12-regular text-text-base"
              aria-label="Status filtern"
              value={removableFilter()?.toString() ?? ""}
              onChange={(event) =>
                setRemovableFilter(event.currentTarget.value === "" ? undefined : event.currentTarget.value === "true")
              }
            >
              <option value="">Alle Status</option>
              <option value="true">Entfernbar</option>
              <option value="false">Geschützt</option>
            </select>
          </label>
          <label class="flex min-w-[125px] flex-col gap-1 text-11-medium text-text-weak">
            <span>Sortieren nach</span>
            <select
              class="h-7 rounded-md border border-border-subtle-base bg-surface-base px-2 text-12-regular text-text-base"
              aria-label="Sortieren nach"
              value={sortBy()}
              onChange={(event) => setSortBy(event.currentTarget.value as ExtensionSortField)}
            >
              <For each={sortOptions}>{(option) => <option value={option.value}>{option.label}</option>}</For>
            </select>
          </label>
          <Button
            size="small"
            variant="ghost"
            aria-label={sortDirection() === "asc" ? "Absteigend sortieren" : "Aufsteigend sortieren"}
            title="Sortierrichtung wechseln"
            onClick={() => setSortDirection((current) => (current === "asc" ? "desc" : "asc"))}
          >
            {sortDirection() === "asc" ? "A–Z" : "Z–A"}
          </Button>
        </div>
      </div>

      <div class="@container min-h-0 flex-1 overflow-auto rounded-md border border-border-subtle-base">
        <div class={props.kind === "skill" ? "hidden @[55rem]:grid grid-cols-[minmax(110px,1.2fr)_55px_65px_minmax(100px,1.2fr)_minmax(200px,1.6fr)_90px_135px] gap-3 px-3 py-2 text-11-medium text-text-weak bg-surface-base sticky top-0 z-1" : "hidden @[55rem]:grid grid-cols-[minmax(150px,1.2fr)_65px_75px_minmax(150px,1.4fr)_105px_180px] gap-3 px-3 py-2 text-11-medium text-text-weak bg-surface-base sticky top-0 z-1"}>
          <span>Name</span>
          <span>Target</span>
          <span>Quelle</span>
          <span>Pfad / Spec</span>
          <Show when={props.kind === "skill"}><span>Verfügbar in</span></Show>
          <span>Status</span>
          <span>Aktionen</span>
        </div>
        <Show
          when={!props.loading && visibleItems().length > 0}
          fallback={
            <div class="p-6 text-12-regular text-text-weak">
              {emptyMessage()}
              <Show when={!props.loading && props.items.length > 0}>
                <Button
                  size="small"
                  variant="ghost"
                  class="mt-2"
                  onClick={() => {
                    setFilter("")
                    setSourceFilter(undefined)
                    setRemovableFilter(undefined)
                  }}
                >
                  Filter zurücksetzen
                </Button>
              </Show>
            </div>
          }
        >
          <For each={visibleItems()}>
            {(item) => (
              <div
                class={props.kind === "skill" ? "flex flex-col items-stretch @[55rem]:grid @[55rem]:grid-cols-[minmax(110px,1.2fr)_55px_65px_minmax(100px,1.2fr)_minmax(200px,1.6fr)_90px_135px] gap-2 @[55rem]:gap-3 px-3 py-2 border-t border-border-subtle-base @[55rem]:items-center text-12-regular min-w-0" : "flex flex-col items-stretch @[55rem]:grid @[55rem]:grid-cols-[minmax(150px,1.2fr)_65px_75px_minmax(150px,1.4fr)_105px_180px] gap-2 @[55rem]:gap-3 px-3 py-2 border-t border-border-subtle-base @[55rem]:items-center text-12-regular min-w-0"}
                data-extension-id={item.id}
                data-extension-kind={item.kind}
              >
                <div class="min-w-0">
                  <div class="truncate text-text-strong font-medium">{item.name}</div>
                  <Show when={item.description}>
                    <div class="truncate text-text-weak text-11-regular">{item.description}</div>
                  </Show>
                </div>
                <span class="truncate text-text-base"><span class="@[55rem]:hidden text-text-weak">Target: </span>{extensionTargetText(item)}</span>
                <span class="truncate text-text-base"><span class="@[55rem]:hidden text-text-weak">Quelle: </span>{item.source}</span>
                <span class="truncate text-text-weak" title={item.path ?? item.spec ?? ""}>
                  <span class="@[55rem]:hidden">Pfad / Spec: </span>
                  {item.path ?? item.spec ?? "-"}
                </span>
                <Show when={props.kind === "skill"}>
                  <SkillScopeSelect item={item} projects={props.projects} scope={props.skillScope(item)} disabled={Boolean(props.busy) || !item.path} onChange={(scope) => props.updateSkillScope(item, scope)} />
                </Show>
                <span class="truncate text-text-weak" title={item.reason}>
                  <span class="@[55rem]:hidden">Status: </span>
                  {extensionStatusText(item)}
                </span>
                <div class="flex flex-wrap items-center justify-end gap-2 min-w-0">
                  <Button size="small" variant="ghost" disabled={Boolean(props.busy)} onClick={() => void props.refresh()}>
                    Neu laden
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    data-action="extension-remove"
                    disabled={!item.removable || props.busy === item.id}
                    onClick={() => void props.uninstall(item)}
                  >
                    Entfernen
                  </Button>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

function SkillScopeSelect(props: { item: ExtensionItem; projects: { directory: string; name: string }[]; scope: SkillScope; disabled: boolean; onChange: (scope: SkillScope) => Promise<void> }) {
  const selected = () => props.scope.projects ?? []
  return <details class="extension-skill-scope" data-skill-scope={props.item.name}>
    <summary aria-label={`${props.item.name} availability`}>{skillAvailability(props.item, props.scope)}</summary>
    <div class="extension-skill-scope-menu">
      <label><input type="radio" name={`${props.item.id}-scope`} disabled={props.disabled} checked={props.scope.mode === "global"} onChange={() => void props.onChange({ mode: "global" })} /> Global (auch neue Projekte)</label>
      <label><input type="radio" name={`${props.item.id}-scope`} disabled={props.disabled} checked={props.scope.mode === "projects"} onChange={() => void props.onChange({ mode: "projects", projects: props.projects.map((item) => item.directory) })} /> Projektspezifisch (neue Projekte aus)</label>
      <Show when={props.scope.mode === "projects"}><For each={props.projects}>{(project) => <label title={project.directory}>
        <input type="checkbox" disabled={props.disabled} checked={selected().some((item) => projectDirectoryKey(item) === projectDirectoryKey(project.directory))} onChange={(event) => {
          const next = selected().filter((item) => projectDirectoryKey(item) !== projectDirectoryKey(project.directory))
          void props.onChange({ mode: "projects", projects: event.currentTarget.checked ? [...next, project.directory] : next })
        }} /> {project.name}
      </label>}</For></Show>
    </div>
  </details>
}
