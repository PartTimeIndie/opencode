import type { Config } from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useModels } from "@/context/models"
import { useLayout } from "@/context/layout"
import { projectDirectoryKey } from "@/utils/path-key"
import { SettingsModelTargetPickerV2 } from "../settings-model-target-picker"
import {
  completionPolicy,
  configuredAgents,
  filterToolCatalog,
  instructionPolicy,
  isCatalogToolVisible,
  materializeToolEntries,
  newAgentID,
  normalizeAgentID,
  normalizeToolCatalog,
  saveAgent,
  setAgentToolEntry,
  setAgentToolProjectScope,
  setAgentToolProjectPermission,
  projectPermission,
  systemPolicy,
  toolEntry,
  toolPolicy,
  type AgentChoice,
  type AgentCompletionPolicy,
  type AgentInstructionPolicy,
  type AgentSystemPolicy,
  type AgentToolEntry,
  type AgentToolPolicy,
  type ConfigurableAgent,
  type ToolCatalogEntry,
} from "./agents-model"
import "./settings-v2.css"

type Props = {
  initialAgent?: string
  createAgent?: boolean
  directory?: string
  onAgentSelect?: (agent: string) => void
}

type Draft = {
  id: string
  existing: boolean
  builtIn: boolean
  config: ConfigurableAgent
  description: string
  model: string
  variant: string
  mode: "primary" | "subagent" | "all"
  steps: string
  disabled: boolean
  system: AgentSystemPolicy
  instructions: AgentInstructionPolicy
  completion: AgentCompletionPolicy
}

const blankDraft = (id: string): Draft => ({
  id,
  existing: false,
  builtIn: false,
  config: { tools: { mode: "explicit", entries: {} } },
  description: "",
  model: "",
  variant: "",
  mode: "primary",
  steps: "20",
  disabled: false,
  system: { mode: "inherit" },
  instructions: { mode: "inherit" },
  completion: { mode: "inherit" },
})

const fromChoice = (choice: AgentChoice): Draft => {
  const agent = choice.config
  return {
    id: choice.id,
    existing: true,
    builtIn: choice.builtIn,
    config: { ...agent, tools: toolPolicy(agent) },
    description: agent.description ?? "",
    model: agent.model ?? "",
    variant: agent.variant ?? "",
    mode: agent.mode ?? "primary",
    steps: agent.steps ? String(agent.steps) : "",
    disabled: agent.disable === true,
    system: systemPolicy(agent),
    instructions: instructionPolicy(agent),
    completion: completionPolicy(agent),
  }
}

const lines = (value: string) => [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))]
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const rememberedToolPermissions = (agent: ConfigurableAgent) =>
  Object.fromEntries(
    Object.entries(toolPolicy(agent).entries ?? {}).flatMap(([id, entry]) =>
      entry.permission && entry.permission !== "deny" ? [[id, entry.permission]] : [],
    ),
  ) as Record<string, "allow" | "ask">

export const SettingsAgentsV2 = (props: Props) => {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const models = useModels()
  const layout = useLayout()
  const [store, setStore] = createStore({
    draft: blankDraft("new-agent"),
    selected: "",
    toolSearch: "",
    toolCatalog: [] as ToolCatalogEntry[],
    toolPermissionMemory: {} as Record<string, "allow" | "ask">,
    loadingTools: false,
    saving: false,
    saved: "",
    error: "",
  })

  const config = createMemo(() => serverSync().data.config as Config)
  const directory = createMemo(
    () => props.directory?.trim() || serverSync().data.path.directory || serverSync().data.path.worktree,
  )
  const sync = createMemo(() => serverSync().createDirSyncContext(directory()))
  const agents = createMemo(() => configuredAgents(config(), sync().data.agent))
  const selectedModel = createMemo(() => {
    const value = store.draft.model.startsWith("model:") ? store.draft.model.slice("model:".length) : store.draft.model
    if (value.startsWith("chain:")) return
    const separator = value.indexOf("/")
    if (separator <= 0 || separator === value.length - 1) return
    return models.find({ providerID: value.slice(0, separator), modelID: value.slice(separator + 1) })
  })
  const thinkingVariants = createMemo(() => Object.keys(selectedModel()?.variants ?? {}))
  const filteredTools = createMemo(() => filterToolCatalog(store.toolCatalog, store.toolSearch))
  const projects = createMemo(() => {
    const entries = new Map<string, { directory: string; name: string }>()
    for (const item of layout.projects.list()) entries.set(projectDirectoryKey(item.worktree), { directory: item.worktree, name: item.name || item.worktree })
    const active = directory()
    if (active && !entries.has(projectDirectoryKey(active))) entries.set(projectDirectoryKey(active), { directory: active, name: active })
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
  })
  const visibleToolCount = createMemo(() =>
    store.toolCatalog.filter((item) => isCatalogToolVisible(store.draft.config, item)).length,
  )

  const select = (id: string) => {
    const choice = agents().find((item) => item.id === id)
    if (!choice) return
    setStore({
      selected: id,
      draft: fromChoice(choice),
      toolPermissionMemory: rememberedToolPermissions(choice.config),
      saved: "",
      error: "",
    })
    props.onAgentSelect?.(id)
  }

  const create = () => {
    const id = newAgentID(config())
    setStore({ selected: "", draft: blankDraft(id), toolPermissionMemory: {}, saved: "", error: "" })
  }

  const duplicate = () => {
    const taken = new Set(agents().map((item) => item.id))
    const base = `${normalizeAgentID(store.draft.id) || "agent"}-copy`
    let id = base
    let index = 2
    while (taken.has(id)) id = `${base}-${index++}`
    setStore({
      selected: "",
      draft: {
        ...store.draft,
        id,
        existing: false,
        builtIn: false,
        config: clone(store.draft.config),
        system: clone(store.draft.system),
        instructions: clone(store.draft.instructions),
        completion: clone(store.draft.completion),
      },
      saved: "",
      error: "",
    })
  }

  let initialized = false
  createEffect(() => {
    if (initialized) return
    if (props.createAgent) {
      initialized = true
      create()
      return
    }
    const requested = props.initialAgent
    if (requested) {
      const choice = agents().find((item) => item.id === requested)
      if (!choice) return
      initialized = true
      setStore({
        selected: requested,
        draft: fromChoice(choice),
        toolPermissionMemory: rememberedToolPermissions(choice.config),
        saved: "",
        error: "",
      })
      return
    }
    const first = agents()[0]
    if (!first) return
    initialized = true
    select(first.id)
  })

  let toolRequest = 0
  createEffect(() => {
    const sdk = serverSDK()
    const target = directory()
    const request = ++toolRequest
    onCleanup(() => {
      if (toolRequest === request) toolRequest++
    })
    if (!target) {
      setStore({ toolCatalog: [], loadingTools: false })
      return
    }

    setStore({ toolCatalog: [], loadingTools: true })
    void sdk
      .client.tool.list({ directory: target })
      .catch(() => sdk.client.tool.ids({ directory: target }))
      .then((result) => {
        if (toolRequest !== request) return
        setStore("toolCatalog", normalizeToolCatalog(result.data))
      })
      .catch((error) => {
        if (toolRequest !== request) return
        setStore("error", error instanceof Error ? error.message : "Could not load tool catalog")
      })
      .finally(() => {
        if (toolRequest === request) setStore("loadingTools", false)
      })
  })

  // Snapshot every catalog tool's effective state when entering explicit mode so
  // toggling a single tool does not hide all the others (the explicit-mode fallback
  // in toolEntry treats every unlisted tool as hidden/denied).
  const materializeExplicitTools = (config: ConfigurableAgent): ConfigurableAgent =>
    materializeToolEntries(config, store.toolCatalog)

  const updateTool = (tool: string, entry: { visible?: boolean; permission?: "allow" | "ask" | "deny" }) => {
    const base = toolPolicy(store.draft.config).mode === "inherit" ? materializeExplicitTools(store.draft.config) : store.draft.config
    setStore("draft", "config", setAgentToolEntry(base, tool, entry))
  }
  const updateScope = (tool: string, scope: NonNullable<AgentToolEntry["scope"]>) => {
    const base = toolPolicy(store.draft.config).mode === "inherit" ? materializeExplicitTools(store.draft.config) : store.draft.config
    setStore("draft", "config", setAgentToolProjectScope(base, tool, scope))
  }
  const updateProjectPermission = (tool: string, project: string, action: "inherit" | "allow" | "ask" | "deny") => {
    const base = toolPolicy(store.draft.config).mode === "inherit" ? materializeExplicitTools(store.draft.config) : store.draft.config
    setStore("draft", "config", setAgentToolProjectPermission(base, tool, project, action))
  }

  const updateToolVisibility = (tool: string, visible: boolean) => {
    const entry = toolEntry(store.draft.config, tool)
    if (!visible) {
      if (entry.permission === "allow" || entry.permission === "ask") {
        setStore("toolPermissionMemory", tool, entry.permission)
      }
      updateTool(tool, { visible: false, permission: "deny" })
      return
    }
    updateTool(tool, {
      visible: true,
      permission: store.toolPermissionMemory[tool] ?? (entry.permission === "allow" || entry.permission === "ask" ? entry.permission : "ask"),
    })
  }

  const updateToolPermission = (tool: string, permission: "allow" | "ask" | "deny") => {
    if (permission === "deny") {
      updateToolVisibility(tool, false)
      return
    }
    setStore("toolPermissionMemory", tool, permission)
    updateTool(tool, { visible: true, permission })
  }

  const save = async () => {
    const id = normalizeAgentID(store.draft.id)
    if (!id) {
      setStore("error", "Agent ID is required and may contain letters, numbers, dashes, and underscores.")
      return
    }
    if (!store.draft.existing && agents().some((item) => item.id === id)) {
      setStore("error", `Agent ${id} already exists.`)
      return
    }
    const steps = store.draft.steps.trim() ? Number(store.draft.steps) : undefined
    if (steps !== undefined && (!Number.isInteger(steps) || steps < 1)) {
      setStore("error", "Maximum steps must be a positive whole number.")
      return
    }
    const systemPrompt = store.draft.system?.prompt?.trim() ?? ""
    const systemFiles = store.draft.system.files ?? []
    if (store.draft.system.mode !== "inherit" && !systemPrompt && systemFiles.length === 0) {
      setStore("error", `${store.draft.system.mode === "replace" ? "Replace" : "Append"} requires prompt text or at least one prompt file.`)
      return
    }

    const agent: ConfigurableAgent = {
      ...store.draft.config,
      description: store.draft.description.trim(),
      model: store.draft.model || undefined,
      variant: store.draft.variant || undefined,
      mode: store.draft.mode,
      steps,
      disable: store.draft.disabled,
      system: {
        mode: store.draft.system.mode,
        ...(store.draft.system.mode !== "inherit"
          ? {
              ...(systemPrompt ? { prompt: systemPrompt } : {}),
              ...(systemFiles.length ? { files: systemFiles } : {}),
            }
          : {}),
      },
      instructions: {
        mode: store.draft.instructions.mode,
        ...(store.draft.instructions.mode === "manual" ? { files: store.draft.instructions.files ?? [] } : {}),
      },
      tools: toolPolicy(store.draft.config),
      completion: {
        mode: store.draft.completion.mode,
        ...(store.draft.completion.mode === "custom"
          ? {
              ...(store.draft.completion.prompt?.trim() ? { prompt: store.draft.completion.prompt } : {}),
              ...((store.draft.completion.files?.length ?? 0) > 0 ? { files: store.draft.completion.files } : {}),
            }
          : {}),
      },
    }

    setStore({ saving: true, error: "", saved: "" })
    try {
      await serverSync().updateConfig(saveAgent(id, agent))
      const choice: AgentChoice = { id, config: agent, builtIn: store.draft.builtIn, hidden: agent.hidden === true }
      setStore({
        selected: id,
        draft: fromChoice(choice),
        toolPermissionMemory: rememberedToolPermissions(agent),
        saved: `Saved ${id}`,
      })
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : "Could not save agent")
    } finally {
      setStore("saving", false)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <div>
          <h2 class="settings-v2-tab-title">Agents</h2>
          <p>Create focused agents and control their prompt, context, tools, and completion review.</p>
          <Show when={props.directory?.trim()}>
            {(directory) => <p><strong>Project tool scope:</strong> <code>{directory()}</code></p>}
          </Show>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-agents" data-component="settings-agents">
        <Show when={store.error}><div class="settings-v2-agent-message settings-v2-agent-message--error">{store.error}</div></Show>
        <Show when={store.saved}><div class="settings-v2-agent-message settings-v2-agent-message--success">{store.saved}</div></Show>

        <div class="settings-v2-agent-picker-row">
          <label>
            <span>Agent</span>
            <select value={store.selected} onChange={(event) => select(event.currentTarget.value)} aria-label="Select agent">
              <Show when={!store.selected}><option value="">Unsaved new agent</option></Show>
              <For each={agents()}>{(item) => <option value={item.id}>{item.id}{item.builtIn ? " · built-in" : ""}</option>}</For>
            </select>
          </label>
          <ButtonV2 type="button" variant="neutral" size="small" onClick={duplicate}>Duplicate</ButtonV2>
          <ButtonV2 type="button" variant="neutral" size="small" icon="plus" onClick={create}>New</ButtonV2>
        </div>

        <section class="settings-v2-agent-editor">
          <div class="settings-v2-agent-grid">
            <label><span>Agent ID</span><TextInputV2 appearance="base" value={store.draft.id} disabled={store.draft.existing} onInput={(event) => setStore("draft", "id", event.currentTarget.value)} aria-label="Agent ID" /></label>
            <label><span>Mode</span><select value={store.draft.mode} onChange={(event) => setStore("draft", "mode", event.currentTarget.value as Draft["mode"])} aria-label="Agent mode"><option value="primary">Primary</option><option value="subagent">Subagent</option><option value="all">Primary and subagent</option></select></label>
          </div>

          <label><span>Description</span><TextInputV2 appearance="base" value={store.draft.description} onInput={(event) => setStore("draft", "description", event.currentTarget.value)} aria-label="Agent description" /></label>

          <div class="settings-v2-agent-runtime-grid">
            <label class="settings-v2-agent-model-control"><span>Model</span><SettingsModelTargetPickerV2 value={store.draft.model} label="Agent model" onChange={(value) => {
              setStore("draft", "model", value)
              setStore("draft", "variant", "")
            }} /></label>
            <label><span>Thinking effort</span><select value={store.draft.variant || "default"} disabled={!store.draft.model || thinkingVariants().length === 0} onChange={(event) => setStore("draft", "variant", event.currentTarget.value === "default" ? "" : event.currentTarget.value)} aria-label="Thinking effort">
              <option value="default">{thinkingVariants().length > 0 ? "Default" : "Default (no variants exposed)"}</option>
              <For each={thinkingVariants()}>{(variant) => <option value={variant}>{variant.slice(0, 1).toUpperCase() + variant.slice(1)}</option>}</For>
            </select></label>
            <label class="settings-v2-agent-steps"><span>Maximum steps</span><TextInputV2 type="number" appearance="base" min={1} value={store.draft.steps} onInput={(event) => setStore("draft", "steps", event.currentTarget.value)} aria-label="Maximum steps" /></label>
          </div>

          <PolicySection title="System prompt" description="Inherit the normal prompt, append agent-specific guidance, or replace it entirely.">
            <select value={store.draft.system.mode} onChange={(event) => setStore("draft", "system", "mode", event.currentTarget.value as AgentSystemPolicy["mode"])} aria-label="System prompt mode"><option value="inherit">Inherit</option><option value="append">Append</option><option value="replace">Replace</option></select>
            <Show when={store.draft.system.mode !== "inherit"}><>
              <TextareaV2 value={store.draft.system?.prompt ?? ""} onInput={(event) => setStore("draft", "system", "prompt", event.currentTarget.value)} placeholder="Required agent-specific system prompt" aria-label="System prompt" rows={6} />
              <TextareaV2 value={(store.draft.system.files ?? []).join("\n")} onInput={(event) => setStore("draft", "system", "files", lines(event.currentTarget.value))} placeholder="One .md, .txt, or .prompt path per line" aria-label="System prompt files" rows={3} />
              <small class="settings-v2-agent-field-note">Enter text, file paths, or both. Relative paths start at the project; explicit absolute shared paths are supported. Replace removes the normal agent prompt but keeps server-side safety rules.</small>
            </></Show>
          </PolicySection>

          <PolicySection title="Instruction and Markdown files" description="The default keeps the existing AGENTS.md discovery behavior. Manual mode includes only the listed Markdown or prompt files.">
            <select value={store.draft.instructions.mode} onChange={(event) => setStore("draft", "instructions", "mode", event.currentTarget.value as AgentInstructionPolicy["mode"])} aria-label="Instruction file mode"><option value="inherit">Inherit all discovered instructions</option><option value="manual">Choose manually</option></select>
            <Show when={store.draft.instructions.mode === "manual"}><>
              <TextareaV2 value={(store.draft.instructions.files ?? []).join("\n")} onInput={(event) => setStore("draft", "instructions", "files", lines(event.currentTarget.value))} placeholder="One .md, .txt, or .prompt path per line" aria-label="Instruction files" rows={4} />
              <small class="settings-v2-agent-field-note">Relative paths start at the project. Explicit absolute shared paths can point to the same files used by a bot container mount.</small>
            </></Show>
          </PolicySection>

          <PolicySection title="Tools available to the model" description={`${visibleToolCount()} of ${store.toolCatalog.length} resolved tools are visible. Hidden tools are removed from the model request.`}>
            <select value={toolPolicy(store.draft.config).mode} onChange={(event) => {
              const mode = event.currentTarget.value as AgentToolPolicy["mode"]
              if (mode === "explicit" && toolPolicy(store.draft.config).mode === "inherit") {
                const config = materializeExplicitTools(store.draft.config)
                setStore("draft", "config", config)
                return
              }
              setStore("draft", "config", "tools", { ...toolPolicy(store.draft.config), mode })
            }} aria-label="Tool list mode"><option value="inherit">Inherit current tool set</option><option value="explicit">Configure explicitly</option></select>
            <TextInputV2 type="search" appearance="base" value={store.toolSearch} onInput={(event) => setStore("toolSearch", event.currentTarget.value)} placeholder="Filter tools" aria-label="Filter tools" />
            <div class="settings-v2-agent-tool-list">
              <Show when={!store.loadingTools} fallback={<div class="settings-v2-agent-tool-empty">Loading tools...</div>}>
                <For each={filteredTools()} fallback={<div class="settings-v2-agent-tool-empty">No tools found.</div>}>
                  {(tool) => {
                    const entry = () => toolEntry(store.draft.config, tool.id)
                     return <div class="settings-v2-agent-tool-row" data-tool={tool.id}>
                      <div class="settings-v2-agent-tool-identity"><span><code>{tool.id}</code><Show when={tool.scope === "location"}><span class="settings-v2-agent-tool-badge">{tool.project || "Project"}</span></Show></span><Show when={tool.description}><small>{tool.description}</small></Show></div>
                       <div class="settings-v2-agent-tool-controls">
                        <Switch disabled={toolPolicy(store.draft.config).mode === "inherit"} checked={isCatalogToolVisible(store.draft.config, tool)} onChange={(visible) => updateToolVisibility(tool.id, visible)}>Visible</Switch>
                        <select disabled={toolPolicy(store.draft.config).mode === "inherit" || entry().visible === false} value={entry().permission ?? "ask"} onChange={(event) => updateToolPermission(tool.id, event.currentTarget.value as "allow" | "ask" | "deny")} aria-label={`${tool.id} permission`}><option value="ask">Ask before use</option><option value="allow">Allow</option><option value="deny">Deny</option></select>
                       </div>
                       <details class="settings-v2-agent-tool-scope">
                         <summary>Verfügbar in: {entry().scope?.mode === "projects" ? `Projekt (${entry().scope?.projects?.length ?? 0})` : "Global (auch neue Projekte)"}</summary>
                         <div class="settings-v2-agent-tool-scope-menu">
                           <label><input type="radio" name={`tool-scope-${tool.id}`} checked={entry().scope?.mode !== "projects"} onChange={() => updateScope(tool.id, { mode: "global" })} /> Global (auch neue Projekte)</label>
                           <label><input type="radio" name={`tool-scope-${tool.id}`} checked={entry().scope?.mode === "projects"} onChange={() => updateScope(tool.id, { mode: "projects", projects: projects().map((item) => item.directory) })} /> Projektspezifisch (neue Projekte aus)</label>
                           <Show when={entry().scope?.mode === "projects"}>
                             <For each={projects()}>{(project) => <div class="settings-v2-agent-tool-project" title={project.directory}>
                               <label><input type="checkbox" checked={entry().scope?.projects?.some((item) => projectDirectoryKey(item) === projectDirectoryKey(project.directory)) ?? false} onChange={(event) => {
                                 const next = (entry().scope?.projects ?? []).filter((item) => projectDirectoryKey(item) !== projectDirectoryKey(project.directory))
                                 updateScope(tool.id, { mode: "projects", projects: event.currentTarget.checked ? [...next, project.directory] : next })
                               }} /> {project.name}</label>
                               <select aria-label={`${tool.id} permission in ${project.name}`} value={projectPermission(entry(), project.directory)} onChange={(event) => updateProjectPermission(tool.id, project.directory, event.currentTarget.value as "inherit" | "allow" | "ask" | "deny")}>
                                 <option value="inherit">Inherit</option><option value="ask">Ask</option><option value="allow">Allow</option><option value="deny">Deny</option>
                               </select>
                             </div>}</For>
                           </Show>
                         </div>
                       </details>
                    </div>
                  }}
                </For>
              </Show>
            </div>
          </PolicySection>

          <PolicySection title="Completion evaluation" description="Use the global evaluator or a focused evaluator prompt for this agent.">
            <select value={store.draft.completion.mode} onChange={(event) => setStore("draft", "completion", "mode", event.currentTarget.value as AgentCompletionPolicy["mode"])} aria-label="Completion mode"><option value="inherit">Inherit</option><option value="custom">Custom evaluator</option></select>
            <Show when={store.draft.completion.mode === "custom"}><>
              <TextareaV2 value={store.draft.completion?.prompt ?? ""} onInput={(event) => setStore("draft", "completion", "prompt", event.currentTarget.value)} placeholder="Return done or incomplete according to…" aria-label="Completion prompt" rows={5} />
              <TextareaV2 value={(store.draft.completion.files ?? []).join("\n")} onInput={(event) => setStore("draft", "completion", "files", lines(event.currentTarget.value))} placeholder="One .md, .txt, or .prompt path per line" aria-label="Completion prompt files" rows={3} />
            </></Show>
          </PolicySection>

          <div class="settings-v2-agent-footer"><div><Switch checked={!store.draft.disabled} onChange={(enabled) => setStore("draft", "disabled", !enabled)}>Agent enabled</Switch><small>Start a new session after saving so old messages and tool results do not affect the test.</small></div><ButtonV2 type="button" variant="contrast" disabled={store.saving} onClick={() => void save()}>{store.saving ? "Saving..." : "Save agent"}</ButtonV2></div>
        </section>
      </div>
    </>
  )
}

function PolicySection(props: { title: string; description: string; children: unknown }) {
  return <section class="settings-v2-agent-policy"><div><h3>{props.title}</h3><p>{props.description}</p></div>{props.children as never}</section>
}
