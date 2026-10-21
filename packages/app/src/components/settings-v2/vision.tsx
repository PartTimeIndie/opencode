import type { Component } from "solid-js"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { For, createEffect, createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsModelPickerV2 } from "../settings-model-picker"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

const DEFAULT_PROMPT_TEMPLATE = `The user attached an image and asked the following question:
"{{user_message}}"

Analyze this image in the context of the user's question. Provide a detailed, factual description covering all relevant visual details (text content, UI elements, layout, colors, data, diagrams, errors, or any other observable content) that would help answer the user's question.`

type VisionConfig = NonNullable<Config["vision"]>
type ModelRef = NonNullable<VisionConfig["primary"]>

const toRef = (model?: string, variant?: string): ModelRef | undefined =>
  model ? { model, ...(variant ? { variant } : {}) } : undefined

export const SettingsVisionV2: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const config = createMemo(() => serverSync().data.config as Config)
  const [pendingVision, setPendingVision] = createSignal<VisionConfig>()
  const vision = createMemo(() => pendingVision() ?? config().vision ?? {})
  const enabled = createMemo(() => vision().enabled ?? false)
  const fallbacks = createMemo(() => vision().fallbacks ?? [])

  createEffect(() => {
    const pending = pendingVision()
    if (!pending || JSON.stringify(config().vision ?? {}) !== JSON.stringify(pending)) return
    setPendingVision(undefined)
  })

  const sync = (patch: Partial<VisionConfig>) => {
    const next: VisionConfig = { ...vision(), ...patch }
    setPendingVision(next)
    void serverSync()
      .updateConfig({ vision: next } as Config)
      .catch((error) => {
        if (pendingVision() === next) setPendingVision(undefined)
        showToast({
          variant: "error",
          title: "Could not save vision settings",
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  const setEnabled = (value: boolean) => sync({ enabled: value })

  const setPrimaryModel = (model: string | undefined) => sync({ primary: toRef(model, vision().primary?.variant) })
  const setPrimaryVariant = (variant: string | undefined) =>
    sync({ primary: toRef(vision().primary?.model, variant ?? undefined) })

  const setFallbackModel = (index: number, model: string | undefined) => {
    const list = [...fallbacks()]
    const current = list[index]
    if (!model) {
      list.splice(index, 1)
    } else {
      list[index] = { model, ...(current?.variant ? { variant: current.variant } : {}) }
    }
    sync({ fallbacks: list })
  }
  const setFallbackVariant = (index: number, variant: string | undefined) => {
    const list = [...fallbacks()]
    const current = list[index]
    if (current) list[index] = { model: current.model, ...(variant ? { variant } : {}) }
    sync({ fallbacks: list })
  }
  const removeFallback = (index: number) => {
    const list = [...fallbacks()]
    list.splice(index, 1)
    sync({ fallbacks: list })
  }
  const addFallback = () => sync({ fallbacks: [...fallbacks(), { model: "" }] })

  const setTemplate = (value: string) => sync({ prompt_template: value })
  const resetTemplate = () => sync({ prompt_template: undefined })

  return (
    <>
      <div class="settings-v2-section-header">
        <h2 class="settings-v2-title">{language.t("settings.vision.title")}</h2>
        <p class="settings-v2-description">{language.t("settings.vision.description")}</p>
      </div>

      <div class="settings-v2-body">
        <div class="settings-v2-section">
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.vision.row.enabled.title")}
              description={language.t("settings.vision.row.enabled.description")}
            >
              <div data-action="settings-vision-enabled">
                <Switch checked={enabled()} onChange={setEnabled} />
              </div>
            </SettingsRowV2>

            <SettingsRowV2
              title={language.t("settings.vision.row.primary.title")}
              description={language.t("settings.vision.row.primary.description")}
            >
              <div data-action="settings-vision-primary">
                <SettingsModelPickerV2
                  label={language.t("settings.vision.row.primary.title")}
                  value={vision().primary?.model}
                  variant={vision().primary?.variant}
                  allowClear
                  onChange={setPrimaryModel}
                  onVariantChange={setPrimaryVariant}
                />
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.vision.section.fallbacks")}</h3>
          <SettingsListV2>
            <For each={fallbacks()}>
              {(fallback, index) => (
                <SettingsRowV2
                  title={`${language.t("settings.vision.row.fallback.title")} ${index() + 1}`}
                  description={language.t("settings.vision.row.fallback.description")}
                >
                  <div class="flex items-center gap-2" data-action={`settings-vision-fallback-${index()}`}>
                    <SettingsModelPickerV2
                      label={language.t("settings.vision.row.fallback.title")}
                      value={fallback.model}
                      variant={fallback.variant}
                      onChange={(model) => setFallbackModel(index(), model)}
                      onVariantChange={(variant) => setFallbackVariant(index(), variant)}
                    />
                    <ButtonV2 type="button" variant="ghost-muted" size="small" onClick={() => removeFallback(index())}>
                      {language.t("settings.vision.row.fallback.remove")}
                    </ButtonV2>
                  </div>
                </SettingsRowV2>
              )}
            </For>
            <SettingsRowV2
              title={language.t("settings.vision.row.addFallback.title")}
              description={language.t("settings.vision.row.addFallback.description")}
            >
              <div data-action="settings-vision-add-fallback">
                <ButtonV2 type="button" variant="contrast" size="small" onClick={addFallback}>
                  {language.t("settings.vision.row.addFallback.button")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.vision.section.prompt")}</h3>
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.vision.row.template.title")}
              description={language.t("settings.vision.row.template.description")}
            >
              <div class="flex flex-col gap-2 w-full" data-action="settings-vision-prompt-template">
                <TextareaV2
                  value={vision().prompt_template ?? DEFAULT_PROMPT_TEMPLATE}
                  onInput={(event) => setTemplate(event.currentTarget.value)}
                  rows={8}
                  class="w-full"
                  placeholder={DEFAULT_PROMPT_TEMPLATE}
                />
                <ButtonV2 type="button" variant="ghost-muted" size="small" onClick={resetTemplate}>
                  {language.t("settings.vision.row.template.reset")}
                </ButtonV2>
              </div>
            </SettingsRowV2>
          </SettingsListV2>
        </div>
      </div>
    </>
  )
}
