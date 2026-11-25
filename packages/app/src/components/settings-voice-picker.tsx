import { Show, createMemo, createSignal } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useModels } from "@/context/models"
import { voicePickerState } from "./settings-voice-picker-model"
import "./settings-voice-picker.css"

export function SettingsVoicePickerV2(props: {
  value: string
  target: string
  language?: string
  label: string
  allowCustom?: boolean
  onChange(value: string): void
}) {
  const models = useModels()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [mount, setMount] = createSignal<HTMLDivElement>()
  const state = createMemo(() => voicePickerState({
    target: props.target,
    value: props.value,
    language: props.language,
    models: models.list().map((model) => ({ ...model, providerID: model.provider.id, modelID: model.id })),
    chains: models.chain.list(),
  }))
  const options = createMemo(() => [
    ...state().options.map((option) => ({ ...option, id: `voice:${option.value}`, custom: false })),
    ...(props.allowCustom ? [{ id: "custom", value: "", label: "Eigene Stimmen-ID …", models: [], custom: true }] : []),
  ])

  return (
    <div ref={setMount} class="flex w-full min-w-0 flex-col gap-2" data-voice-picker>
      <SelectV2
        portalMount={mount()}
        contentClass="settings-voice-menu"
        aria-label={props.label}
        options={options()}
        current={options().find((option) => !option.custom && option.value === props.value)}
        value={(option) => option.id}
        label={(option) => option.label}
        fitViewport
        onSelect={(option) => {
          if (!option) return
          if (option.custom) {
            setDraft(props.value)
            setEditing(true)
            return
          }
          // Catalogue refreshes can re-emit the unchanged selection; keep pending edits.
          if (option.value === props.value) return
          setEditing(false)
          props.onChange(option.value)
        }}
      />
      <p class="text-12-regular text-text-weak break-words" role="status">
        {models.ready() ? state().hint : "Stimmenkatalog wird geladen …"}
      </p>
      <Show when={editing()}>
        <div class="flex min-w-0 flex-col gap-2" data-voice-custom>
          <TextInputV2 aria-label="Eigene Stimmen-ID" value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} />
          <div class="flex flex-wrap gap-2">
            <ButtonV2 size="small" onClick={() => { props.onChange(draft()); setEditing(false) }}>Übernehmen</ButtonV2>
            <ButtonV2 size="small" variant="ghost-muted" onClick={() => setEditing(false)}>Abbrechen</ButtonV2>
          </div>
        </div>
      </Show>
    </div>
  )
}
