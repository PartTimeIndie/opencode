import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { resolveSessionRename } from "./session-rename"

export function DialogRenameSession(props: { initialTitle: string; onRename: (title: string) => Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [title, setTitle] = createSignal(props.initialTitle)
  const [error, setError] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (saving()) return

    const result = resolveSessionRename(props.initialTitle, title())
    if (result.status === "empty") {
      setError(language.t("session.rename.required"))
      return
    }
    if (result.status === "unchanged") {
      dialog.close()
      return
    }

    setError(undefined)
    setSaving(true)
    await props
      .onRename(result.title)
      .then(() => dialog.close())
      .catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message ? cause.message : language.t("common.requestFailed"))
      })
      .finally(() => setSaving(false))
  }

  return (
    <Dialog title={language.t("session.rename.title")} fit>
      <form class="flex w-[min(420px,calc(100vw-32px))] flex-col gap-4 px-6 pb-4" onSubmit={submit}>
        <TextField
          autofocus
          type="text"
          aria-required="true"
          label={language.t("session.rename.label")}
          value={title()}
          disabled={saving()}
          validationState={error() ? "invalid" : "valid"}
          error={error()}
          onChange={(value) => {
            setTitle(value)
            if (error()) setError(undefined)
          }}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" disabled={saving()} onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={saving()}>
            {saving() ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
