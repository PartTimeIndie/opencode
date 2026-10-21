export function shouldAutofocusQuestionDock(input: { autofocus?: boolean; activeElement?: Element | null }) {
  if (input.autofocus === false) return false
  const active = input.activeElement ?? document.activeElement
  return !(active instanceof HTMLElement && active.closest('[data-component="prompt-input"]'))
}
