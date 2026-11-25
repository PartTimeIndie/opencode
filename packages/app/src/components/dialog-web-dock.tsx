import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogWebDock(props: { title: string; label: string; initial: string; hint?: string; maxLength?: number; onSubmit: (value: string) => Promise<void> | void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [value, setValue] = createSignal(props.initial)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    const next = value().trim()
    if (!next || next.length > (props.maxLength ?? 100)) return setError(language.t("webDock.invalidValue", { count: props.maxLength ?? 100 }))
    setBusy(true)
    try {
      await props.onSubmit(next)
      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : language.t("webDock.failed"))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={props.title} fit>
      <form class="flex w-[min(420px,calc(100vw-32px))] flex-col gap-4 px-6 pb-4" onSubmit={submit}>
        <TextField autofocus label={props.label} value={value()} disabled={busy()} validationState={error() ? "invalid" : "valid"} error={error()} onChange={setValue} />
        <Show when={props.hint}><p class="text-text-weak text-12-regular">{props.hint}</p></Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" disabled={busy()} onClick={() => dialog.close()}>{language.t("common.cancel")}</Button>
          <Button type="submit" variant="primary" size="large" disabled={busy()}>{language.t("common.save")}</Button>
        </div>
      </form>
    </Dialog>
  )
}
