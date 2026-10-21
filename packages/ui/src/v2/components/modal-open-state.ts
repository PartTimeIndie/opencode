import { createEffect, createSignal } from "solid-js"

export function createModalOpenState(input: {
  open: () => boolean | undefined
  defaultOpen?: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = createSignal(input.open() ?? input.defaultOpen ?? false)
  const [suppressed, setSuppressed] = createSignal(false)
  const value = () => (suppressed() ? false : (input.open() ?? open()))

  createEffect(() => {
    const controlled = input.open()
    if (controlled === undefined) return
    setOpen(controlled)
    if (!controlled) setSuppressed(false)
  })

  return {
    value,
    change(next: boolean) {
      if (!next && suppressed()) return
      if (next) setSuppressed(false)
      if (input.open() === undefined) setOpen(next)
      input.onOpenChange(next)
    },
    dismiss() {
      const notify = value()
      setSuppressed(true)
      setOpen(false)
      if (notify) input.onOpenChange(false)
    },
  }
}

export function createModalRemountState() {
  const [mounted, setMounted] = createSignal(true)
  return {
    mounted,
    dismiss() {
      setMounted(false)
      queueMicrotask(() => setMounted(true))
    },
  }
}
