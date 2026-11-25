import { Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { ConfigDelegation } from "@opencode-ai/core/config/delegation"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { useServerSDK } from "@/context/server-sdk"
import { useSessionRoute } from "@/context/session-route"
import { decode64 } from "@/utils/base64"
import { createDelegationSettingsModel, type DelegationScope } from "./delegation-settings-model"

const Advanced = Schema.Struct({
  preferences: ConfigDelegation.Info.fields.preferences,
  rules: ConfigDelegation.Info.fields.rules,
})

export function DelegationSettingsPanel() {
  const sdk = useServerSDK()
  const route = useSessionRoute()
  const [draft, setDraft] = createStore({ scope: "session" as DelegationScope, taskID: "", questions: "inherit", advanced: "{}", error: "" })
  const model = createDelegationSettingsModel({
    target: () => route.id ? { server: sdk(), sessionID: route.id, directory: decode64(route.dir),
      scope: draft.scope, ...(draft.scope === "task" ? { taskID: draft.taskID.trim() } : {}) } : undefined,
    read: async (target) => {
      const result = await sdk().client.session.delegationPreferences(target)
      if (!result.data) throw new Error("Delegation settings could not be read.")
      return result.data
    },
    patch: async (target, patch, expected) => {
      const result = await sdk().client.session.patchDelegationPreferences({ ...target, ...expected, patch })
      if (!result.data) throw new Error("Delegation settings could not be saved. Read the scope again.")
      return result.data
    },
  })
  onCleanup(model.dispose)
  createEffect(() => {
    // The route and SDK are live: remounts/server switches never reuse a receipt.
    sdk()
    route.id
    route.dir
    draft.scope
    draft.taskID
    model.reset()
    setDraft({ questions: "inherit", advanced: "{}", error: "" })
  })
  const read = async () => {
    setDraft("error", "")
    const snapshot = await model.read()
    const value = snapshot?.value
    if (!value) return
    setDraft({ questions: value.ordinaryQuestions === undefined ? "inherit" : String(value.ordinaryQuestions),
      advanced: JSON.stringify({ ...(value.preferences === undefined ? {} : { preferences: value.preferences }),
        ...(value.rules === undefined ? {} : { rules: value.rules }) }, null, 2) })
  }
  const save = async () => {
    setDraft("error", "")
    try {
      const advanced = Schema.decodeUnknownSync(Advanced, { onExcessProperty: "error" })(JSON.parse(draft.advanced))
      await model.save({ ordinaryQuestions: draft.questions === "inherit" ? null : draft.questions === "true",
        preferences: advanced.preferences?.map((entry) => ({ ...entry, selections: entry.selections.map((selection) => ({ ...selection })) })) ?? null,
        rules: advanced.rules?.map((entry) => ({ ...entry, allowed: entry.allowed.map((selection) => ({ ...selection })) })) ?? null })
    } catch (error) {
      setDraft("error", error instanceof Error ? error.message : "Invalid preference or rule document.")
    }
  }
  return <section class="settings-v2-section" data-delegation-settings>
    <h3 class="settings-v2-section-title">Delegation preferences</h3>
    <p class="text-12-regular text-text-weak">
      Advice and binding selection rules share the same owner as the language tool. They never grant tools, models or permissions.
      Mirrors and human review are not optional settings.
    </p>
    <Show when={route.id} fallback={<p class="text-12-regular text-text-weak">Open a Session to manage its delegation settings.</p>}>
      <p class="text-12-regular break-all" data-delegation-session>Current Session: {route.id}</p>
      <label class="text-12-regular flex flex-col gap-1">Scope
        <select aria-label="Delegation scope" class="rounded border p-2 bg-background-base" value={draft.scope}
          disabled={model.state.busy} onChange={(event) => {
            const value = event.currentTarget.value
            if (value === "session" || value === "task" || value === "project" || value === "global") setDraft("scope", value)
          }}>
          <option value="session">This Session</option><option value="task">Explicit owned task</option>
          <option value="project">Project</option><option value="global">Global</option>
        </select>
      </label>
      <Show when={draft.scope === "task"}>
        <TextInputV2 aria-label="Owned task Session ID" placeholder="Select an owned task by its exact Session ID"
          value={draft.taskID} disabled={model.state.busy} onInput={(event) => setDraft("taskID", event.currentTarget.value)} />
      </Show>
      <ButtonV2 size="small" variant="neutral" disabled={model.state.busy} onClick={() => void read()}>Read scope</ButtonV2>
      <Show when={model.state.snapshot}>
        {(snapshot) => <>
          <p class="text-12-regular text-text-weak">{snapshot().revision !== undefined ? `Revision ${snapshot().revision}` : `File version ${snapshot().version?.slice(0, 12)}`}</p>
          <label class="text-12-regular flex flex-col gap-1">Ordinary-question preference
            <select aria-label="Ordinary-question preference" class="rounded border p-2 bg-background-base" value={draft.questions}
              disabled={model.state.busy} onChange={(event) => setDraft("questions", event.currentTarget.value)}>
              <option value="inherit">Inherit</option><option value="true">Enabled</option><option value="false">Disabled</option>
            </select>
          </label>
          <p class="text-12-regular text-text-weak">This preference never suppresses permission prompts, confirmations or human review.</p>
          <TextareaV2 aria-label="Delegation preferences and rules" value={draft.advanced} rows={10}
            disabled={model.state.busy} onInput={(event) => setDraft("advanced", event.currentTarget.value)} />
          <p class="text-12-regular text-text-weak">Advanced JSON: preferences use topic and selections; rules use optional topic and allowed selections.
            Each selection may name an agent, model, chain or variant. Choose either model or chain, not both. An omitted field clears only this scope; outer binding rules remain binding.</p>
          <ButtonV2 size="small" variant="neutral" disabled={model.state.busy} onClick={() => void save()}>Save scope</ButtonV2>
        </>}
      </Show>
      <Show when={draft.error || model.state.error}>
        <p role="alert" class="text-12-regular text-text-weak whitespace-pre-wrap">{draft.error || model.state.error}</p>
      </Show>
    </Show>
  </section>
}
