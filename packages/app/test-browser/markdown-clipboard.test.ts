import { afterEach, expect, test } from "bun:test"
import { copyMarkdownText } from "../../ui/src/components/markdown-clipboard"

const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
const command = Object.getOwnPropertyDescriptor(document, "execCommand")

afterEach(() => {
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
  if (!clipboard) Reflect.deleteProperty(navigator, "clipboard")
  if (command) Object.defineProperty(document, "execCommand", command)
  if (!command) Reflect.deleteProperty(document, "execCommand")
  document.body.replaceChildren()
})

for (const mode of ["modern", "missing", "rejected", "throwing"] as const) {
  test(`Markdown copy cleans up and restores focus (${mode})`, async () => {
    const copied: string[] = []
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    const button = document.createElement("button")
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    button.focus()
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        mode === "missing"
          ? undefined
          : {
              writeText: async (text: string) => {
                if (mode !== "modern") throw new Error("Clipboard unavailable")
                copied.push(text)
              },
            },
    })
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => {
        if (mode === "throwing") throw new Error("Legacy clipboard unavailable")
        const textarea = dialog.querySelector("textarea")
        expect(textarea).not.toBeNull()
        copied.push(textarea!.value)
        return true
      },
    })
    expect(await copyMarkdownText("# Copied")).toBe(mode !== "throwing")
    expect(copied).toEqual(mode === "throwing" ? [] : ["# Copied"])
    expect(document.querySelector("textarea")).toBeNull()
    expect(document.activeElement).toBe(button)
  })
}
