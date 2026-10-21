---
name: composer-toolbar-plugin
description: "Build or review OpenCode composer toolbar plugins that alter prompts before submit."
---

# Composer Toolbar Plugin

Use this skill when adding or reviewing a toolbar plugin that mounts in the composer and needs to inject, append, validate, or otherwise change the prompt before it is sent.

## Contract

Composer prompt changes must go through the `opencode:composer-before-submit` event. Do not read the editor DOM text, synthesize keypresses, require a second submit, or assume a hidden prompt API exists on the toolbar context.

The event detail is the supported boundary:

```ts
type ComposerBeforeSubmitDetail = {
  version: 1
  directory: string
  sessionID?: string
  mode: "normal" | "shell"
  getText: () => string
  appendText: (value: string) => void
  setText: (value: string) => void
  preventSubmit: () => void
}
```

`appendText(...)` updates the synchronized composer prompt state, so both click submit and Enter submit send the same final prompt.
`setText(...)` replaces the synchronized composer prompt text while preserving image attachments.

For click-time prompt edits, dispatch `opencode:composer-edit` from the mounted toolbar element and use the bound API. This is the supported path for buttons that must visibly change the draft before submit.

```ts
let composer
button.dispatchEvent(
  new CustomEvent("opencode:composer-edit", {
    bubbles: true,
    detail: {
      version: 1,
      bind(api) {
        composer = api
      },
    },
  }),
)
composer?.setText("Improved prompt text")
```

## Plugin Pattern

1. Register the composer toolbar item with `kind: "mount"` and `placement: "composer"`.
2. Keep plugin UI state in the mounted component or closure.
3. Listen for `opencode:composer-before-submit` on `document` with capture enabled.
4. Scope the handler to the same composer form before changing the prompt.
5. Use `event.detail.getText()` to inspect the current prompt when needed.
6. Use `event.detail.appendText(text)` to add prompt text.
7. Use `event.detail.setText(text)` to replace prompt text.
8. Use `event.detail.preventSubmit()` only for validation failures or required user action.
9. Reset one-shot UI state after a successful append/set so the next message is not modified unexpectedly.
10. Remove all DOM and document listeners from the mount cleanup callback.

Example:

```ts
const onBeforeSubmit = (event: Event) => {
  const detail = event instanceof CustomEvent && event.detail && typeof event.detail === "object" ? event.detail : undefined
  if (!detail || detail.version !== 1 || typeof detail.appendText !== "function") return
  if (!state.active) return

  const form = button.closest("form")
  if (!form || !(event.target instanceof Node) || !form.contains(event.target)) return

  detail.appendText("Please include visual QA for this change.")
  state.active = false
  update()
}

document.addEventListener("opencode:composer-before-submit", onBeforeSubmit, true)
return () => document.removeEventListener("opencode:composer-before-submit", onBeforeSubmit, true)
```

## Submit Paths

The submit implementation dispatches the before-submit event from the nearest composer form. This is required because Enter from the editor and clicking the form submit button can have different event targets. Plugin handlers should therefore scope with `button.closest("form")` and `form.contains(event.target)` rather than comparing against one specific button or editor node.

## Debugging

Optional debug logging is fine behind an explicit flag, local storage setting, or plugin config value. Log the event `version`, `mode`, `directory`, `sessionID`, and whether the plugin appended or blocked. Do not log full prompt text by default.

## Verification

For prompt-injecting toolbar plugins, add or run focused coverage for both paths:

- Unit coverage in `packages/app/src/components/prompt-input/submit.test.ts` confirming the before-submit event is dispatched from the form when Enter submit starts inside the editor.
- E2E coverage such as `packages/app/e2e/regression/composer-before-submit.spec.ts` confirming a mounted composer toolbar plugin appends text and the sent `prompt_async` parts contain the final prompt.

Run checks from the package directory, for example:

```bash
cd packages/app
bun test src/components/prompt-input/submit.test.ts
bun run test:e2e:controlled -- e2e/regression/composer-before-submit.spec.ts
```
