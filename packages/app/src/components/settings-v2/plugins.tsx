import { For, Index, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch as SwitchV2 } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useCommand } from "@/context/command"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { SettingsModelTargetPickerV2 } from "@/components/settings-model-target-picker"
import { SettingsModelPickerV2 } from "@/components/settings-model-picker"
import { SettingsVoicePickerV2 } from "@/components/settings-voice-picker"
import { subscribeAppPluginSettingsChanges } from "@/plugin/app-plugin-settings-events"
import {
  modelTargetSettingsField,
  useAppPluginRuntime,
  type SettingsField,
  type SettingsItem,
} from "@/plugin/app-runtime"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { SettingsContributionV2 } from "./parts/contribution"
import { pluginSettingsFieldAction, pluginSettingsSectionAction, pluginToolbarAction, SETTINGS_ANCHOR_EVENT } from "./search-index"
import { createPluginSettingItem, pluginSettingsLeafFields, readPluginSetting, updatePluginSetting } from "./plugin-setting-values"
import { createPluginSettingsRevisions } from "./plugin-settings-revisions"
import { createSkillBrowser } from "./skill-browser"
import { DelegationSettingsPanel } from "./delegation"
import "./settings-v2.css"

export function SettingsSkillsPluginsV2() {
  const command = useCommand()
  const plugins = useAppPluginRuntime()
  const revisions = createPluginSettingsRevisions()

  onMount(() => {
    const unsubscribe = subscribeAppPluginSettingsChanges((pluginID) => revisions.bump(pluginID))
    onCleanup(unsubscribe)
  })

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-plugins-header">
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">Skills &amp; Plugins</h2>
          <ButtonV2
            data-action="settings-plugin-manager"
            size="normal"
            variant="neutral"
            onClick={() => command.trigger("plugins.manager")}
          >
            Plugin Manager
          </ButtonV2>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <PluginToolbarSettingsPanel />
        <SkillPolicySettingsPanel />
        <DelegationSettingsPanel />
        <Show when={plugins.settingsItems().length > 0}>
          <For each={plugins.settingsItems()}>
            {(item) => <PluginSettingsPanel item={item} revision={revisions.get(item.pluginID ?? item.id)} />}
          </For>
        </Show>
      </div>
    </>
  )
}

type EffectiveSkillPolicy = {
  visible: boolean
  invocation: string
  sources: { visible: string; invocation: string }
}

type SkillPolicyRow = {
  name: string
  description?: string
  effective?: EffectiveSkillPolicy
}

const invocationOptions = [
  { value: "allow" as const, label: "Allow" },
  { value: "ask" as const, label: "Ask" },
  { value: "manual" as const, label: "Manual" },
  { value: "deny" as const, label: "Deny" },
]

const sourceLabel = (source: string | undefined) => {
  switch (source) {
    case "agent-entry":
      return "agent override"
    case "global-entry":
      return "global setting"
    case "legacy-manual":
      return "legacy manual list"
    default:
      return "skill metadata"
  }
}

/**
 * Global skill invocation/visibility defaults. Catalog visibility and
 * invocation consent are independent fields: hiding a skill never blocks it,
 * and invocation modes never change toolbar icon visibility.
 */
export function SkillPolicySettingsPanel() {
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [search, setSearch] = createSignal("")
  const [pending, setPending] = createSignal("")
  const browser = createSkillBrowser<SkillPolicyRow>(async () => {
    const directory = layout.projects.list()[0]?.worktree
    if (!directory) throw new Error("Open a project to manage its available skills.")
    const response = await serverSDK().client.v2.skill.list({ location: { directory } })
    if (response.error || !response.data) throw new Error("Skills could not be loaded. Try again.")
    return response.data.data ?? []
  })
  const skills = browser.items
  const expanded = browser.expanded
  const refresh = browser.refresh
  const reveal = browser.reveal
  onCleanup(browser.dispose)
  onMount(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === "settings-skill-policy") reveal()
    }
    window.addEventListener(SETTINGS_ANCHOR_EVENT, listener)
    onCleanup(() => window.removeEventListener(SETTINGS_ANCHOR_EVENT, listener))
  })

  const apply = async (
    name: string,
    entry: { visible?: boolean | null; invocation?: "allow" | "ask" | "manual" | "deny" | null },
  ) => {
    setPending(name)
    try {
      await serverSync().updateConfig({ skill_policy: { global: { [name]: entry } } } as never)
      showToast({ title: "Skill policy saved", description: name })
      refresh()
    } catch (error) {
      showToast({
        title: "Skill policy could not be saved",
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setPending("")
    }
  }

  const filtered = createMemo(() => {
    const query = search().trim().toLowerCase()
    const all = skills() ?? []
    if (!query) return all
    return all.filter(
      (item) => item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query),
    )
  })

  return (
    <div class="settings-v2-section" data-action="settings-skill-policy" data-skill-policy-settings>
      <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 class="settings-v2-section-title">Skills</h3>
          <p class="text-12-regular text-text-weak mt-1">
            Visibility controls the model catalog only. Invocation decides how a skill may load; hidden skills stay
            selectable in the slash menu.
          </p>
        </div>
        <ButtonV2
          type="button"
          size="small"
          variant="neutral"
          class="shrink-0 whitespace-nowrap"
          aria-expanded={expanded()}
          onClick={() => expanded() ? browser.collapse() : reveal()}
        >
          {expanded() ? "Hide skills" : "Browse skills"}
        </ButtonV2>
      </div>
      <Show when={expanded()}>
        <TextInputV2
          type="search"
          appearance="base"
          class="max-w-full"
          placeholder="Filter skills"
          aria-label="Filter skills"
          value={search()}
          onInput={(event) => setSearch(event.currentTarget.value)}
        />
      <Show when={browser.error()}>
        <div role="alert" class="text-12-regular text-text-weak">
          {browser.error()}
          <ButtonV2 size="small" variant="neutral" onClick={() => void refresh()}>Try again</ButtonV2>
        </div>
      </Show>
      <Show when={!browser.error()}>
      <Show when={skills() !== undefined} fallback={<p class="text-12-regular text-text-weak">Loading skills…</p>}>
        <SettingsListV2>
          <For each={filtered()}>
            {(item) => {
              const effective = () => item.effective
              return (
                <SettingsRowV2
                  title={`/${item.name}`}
                  description={effective() ? `${item.description ?? ""} · catalog: ${effective()?.visible ? "shown" : "hidden"} (${sourceLabel(effective()?.sources.visible)}) · invocation: ${effective()?.invocation} (${sourceLabel(effective()?.sources.invocation)})` : `${item.description ?? ""} · effective policy unavailable`}
                >
                  <div class="flex items-center gap-2" data-skill-policy-row={item.name}>
                    <SwitchV2
                      checked={effective()?.visible ?? false}
                      aria-label={`Show ${item.name} in the model catalog`}
                      disabled={!effective() || pending() === item.name}
                      onChange={(value) => void apply(item.name, { visible: value })}
                    />
                    <SelectV2
                      appearance="inline"
                      options={invocationOptions}
                      current={invocationOptions.find((option) => option.value === effective()?.invocation)}
                      value={(option) => option.value}
                      label={(option) => option.label}
                      placement="bottom-end"
                      gutter={6}
                      disabled={!effective() || pending() === item.name}
                      onSelect={(option) => option && void apply(item.name, { invocation: option.value })}
                    />
                    <ButtonV2
                      size="small"
                      variant="ghost-muted"
                      disabled={pending() === item.name}
                      onClick={() => void apply(item.name, { visible: null, invocation: null })}
                    >
                      Reset
                    </ButtonV2>
                  </div>
                </SettingsRowV2>
              )
            }}
          </For>
        </SettingsListV2>
        <Show when={filtered().length === 0}>
          <p class="text-12-regular text-text-weak">No matching skills.</p>
        </Show>
      </Show>
      </Show>
      </Show>
    </div>
  )
}

type PluginToolbarScope = { id: string; label: string; description?: string; directory?: string }

function PluginToolbarSettingsPanel() {
  const layout = useLayout()
  const server = useServer()
  const plugins = useAppPluginRuntime()
  const [scope, setScope] = createSignal("global")
  const scopes = createMemo<PluginToolbarScope[]>(() => [
    { id: "global", label: "All projects (global)" },
    ...layout.projects.list().map((project) => ({
      id: `${server.key}:${project.worktree}`,
      label: project.name || project.worktree,
      description: project.worktree,
      directory: project.worktree,
    })),
  ])
  const selected = () => scopes().find((item) => item.id === scope()) ?? scopes()[0]
  const ready = () => plugins.toolbarVisibilityReady() && plugins.toolbarOrderReady()
  const overrides = [
    { value: "inherit" as const, label: "Global" },
    { value: "show" as const, label: "On" },
    { value: "hide" as const, label: "Off" },
  ]

  return (
    <div class="settings-v2-section" data-action="settings-plugin-toolbar" data-plugin-toolbar-settings>
      <div class="flex flex-col gap-3">
        <div>
          <h3 class="settings-v2-section-title">Plugin toolbar</h3>
          <p class="text-12-regular text-text-weak mt-1">
            Choose which plugin icons appear globally or in one project.
          </p>
        </div>
        <Show when={ready()} fallback={<p class="text-12-regular text-text-weak">Loading toolbar preferences…</p>}>
          <div class="flex flex-wrap items-center gap-2">
            <SelectV2
              appearance="inline"
              options={scopes()}
              current={selected()}
              value={(item) => item.id}
              label={(item) => item.label}
              placement="bottom-end"
              gutter={6}
              onSelect={(item) => item && setScope(item.id)}
            />
            <Show when={selected()?.directory}>
              {(directory) => (
                <ButtonV2
                  size="normal"
                  variant="neutral"
                  onClick={() => plugins.resetToolbarItemOverrides(directory())}
                >
                  Reset overrides
                </ButtonV2>
              )}
            </Show>
          </div>
        </Show>
      </div>
      <Show when={ready()}>
        <SettingsListV2>
          <For each={plugins.toolbarItemsForDirectory(selected()?.directory)}>
            {(item) => {
              const plugin = () => item.pluginID ?? item.id.split("/")[0]
              const directory = () => selected()?.directory
              const effective = () => plugins.toolbarItemVisible(item.id, directory())
              const override = () => (directory() ? plugins.toolbarItemOverride(item.id, directory()!) : undefined)
              return (
                <SettingsRowV2
                  action={pluginToolbarAction(item.id)}
                  title={item.title}
                  description={`${plugin()} · ${effective() ? "Visible" : "Hidden"}`}
                >
                  <div class="settings-v2-plugin-toolbar-controls">
                    <div class="settings-v2-plugin-toolbar-order">
                      <IconButtonV2
                        type="button"
                        size="small"
                        variant="ghost-muted"
                        aria-label={`Move ${item.title} up`}
                        data-action="move-plugin-toolbar-item-up"
                        data-plugin-toolbar-item-id={item.id}
                        disabled={!plugins.toolbarItemCanMove(item.id, "up", directory())}
                        icon={<Icon name="arrow-up" size="small" />}
                        onClick={() => plugins.moveToolbarItem(item.id, "up", directory())}
                      />
                      <IconButtonV2
                        type="button"
                        size="small"
                        variant="ghost-muted"
                        class="settings-v2-plugin-toolbar-move-down"
                        aria-label={`Move ${item.title} down`}
                        data-action="move-plugin-toolbar-item-down"
                        data-plugin-toolbar-item-id={item.id}
                        disabled={!plugins.toolbarItemCanMove(item.id, "down", directory())}
                        icon={<Icon name="arrow-up" size="small" />}
                        onClick={() => plugins.moveToolbarItem(item.id, "down", directory())}
                      />
                    </div>
                    <Show
                      when={directory()}
                      fallback={
                        <SwitchV2
                          checked={plugins.globalToolbarItemVisible(item.id)}
                          onChange={(value) => plugins.setGlobalToolbarItemVisible(item.id, value)}
                        />
                      }
                    >
                      {(project) => (
                        <SelectV2
                          appearance="inline"
                          options={overrides}
                          current={overrides.find((item) => item.value === override())}
                          value={(item) => item.value}
                          label={(item) => item.label}
                          placement="bottom-end"
                          gutter={6}
                          onSelect={(value) => value && plugins.setToolbarItemOverride(item.id, project(), value.value)}
                        />
                      )}
                    </Show>
                  </div>
                </SettingsRowV2>
              )
            }}
          </For>
        </SettingsListV2>
      </Show>
    </div>
  )
}

function PluginSettingsPanel(props: { item: SettingsItem; revision: number }) {
  return (
    <For each={props.item.sections}>
      {(section, sectionIndex) => (
        <SettingsContributionV2
          id={pluginSettingsSectionAction(props.item.pluginID ?? props.item.id, sectionIndex())}
          kind="plugin"
          title={`${props.item.title} · ${section.title}`}
          pluginID={props.item.pluginID ?? props.item.id}
          revision={props.revision}
        >
          <For each={section.actions ?? []}>
            {(action) => {
              const [pending, setPending] = createSignal(false)
              return <ButtonV2 type="button" variant="ghost-muted" size="small" disabled={pending()} onClick={() => {
                setPending(true)
                void Promise.resolve().then(() => action.run())
                  .catch((error) => showToast({ title: "Plugin action failed", description: error instanceof Error ? error.message : String(error) }))
                  .finally(() => setPending(false))
              }}>{action.label}</ButtonV2>
            }}
          </For>
          <SettingsListV2>
            <For each={section.fields}>
              {(field) => (
                <PluginSettingsField
                  item={props.item}
                  field={field}
                  revision={props.revision}
                  sectionIndex={sectionIndex()}
                />
              )}
            </For>
          </SettingsListV2>
        </SettingsContributionV2>
      )}
    </For>
  )
}

/** Overlay fields are layout containers and never own a stored value. */
function fieldDefault(field: SettingsField) {
  return field.type === "overlay" ? undefined : field.default
}

function PluginSettingsField(props: {
  item: SettingsItem
  field: SettingsField
  revision: number
  sectionIndex: number
  rootKey?: string
  rootDefault?: unknown
  path?: (string | number)[]
}) {
  const plugins = useAppPluginRuntime()
  const pluginID = () => props.item.pluginID ?? props.item.id
  const root = () => {
    props.revision
    if (props.item.storage) return props.item.storage.read(props.rootKey ?? props.field.key, props.rootDefault ?? fieldDefault(props.field))
    return plugins.settingValue(pluginID(), props.rootKey ?? props.field.key, props.rootDefault ?? fieldDefault(props.field))
  }
  const value = <T,>(fallback: T) => readPluginSetting(root(), props.path ?? [], fallback) as T
  const reference = (key: string | undefined) => {
    props.revision
    if (!key) return ""
    const field = pluginSettingsLeafFields(props.item.sections.flatMap((section) => section.fields)).find((item) => item.key === key)
    const fallback = field ? fieldDefault(field) : ""
    const result = props.item.storage
      ? props.item.storage.read(key, fallback)
      : plugins.settingValue(pluginID(), key, fallback)
    return typeof result === "string" ? result : ""
  }
  const set = (next: unknown) => {
    const update = (current: unknown) => updatePluginSetting(current, props.path ?? [],
      typeof next === "function" ? next(readPluginSetting(current, props.path ?? [], fieldDefault(props.field))) : next)
    if (props.item.storage) {
      void Promise.resolve().then(() => props.item.storage!.update(props.rootKey ?? props.field.key, (current) => update(current === undefined ? props.rootDefault ?? fieldDefault(props.field) : current)))
        .catch((error) => showToast({ title: "Could not save plugin settings", description: error instanceof Error ? error.message : String(error) }))
      return
    }
    plugins.setSettingValue(
      pluginID(),
      props.rootKey ?? props.field.key,
      update(root()),
    )
  }

  return (
    <SettingsRowV2
      action={pluginSettingsFieldAction(
        pluginID(),
        props.sectionIndex,
        props.path?.length ? JSON.stringify([props.rootKey, ...props.path]) : props.field.key,
      )}
      title={props.field.label}
      description={props.field.description}
      block={["skill-list", "object", "list", "voice"].includes(props.field.type)}
    >
      <Switch>
        <Match when={props.field.type === "model-selection" ? props.field : undefined}>
          {(field) => <SettingsModelPickerV2 value={value(field().default).model} variant={value(field().default).variant}
            label={field().label} onChange={(model) => model && set({ model })}
            onVariantChange={(variant) => set((current: unknown) => ({ ...(current && typeof current === "object" ? current : field().default), variant }))} />}
        </Match>
        <Match when={props.field.type === "object" ? props.field : undefined}>
          {(field) => (
            <div class="w-full min-w-0">
              <For each={field().fields}>
                {(child) => (
                  <PluginSettingsField
                    item={props.item}
                    field={child}
                    revision={props.revision}
                    sectionIndex={props.sectionIndex}
                    rootKey={props.rootKey ?? props.field.key}
                    rootDefault={props.rootDefault ?? fieldDefault(props.field)}
                    path={[...(props.path ?? []), child.key]}
                  />
                )}
              </For>
            </div>
          )}
        </Match>
        <Match when={props.field.type === "list" ? props.field : undefined}>
          {(field) => {
            const rows = () => (Array.isArray(value(field().default)) ? value(field().default) : [])
            return (
              <div class="flex w-full min-w-0 flex-col gap-3" data-plugin-setting-list={props.field.key}>
                <Index each={rows()}>
                  {(_, index) => (
                    <div class="min-w-0 rounded-md border border-v2-border-base p-3" data-plugin-setting-list-item>
                      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <span class="min-w-0 break-words">
                          {field().itemLabelKey && typeof rows()[index]?.[field().itemLabelKey!] === "string"
                            ? String(rows()[index]?.[field().itemLabelKey!]) || `${field().label} ${index + 1}`
                            : `${field().label} ${index + 1}`}
                        </span>
                        <ButtonV2
                          type="button"
                          size="small"
                          variant="ghost-muted"
                          onClick={() => set((current: unknown) => (Array.isArray(current) ? current : []).filter((_, position) => position !== index))}
                          disabled={rows().length <= (field().minItems ?? 0)}
                        >
                          Remove
                        </ButtonV2>
                      </div>
                      <For each={field().fields}>
                        {(child) => (
                          <PluginSettingsField
                            item={props.item}
                            field={child}
                            revision={props.revision}
                            sectionIndex={props.sectionIndex}
                            rootKey={props.rootKey ?? props.field.key}
                            rootDefault={props.rootDefault ?? fieldDefault(props.field)}
                            path={[...(props.path ?? []), index, child.key]}
                          />
                        )}
                      </For>
                    </div>
                  )}
                </Index>
                <ButtonV2
                  type="button"
                  size="small"
                  variant="neutral"
                  icon="plus"
                  onClick={() => {
                    try {
                      set((current: unknown) => {
                        const items = Array.isArray(current) ? current : []
                        return [...items, createPluginSettingItem(field(), items)]
                      })
                    } catch (error) {
                      showToast({ title: "Could not add item", description: error instanceof Error ? error.message : String(error) })
                    }
                  }}
                >
                  {field().addLabel ?? "Add item"}
                </ButtonV2>
              </div>
            )
          }}
        </Match>
        <Match when={props.field.type === "boolean" ? props.field : undefined}>
          {(field) => <SwitchV2 checked={value(field().default)} onChange={set} hideLabel>{field().label}</SwitchV2>}
        </Match>
        <Match when={props.field.type === "select" ? props.field : undefined}>
          {(field) => (
            <SelectV2
              appearance="inline"
              options={field().options}
              current={field().options.find((option) => option.value === value(field().default))}
              value={(option) => option.value}
              label={(option) => option.label}
              placement="bottom-end"
              gutter={6}
              onSelect={(option) => option && set(option.value)}
            />
          )}
        </Match>
        <Match when={props.field.type === "number" ? props.field : undefined}>
          {(field) => (
            <TextInputV2
              type="number"
              min={field().min}
              max={field().max}
              value={String(value(field().default))}
              onChange={(event) => {
                if (Number.isFinite(event.currentTarget.valueAsNumber)) set(event.currentTarget.valueAsNumber)
              }}
            />
          )}
        </Match>
        <Match when={modelTargetSettingsField(props.field)}>
          {(field) => (
            <SettingsModelTargetPickerV2
              value={String(value(field().default))}
              label={field().label}
              filter={field().filter}
              required={field().required}
              autoSelectSingle={field().autoSelectSingle}
              autoSelectDefault={field().autoSelectDefault}
              onChange={set}
            />
          )}
        </Match>
        <Match when={props.field.type === "voice" ? props.field : undefined}>
          {(field) => (
            <SettingsVoicePickerV2
              value={String(value(field().default))}
              target={reference(field().targetKey)}
              language={reference(field().languageKey)}
              label={field().label}
              allowCustom={field().allowCustom}
              onChange={set}
            />
          )}
        </Match>
        <Match when={props.field.type === "text" ? props.field : undefined}>
          {(field) => (
            <TextInputV2 value={String(value(field().default))} onInput={(event) => set(event.currentTarget.value)} />
          )}
        </Match>
        <Match when={props.field.type === "textarea" ? props.field : undefined}>
          {(field) => (
            <TextareaV2
              value={String(value(field().default))}
              placeholder={field().placeholder}
              rows={field().rows}
              spellcheck={false}
              onInput={(event) => set(event.currentTarget.value)}
            />
          )}
        </Match>
        <Match when={props.field.type === "skill-list" ? props.field : undefined}>
          {(field) => <PluginSkillList value={value(field().default)} onChange={set} />}
        </Match>
        <Match when={props.field.type === "overlay" ? props.field : undefined}>
          {(field) => (
            <PluginSettingsOverlayRow
              item={props.item}
              field={field()}
              revision={props.revision}
              sectionIndex={props.sectionIndex}
            />
          )}
        </Match>

      </Switch>
    </SettingsRowV2>
  )
}

type PluginSettingsOverlayField = Extract<SettingsField, { type: "overlay" }>

function PluginSettingsOverlayRow(props: {
  item: SettingsItem
  field: PluginSettingsOverlayField
  revision: number
  sectionIndex: number
}) {
  const dialog = useDialog()
  const anchor = () => pluginSettingsFieldAction(props.item.pluginID ?? props.item.id, props.sectionIndex, props.field.key)
  const open = () => {
    dialog.push(() => (
      <PluginSettingsOverlayDialog
        item={props.item}
        field={props.field}
        revision={props.revision}
        sectionIndex={props.sectionIndex}
      />
    ))
  }
  onMount(() => {
    // A settings search jump that lands on this row reveals the hidden fields.
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== anchor()) return
      open()
    }
    window.addEventListener(SETTINGS_ANCHOR_EVENT, listener)
    onCleanup(() => window.removeEventListener(SETTINGS_ANCHOR_EVENT, listener))
  })
  return (
    <ButtonV2 type="button" size="small" variant="neutral" onClick={open}>
      {props.field.label}
    </ButtonV2>
  )
}

function PluginSettingsOverlayDialog(props: {
  item: SettingsItem
  field: PluginSettingsOverlayField
  revision: number
  sectionIndex: number
}) {
  return (
    <Dialog
      title={props.field.label}
      description={props.field.description}
      size="large"
      fit
      class="settings-v2-plugin-overlay-dialog"
    >
      <SettingsListV2>
        <For each={props.field.fields}>
          {(child) => (
            <PluginSettingsField
              item={props.item}
              field={child}
              revision={props.revision}
              sectionIndex={props.sectionIndex}
            />
          )}
        </For>
      </SettingsListV2>
    </Dialog>
  )
}

function normalizeSkillNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim().replace(/^\//, ""))
        .filter((name) => name && name.length <= 128),
    ),
  ).slice(0, 16)
}

function PluginSkillList(props: { value: unknown; onChange(value: string[]): void }) {
  const layout = useLayout()
  const serverSDK = useServerSDK()
  const [available, setAvailable] = createSignal<string[]>()
  const [entry, setEntry] = createSignal("")
  const values = () => normalizeSkillNames(props.value)

  onMount(() => {
    const directory = layout.projects.list()[0]?.worktree
    if (!directory) {
      setAvailable([])
      return
    }
    void serverSDK()
      .client.v2.skill.list({ location: { directory } })
      .then((response) => setAvailable((response.data?.data ?? []).map((skill) => skill.name)))
      .catch(() => setAvailable([]))
  })

  const add = () => {
    const names = normalizeSkillNames([...values(), entry()])
    if (names.length === values().length) return
    props.onChange(names)
    setEntry("")
  }

  return (
    <div class="settings-v2-plugin-skill-list">
      <For each={values()}>
        {(name) => (
          <div class="settings-v2-plugin-skill-list-item">
            <code>/{name}</code>
            <Show when={available() && !available()!.includes(name)}>
              <span class="settings-v2-plugin-skill-unavailable">Unavailable</span>
            </Show>
            <IconButtonV2
              icon="close"
              variant="ghost"
              aria-label={`Remove ${name}`}
              onClick={() => props.onChange(values().filter((item) => item !== name))}
            />
          </div>
        )}
      </For>
      <div class="settings-v2-plugin-skill-list-add">
        <TextInputV2
          value={entry()}
          placeholder="skill-name"
          onInput={(event) => setEntry(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            add()
          }}
        />
        <ButtonV2 type="button" size="small" variant="neutral" disabled={!entry().trim()} onClick={add}>
          Add skill
        </ButtonV2>
      </div>
    </div>
  )
}
