export type FocusedTextInputResult = {
  ok: boolean
  error?: string
}

export type FocusedTextInputTarget = {
  insertText(text: string): FocusedTextInputResult
}

const inputTypes = new Set(["email", "password", "search", "tel", "text", "url"])

export function captureFocusedTextInput(root: Document = document): FocusedTextInputTarget | undefined {
  const element = deepActiveElement(root)
  if (!element || element.closest('[data-component="prompt-input"]')) return
  if (element instanceof HTMLInputElement && inputTypes.has(element.type)) return captureValueInput(element)
  if (element instanceof HTMLTextAreaElement) return captureValueInput(element)
  if (element instanceof HTMLElement && element.isContentEditable) return captureContentEditable(element, root)
}

function deepActiveElement(root: Document | ShadowRoot): Element | null {
  const active = root.activeElement
  if (!(active instanceof HTMLElement) || !active.shadowRoot) return active
  return deepActiveElement(active.shadowRoot) ?? active
}

function captureValueInput(element: HTMLInputElement | HTMLTextAreaElement): FocusedTextInputTarget {
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? start
  return {
    insertText(text) {
      if (!element.isConnected) return failed("The focused text field is no longer available")
      if (element.disabled || element.readOnly) return failed("The focused text field is not editable")
      if (!dispatchBeforeInput(element, text)) return failed("The focused text field rejected the transcript")
      element.setRangeText(text, Math.min(start, element.value.length), Math.min(end, element.value.length), "end")
      dispatchInput(element, text)
      return { ok: true }
    },
  }
}

function captureContentEditable(element: HTMLElement, root: Document): FocusedTextInputTarget {
  const selection = root.getSelection()
  const range = selection?.rangeCount && element.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : undefined
  return {
    insertText(text) {
      if (!element.isConnected) return failed("The focused text field is no longer available")
      if (!element.isContentEditable) return failed("The focused text field is not editable")
      if (!dispatchBeforeInput(element, text)) return failed("The focused text field rejected the transcript")
      const target = range?.startContainer.isConnected ? range : undefined
      const node = root.createTextNode(text)
      if (target) {
        target.deleteContents()
        target.insertNode(node)
        target.setStartAfter(node)
        target.collapse(true)
        if (root.activeElement === element || element.contains(root.activeElement)) {
          selection?.removeAllRanges()
          selection?.addRange(target)
        }
      } else {
        element.append(node)
      }
      dispatchInput(element, text)
      return { ok: true }
    },
  }
}

function dispatchBeforeInput(element: HTMLElement, text: string) {
  return element.dispatchEvent(inputEvent("beforeinput", text, true))
}

function dispatchInput(element: HTMLElement, text: string) {
  element.dispatchEvent(inputEvent("input", text, false))
}

function inputEvent(type: string, text: string, cancelable: boolean) {
  if (typeof InputEvent === "function") {
    return new InputEvent(type, { bubbles: true, cancelable, data: text, inputType: "insertText" })
  }
  return new Event(type, { bubbles: true, cancelable })
}

function failed(error: string): FocusedTextInputResult {
  return { ok: false, error }
}
