import type { Config } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { parse } from "jsonc-parser"
import { useNavigate } from "@solidjs/router"
import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SettingsServerPicker } from "../settings-server-picker"
import {
  addMcpServerConfig,
  configuredMcpServers,
  mcpServerAvailableForProject,
  removeMcpServerConfig,
  setMcpServerEnabled,
  setProjectMcpServerAvailability,
  toggleMcpServerConfig,
  type McpInfo,
  type McpServer,
} from "./mcp-model"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const projectAvailabilityMemory = new Map<string, boolean>()
type ProjectConfigClient = {
  file: {
    read(input: { path: string }): Promise<{ content?: string; data?: { content?: string } }>
  }
}

export function SettingsMcpV2() {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const navigate = useNavigate()
  const [store, setStore] = createStore({
    input: "",
    error: "",
    saving: false,
    saved: "",
    optimisticMcp: undefined as McpInfo | undefined,
    optimisticBase: "",
    optimisticProjectMcp: {} as Record<string, McpInfo | undefined>,
    projectMcpLoaded: {} as Record<string, boolean | undefined>,
    projectMcpLoadRetry: 0,
    projectAvailability: {} as Record<string, boolean | undefined>,
    overlayDismissed: false,
    openAvailability: "",
    run: undefined as
      | undefined
      | {
          status: "running" | "success" | "error"
          title: string
          detail: string
          sessionID?: string
          serverName?: string
        },
  })
  const currentMcp = createMemo(() => serverSync().data.config.mcp as unknown as McpInfo | undefined)
  const mcp = createMemo(() => {
    if (store.optimisticMcp && mcpFingerprint(currentMcp()) === store.optimisticBase) return store.optimisticMcp
    return currentMcp()
  })
  createEffect(() => {
    if (!store.optimisticMcp) return
    if (mcpFingerprint(currentMcp()) === store.optimisticBase) return
    setStore({ optimisticMcp: undefined, optimisticBase: "" })
  })
  const servers = createMemo(() => configuredMcpServers(mcp()))
  const setupDirectory = createMemo(() => serverSync().data.path.directory || serverSync().data.path.worktree)
  const projects = createMemo(() =>
    Array.from(
      serverSync()
        .data.project.reduce((map, project) => {
          if (!project.worktree || isRootDirectory(project.worktree)) return map
          const key = projectListKey(project.worktree)
          if (map.has(key)) return map
          map.set(key, { directory: project.worktree, name: project.name || getFilename(project.worktree) || project.worktree })
          return map
        }, new Map<string, { directory: string; name: string }>())
        .values(),
    )
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
  const refreshedProjectConfigs = new Set<string>()
  const projectLoadFailures = new Map<string, number>()
  const projectRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const projectMcpWriteVersions = new Map<string, number>()
  onCleanup(() => {
    projectRetryTimers.forEach((timer) => clearTimeout(timer))
    projectRetryTimers.clear()
  })
  createEffect(() => {
    void serverSync().loadConfig().catch(() => undefined)
  })
  createEffect(() => {
    store.projectMcpLoadRetry
    projects().forEach((project) => {
      const key = projectMcpKey(project.directory)
      if (refreshedProjectConfigs.has(key)) return
      refreshedProjectConfigs.add(key)
      const writeVersion = projectMcpWriteVersions.get(key) ?? 0
      void loadProjectMcp(project.directory)
        .then((mcp) => {
          if ((projectMcpWriteVersions.get(key) ?? 0) !== writeVersion) return
          projectLoadFailures.delete(key)
          applyLoadedProjectMcp(project.directory, mcp)
        })
        .catch(() => {
          if ((projectMcpWriteVersions.get(key) ?? 0) !== writeVersion) return
          scheduleProjectMcpRetry(key)
        })
    })
  })

  const add = async () => {
    const input = store.input.trim()
    if (!input) {
      setStore("error", "Paste an https:// MCP URL or a local start command like npx -y @modelcontextprotocol/server-filesystem .")
      return
    }

    if (!setupDirectory()) {
      setStore("error", "Could not find a workspace directory for the MCP setup session")
      return
    }

    setStore({
      saving: true,
      error: "",
      saved: "",
      overlayDismissed: false,
      run: { status: "running", title: "Configuring MCP server", detail: "Starting MCP setup agent..." },
    })

    try {
      const sessionID = await serverSync().mcp.startSetupSession(input, setupDirectory())
      setStore("run", { status: "running", title: "Configuring MCP server", detail: "Agent started. Generating config and testing connection...", sessionID })
      const generated = await serverSync().mcp.starter(input)
      const name = uniqueName(generated.name, mcp())
      const config = addMcpServerConfig(mcp(), { ...generated.config, name })
      await updateConfig(config)
      const status = await serverSync().mcp.addAndConnect(name, generated.config)
      const detail = status?.status === "connected" ? `Connected and tested ${name}.` : `Added ${name}, but status is ${status?.status ?? "unknown"}.`
      setStore({
        input: "",
        saved: name,
        run: { status: status?.status === "connected" ? "success" : "error", title: status?.status === "connected" ? "MCP server ready" : "MCP server needs attention", detail, sessionID, serverName: name },
      })
    } catch (error) {
      setStore({
        error: error instanceof Error ? error.message : "Could not configure MCP server",
        run: { status: "error", title: "MCP setup failed", detail: error instanceof Error ? error.message : "Could not configure MCP server", sessionID: store.run?.sessionID },
      })
    } finally {
      setStore("saving", false)
    }
  }

  const remove = async (name: string) => {
    await serverSync().mcp.disconnect(name).catch(() => undefined)
    const config = removeMcpServerConfig(mcp(), name)
    await updateConfig(config)
  }

  const toggle = async (name: string, server: McpServer) => {
    const config = toggleMcpServerConfig(mcp(), name, server)
    await updateConfig(config)
    // Writing the config alone does not reconnect the running instance (MCP state is
    // built once per instance). Drive connect/disconnect explicitly so the toggle takes
    // effect immediately instead of only after an app restart.
    const directory = setupDirectory()
    if (directory) await serverSync().mcp.toggle(directory, name).catch(() => undefined)
  }

  const setAllAvailability = async (name: string, server: McpServer, enabled: boolean) => {
    const directories = projects().map((project) => project.directory)
    const previous = { ...store.projectAvailability }
    const previousMemory = projectAvailabilityMemorySnapshot(name, directories)
    const persisted: ReturnType<typeof applyProjectAvailabilityOptimistically>[] = []
    setStore("error", "")
    setProjectAvailabilityOverrides(name, directories, enabled)
    setProjectAvailabilityMemory(name, directories, enabled)
    const projectUpdates = directories.map((directory) => applyProjectAvailabilityOptimistically(name, server, directory, enabled))
    try {
      const results = await Promise.allSettled(
        projectUpdates.map(async (project) => {
          await serverSync().updateProjectConfig({ directory: project.directory, config: project.config })
          persisted.push(project)
        }),
      )
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
      if (failed) throw failed.reason
      await updateConfig(setMcpServerEnabled(mcp(), name, server, enabled))
      await syncProjectMcpRuntime(name, persisted.map((project) => project.directory), enabled)
    } catch (error) {
      await Promise.allSettled(
        persisted.map((project) =>
          serverSync().updateProjectConfig({ directory: project.directory, config: project.previousConfig }),
        ),
      )
      setStore("projectAvailability", previous)
      setStore("error", error instanceof Error ? error.message : "Could not update MCP project availability")
      restoreProjectAvailabilityMemory(name, previousMemory)
      projectUpdates.forEach((project) => project.rollback())
      throw error
    }
  }

  const setProjectAvailability = async (name: string, server: McpServer, directory: string, enabled: boolean) => {
    const previous = store.projectAvailability[projectAvailabilityKey(name, directory)]
    const previousMemory = projectAvailabilityMemory.get(projectAvailabilityKey(name, directory))
    setStore("error", "")
    setProjectAvailabilityOverride(name, directory, enabled)
    projectAvailabilityMemory.set(projectAvailabilityKey(name, directory), enabled)
    const project = applyProjectAvailabilityOptimistically(name, server, directory, enabled)
    try {
      await serverSync().updateProjectConfig({ directory, config: project.config })
    } catch (error) {
      setProjectAvailabilityOverride(name, directory, previous)
      setStore("error", error instanceof Error ? error.message : "Could not update MCP project availability")
      restoreProjectAvailabilityMemory(name, [[directory, previousMemory]])
      project.rollback()
      throw error
    }
    await syncProjectMcpRuntime(name, [directory], enabled)
  }

  async function syncProjectMcpRuntime(name: string, directories: string[], enabled: boolean) {
    const results = await Promise.allSettled(
      directories.map((directory) => serverSync().mcp.setAvailability(directory, name, enabled)),
    )
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
    if (failed) {
      setStore("error", failed.reason instanceof Error ? failed.reason.message : "Could not update MCP runtime state")
    }
  }

  function applyProjectAvailabilityOptimistically(name: string, server: McpServer, directory: string, enabled: boolean) {
    const [projectStore, setProjectStore] = serverSync().child(directory, { bootstrap: false, mcp: true })
    const previous = { ...projectStore.config }
    const previousMcp = projectMcp(directory)
    const previousConfig = { ...previous, mcp: previousMcp } as Config
    const config = setProjectMcpServerAvailability(previousMcp, name, server, enabled) as Config
    markProjectMcpChanged(directory)
    setOptimisticProjectMcp(directory, config.mcp as McpInfo | undefined)
    setProjectStore("config", (current) => ({ ...current, ...config }))
    return {
      directory,
      config,
      previousConfig,
      rollback: () => {
        markProjectMcpChanged(directory)
        setOptimisticProjectMcp(directory, previousMcp)
        setProjectStore("config", previous)
      },
    }
  }

  function markProjectMcpChanged(directory: string) {
    const key = projectMcpKey(directory)
    projectMcpWriteVersions.set(key, (projectMcpWriteVersions.get(key) ?? 0) + 1)
  }

  function setOptimisticProjectMcp(directory: string, mcp: McpInfo | undefined) {
    const key = projectMcpKey(directory)
    setStore("optimisticProjectMcp", (current) => ({ ...current, [key]: mcp }))
    setStore("projectMcpLoaded", (current) => ({ ...current, [key]: true }))
  }

  function applyLoadedProjectMcp(directory: string, mcp: McpInfo | undefined) {
    setOptimisticProjectMcp(directory, mcp)
    servers().forEach(([name]) => {
      if (typeof store.projectAvailability[projectAvailabilityKey(name, directory)] === "boolean") return
      const local = mcp?.[name]
      if (typeof local === "object" && local !== null && "enabled" in local && local.enabled === false) {
        setProjectAvailabilityOverride(name, directory, false)
        return
      }
      if (typeof local === "object" && local !== null && "type" in local && local.enabled !== false) {
        setProjectAvailabilityOverride(name, directory, true)
        return
      }
      setProjectAvailabilityOverride(name, directory, undefined)
    })
  }

  function scheduleProjectMcpRetry(key: string) {
    refreshedProjectConfigs.delete(key)
    if (projectRetryTimers.has(key)) return
    const failures = projectLoadFailures.get(key) ?? 0
    projectLoadFailures.set(key, failures + 1)
    projectRetryTimers.set(
      key,
      setTimeout(
        () => {
          projectRetryTimers.delete(key)
          setStore("projectMcpLoadRetry", (count) => count + 1)
        },
        Math.min(30_000, 1000 * 2 ** Math.min(failures, 4)),
      ),
    )
  }

  async function loadProjectMcp(directory: string) {
    const client = serverSDK().createClient({ directory, throwOnError: true })
    const local = await localProjectMcp(client, ".opencode/opencode.json")
    if (local) return local
    const jsonc = await localProjectMcp(client, ".opencode/opencode.jsonc")
    if (jsonc) return jsonc
    const config = await serverSync().project.loadConfig(directory)
    return config.mcp as unknown as McpInfo | undefined
  }

  function setProjectAvailabilityOverrides(name: string, directories: string[], enabled: boolean | undefined) {
    setStore("projectAvailability", (current) => ({
      ...current,
      ...Object.fromEntries(directories.map((directory) => [projectAvailabilityKey(name, directory), enabled])),
    }))
  }

  function setProjectAvailabilityOverride(name: string, directory: string, enabled: boolean | undefined) {
    setStore("projectAvailability", (current) => ({ ...current, [projectAvailabilityKey(name, directory)]: enabled }))
  }

  const updateConfig = async (config: Pick<Config, "mcp">) => {
    setStore({ optimisticMcp: config.mcp, optimisticBase: mcpFingerprint(currentMcp()) })
    try {
      await serverSync().updateConfig(config as Config)
    } catch (error) {
      setStore({ optimisticMcp: undefined, optimisticBase: "" })
      throw error
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">MCP</h2>
          <SettingsServerPicker />
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">Add MCP server</h3>
          <SettingsListV2>
            <SettingsRowV2
              title="URL or prompt"
              description="Paste a remote MCP endpoint URL or a local start prompt like an npx command. URLs become remote servers; everything else is split into a local command."
            >
              <div class="settings-v2-mcp-add">
                <TextareaV2
                  value={store.input}
                  onInput={(event) => setStore({ input: event.currentTarget.value, error: "", saved: "" })}
                  placeholder={'https://example.com/mcp\nnpx -y @modelcontextprotocol/server-filesystem .'}
                  rows={4}
                  spellcheck={false}
                />
                <ButtonV2 variant="neutral" onClick={add} disabled={store.saving || !store.input.trim()}>
                  {store.saving ? "Asking agent..." : "Add server"}
                </ButtonV2>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
          <Show when={store.error}>
            <p class="settings-v2-mcp-message settings-v2-mcp-message-error">{store.error}</p>
          </Show>
          <Show when={store.saved}>
            <p class="settings-v2-mcp-message">Added MCP server: {store.saved}</p>
          </Show>
        </div>

        <Show when={store.run && !store.overlayDismissed}>
          <div class="settings-v2-mcp-overlay" role="status" aria-live="polite">
            <div class="settings-v2-mcp-overlay-card" data-status={store.run?.status}>
              <div class="settings-v2-mcp-overlay-copy">
                <div class="settings-v2-mcp-overlay-title">{store.run?.title}</div>
                <p>{store.run?.detail}</p>
              </div>
              <div class="settings-v2-mcp-overlay-actions">
                <Show when={store.run?.sessionID}>
                  <ButtonV2 variant="neutral" onClick={() => openSession(setupDirectory(), store.run?.sessionID)}>
                    Open session
                  </ButtonV2>
                </Show>
                <ButtonV2 variant="ghost-muted" onClick={() => setStore("overlayDismissed", true)}>
                  Dismiss
                </ButtonV2>
              </div>
            </div>
          </div>
        </Show>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">Configured servers</h3>
          <Show when={servers().length > 0} fallback={<div class="text-13-regular text-text-weak">No MCP servers configured.</div>}>
            <SettingsListV2>
              <For each={servers()}>
                {([name, server]) => (
                  <div class="settings-v2-mcp-row">
                    <div class="settings-v2-mcp-copy">
                      <div class="settings-v2-mcp-name">{name}</div>
                      <div class="settings-v2-mcp-meta">
                        {server.type === "remote" ? server.url : server.command.join(" ")}
                      </div>
                    </div>
                    <div class="settings-v2-mcp-actions">
                      <ProjectAvailabilitySelect
                        name={name}
                        server={server}
                        label={() => availabilityLabel(name, server)}
                        open={store.openAvailability === name}
                        projects={projects()}
                        activeDirectory={serverSync().data.path.directory || serverSync().data.path.worktree}
                        onOpen={(open) => setStore("openAvailability", open ? name : "")}
                        projectSelected={(directory) => projectAvailable(name, server, directory)}
                        onAll={(enabled) => void setAllAvailability(name, server, enabled).catch(() => undefined)}
                        onProject={(directory, enabled) =>
                          void setProjectAvailability(name, server, directory, enabled).catch(() => undefined)
                        }
                      />
                      <ButtonV2 variant="ghost-muted" onClick={() => toggle(name, server)}>
                        {server.enabled === false ? "Enable" : "Disable"}
                      </ButtonV2>
                      <ButtonV2 variant="ghost-muted" onClick={() => remove(name)}>
                        Remove
                      </ButtonV2>
                    </div>
                  </div>
                )}
              </For>
            </SettingsListV2>
          </Show>
        </div>
      </div>
    </>
  )

  function openSession(directory: string | undefined, sessionID: string | undefined) {
    if (!directory || !sessionID) return
    navigate(`/${base64Encode(directory)}/session/${sessionID}`)
  }

  function projectMcp(directory: string) {
    const key = projectMcpKey(directory)
    if (Object.prototype.hasOwnProperty.call(store.optimisticProjectMcp, key)) {
      return store.optimisticProjectMcp[key]
    }
    return serverSync().child(directory, { bootstrap: false, mcp: true })[0].config.mcp as unknown as McpInfo | undefined
  }

  function projectAvailable(name: string, server: McpServer, directory: string) {
    const key = projectMcpKey(directory)
    const local = store.projectMcpLoaded[key] === true ? projectMcp(directory)?.[name] : undefined
    return mcpServerAvailableForProject({
      server,
      local,
      fresh: store.projectMcpLoaded[key] === true,
      override: store.projectAvailability[projectAvailabilityKey(name, directory)],
      remembered: projectAvailabilityMemory.get(projectAvailabilityKey(name, directory)),
    })
  }

  function allProjectsSelected(name: string, server: McpServer) {
    return projects().every((project) => projectAvailable(name, server, project.directory))
  }

  function selectedProjects(name: string, server: McpServer) {
    return projects().filter((project) => projectAvailable(name, server, project.directory))
  }

  function availabilityLabel(name: string, server: McpServer) {
    if (allProjectsSelected(name, server)) return "All projects"
    const selected = selectedProjects(name, server)
    if (selected.length === 0) return "No projects"
    if (selected.length === 1) return selected[0]!.name
    return `${selected.length}/${projects().length} projects`
  }
}

function ProjectAvailabilitySelect(props: {
  name: string
  server: McpServer
  label: () => string
  open: boolean
  projects: { directory: string; name: string }[]
  activeDirectory: string
  onOpen: (open: boolean) => void
  projectSelected: (directory: string) => boolean
  onAll: (enabled: boolean) => void | Promise<void>
  onProject: (directory: string, enabled: boolean) => void | Promise<void>
}) {
  const allProjectsSelected = () => props.projects.every((project) => props.projectSelected(project.directory))

  return (
    <div class="settings-v2-mcp-select">
      <button
        type="button"
        class="settings-v2-mcp-select-trigger"
        aria-label={`${props.name} project availability`}
        aria-haspopup="menu"
        aria-expanded={props.open}
        onClick={(event) => {
          event.currentTarget.scrollIntoView({ block: "center", inline: "nearest" })
          props.onOpen(!props.open)
        }}
      >
        <span>{props.label()}</span>
        <Icon name="chevron-down" size="small" />
      </button>
      <Show when={props.open}>
        <div class="settings-v2-mcp-select-content" role="menu">
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={allProjectsSelected()}
            class="settings-v2-mcp-select-item"
            data-checked={allProjectsSelected() ? "true" : undefined}
            onClick={() => props.onAll(!allProjectsSelected())}
          >
            <span class="settings-v2-mcp-select-check">
              <Icon name="check-small" size="small" />
            </span>
            <span class="settings-v2-mcp-select-label">All projects</span>
            <span class="settings-v2-mcp-select-state" data-state={allProjectsSelected() ? "selected" : "off"}>
              {allProjectsSelected() ? "Selected" : "Off"}
            </span>
          </button>
          <div class="settings-v2-mcp-select-separator" />
          <For each={props.projects}>
            {(project) => {
              const selected = () => props.projectSelected(project.directory)
              const active = () => sameDirectory(project.directory, props.activeDirectory)
              return (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-label={`${project.name} ${project.directory} ${selected() ? "selected" : "not selected"}${
                    active() ? " current project" : ""
                  }`}
                  title={project.directory}
                  aria-checked={selected()}
                  class="settings-v2-mcp-select-item"
                  data-active={active() ? "true" : undefined}
                  data-checked={selected() ? "true" : undefined}
                  onClick={() => props.onProject(project.directory, !selected())}
                >
                  <span class="settings-v2-mcp-select-check">
                    <Icon name="check-small" size="small" />
                  </span>
                  <span class="settings-v2-mcp-select-label">{project.name}</span>
                  <Show when={active()}>
                    <span class="settings-v2-mcp-select-current">current</span>
                  </Show>
                  <span class="settings-v2-mcp-select-state" data-state={selected() ? "selected" : "off"}>
                    {selected() ? "Selected" : "Off"}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

function uniqueName(base: string, servers: McpInfo | undefined) {
  if (!servers?.[base]) return base
  const next = Array.from({ length: 100 }, (_, index) => `${base}-${index + 2}`).find((name) => !servers[name])
  return next ?? `${base}-${Date.now()}`
}

function mcpFingerprint(mcp: McpInfo | undefined) {
  return JSON.stringify(mcp ?? {})
}

function isRootDirectory(directory: string) {
  const normalized = directory.replaceAll("\\", "/")
  return normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)
}

function sameDirectory(a: string, b: string) {
  return projectMcpKey(a) === projectMcpKey(b)
}

function projectAvailabilityKey(name: string, directory: string) {
  return `${name}:${projectMcpKey(directory)}`
}

function projectAvailabilityMemorySnapshot(name: string, directories: string[]) {
  return directories.map((directory) => [directory, projectAvailabilityMemory.get(projectAvailabilityKey(name, directory))] as const)
}

function setProjectAvailabilityMemory(name: string, directories: string[], enabled: boolean) {
  directories.forEach((directory) => projectAvailabilityMemory.set(projectAvailabilityKey(name, directory), enabled))
}

function restoreProjectAvailabilityMemory(name: string, entries: readonly (readonly [string, boolean | undefined])[]) {
  entries.forEach(([directory, enabled]) => {
    const key = projectAvailabilityKey(name, directory)
    if (typeof enabled === "boolean") {
      projectAvailabilityMemory.set(key, enabled)
      return
    }
    projectAvailabilityMemory.delete(key)
  })
}

function projectMcpKey(directory: string) {
  return directory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()
}

function projectListKey(directory: string) {
  const normalized = directory.replaceAll("\\", "/").replace(/\/+$/, "")
  if (/^[A-Za-z]:\//.test(normalized) || directory.includes("\\")) return normalized.toLowerCase()
  return normalized
}

async function localProjectMcp(client: ProjectConfigClient, file: string) {
  const response = await client.file.read({ path: file })
  const content = (response.content ?? response.data?.content)?.trim()
  if (!content) return undefined
  const data = parseLocalProjectConfig(content)
  if (!isRecord(data)) return undefined
  return isRecord(data.mcp) ? (data.mcp as McpInfo) : undefined
}

function parseLocalProjectConfig(content: string) {
  try {
    return parse(content) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
