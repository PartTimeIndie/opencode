import { describe, expect, test, vi } from "bun:test"

type DialogField = {
  id: string
  label: string
  value?: string
  required?: boolean
  multiline?: boolean
}

type WorkbenchDialog = {
  fields: DialogField[]
  values: Record<string, string>
  focus?: { control: string; field?: string; start?: number; end?: number }
  error?: { field: string; message: string }
  submit: (values: Record<string, string>) => unknown
}

type WorkbenchState = {
  panels: Set<() => void>
  dialog?: WorkbenchDialog
  directory?: string
  navigationDirectory?: string
  settings?: { historyLimit: number; defaultRemote: string; syncMode: string }
  busy?: string
  error?: string
  notice?: string
  selectedCommit?: string
  selectedFile?: string
  diffByFile?: Map<string, unknown>
  diffBusy?: string
  diffError?: string
  snapshot?: unknown
  discoveredProjects?: { worktree: string; name: string }[]
  discoveryBusy?: boolean
  discoveryError?: string
  discoveryRequest?: number
  discoveryTruncated?: boolean
}

type WorkbenchModule = {
  openTextDialog: (
    state: WorkbenchState,
    dialog: Omit<WorkbenchDialog, "values" | "error"> & { title: string; confirm: string },
  ) => void
  submitTextDialog: (state: WorkbenchState, dialog: WorkbenchDialog, values: Record<string, string>) => unknown
  closeTextDialog: (state: WorkbenchState) => void
  renderAll: (state: WorkbenchState) => void
  renderTextDialog: (state: WorkbenchState) => HTMLElement
  promptCreateBranch: (api: unknown, state: WorkbenchState) => void
  promptSquash: (
    api: unknown,
    state: WorkbenchState,
    commit: { hash: string; subject: string; parents: string[] },
  ) => void
  renderConflicts: (
    api: unknown,
    state: WorkbenchState,
    snapshot: { conflicts: { file: string }[] },
  ) => HTMLElement
  refreshDiscoveredProjects: (api: unknown, state: WorkbenchState) => Promise<void>
}

const workbench = (await import(
  new URL("../../../../.opencode/plugins/git-workbench-app/index.js", import.meta.url).href
)) as unknown as WorkbenchModule

function rejectBrowserPrompt() {
  const original = globalThis.prompt
  globalThis.prompt = () => {
    throw new Error("browser prompt must not be used")
  }
  return () => {
    globalThis.prompt = original
  }
}

function state(): WorkbenchState {
  return {
    panels: new Set(),
    directory: "C:/repo",
    settings: { historyLimit: 25, defaultRemote: "", syncMode: "pull-merge-push" },
    busy: "",
    error: "",
    notice: "",
    selectedCommit: "",
    selectedFile: "",
    diffByFile: new Map(),
    diffBusy: "",
    diffError: "",
    discoveredProjects: [],
    discoveryBusy: false,
    discoveryError: "",
    discoveryRequest: 0,
    discoveryTruncated: false,
  }
}

function api(actions: Record<string, unknown>[]) {
  return {
    host: {
      git: {
        action: async (input: Record<string, unknown>) => {
          actions.push(input)
          return { ok: true, message: "ok" }
        },
        snapshot: async () => ({}),
        discover: async (): Promise<{
          repositories: { worktree: string; name: string }[]
          truncated: boolean
        }> => ({ repositories: [], truncated: false }),
      },
    },
    kv: { set: vi.fn() },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function mountDialogRenderer(current: WorkbenchState) {
  let overlay: HTMLElement | undefined
  const render = () => {
    if (!current.dialog) {
      overlay?.remove()
      overlay = undefined
      return
    }
    const next = workbench.renderTextDialog(current)
    if (overlay) overlay.replaceWith(next)
    else document.body.append(next)
    overlay = next
  }
  current.panels.add(render)
  return {
    element: () => overlay!,
    dispose: () => {
      current.panels.delete(render)
      overlay?.remove()
    },
  }
}

function changeInput(input: HTMLInputElement | HTMLTextAreaElement, value: string, start = value.length, end = start) {
  input.value = value
  input.setSelectionRange(start, end)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("select", { bubbles: true }))
}

describe("Git Workbench repository discovery", () => {
  test("keeps the newest result when same-directory requests finish out of order", async () => {
    const current = state()
    const host = api([])
    const older = deferred<{ repositories: { worktree: string; name: string }[]; truncated: boolean }>()
    const newer = deferred<{ repositories: { worktree: string; name: string }[]; truncated: boolean }>()
    vi.spyOn(host.host.git, "discover").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)

    const olderRefresh = workbench.refreshDiscoveredProjects(host, current)
    const newerRefresh = workbench.refreshDiscoveredProjects(host, current)
    newer.resolve({ repositories: [{ worktree: "C:/repo/new", name: "new" }], truncated: false })
    await newerRefresh
    older.resolve({ repositories: [{ worktree: "C:/repo/old", name: "old" }], truncated: true })
    await olderRefresh

    expect(current.discoveredProjects).toEqual([{ worktree: "C:/repo/new", name: "new" }])
    expect(current.discoveryTruncated).toBe(false)
    expect(current.discoveryBusy).toBe(false)
    expect(current.discoveryError).toBe("")
  })

  test("keeps the last repository list when a navigation request is cancelled", async () => {
    const current = state()
    current.discoveredProjects = [{ worktree: "C:/repo/kept", name: "kept" }]
    const host = api([])
    vi.spyOn(host.host.git, "discover").mockRejectedValueOnce(
      new Error("opencode server GET /vcs/git/discover → 499 unknown: (empty response body)"),
    )

    await workbench.refreshDiscoveredProjects(host, current)

    expect(current.discoveredProjects).toEqual([{ worktree: "C:/repo/kept", name: "kept" }])
    expect(current.discoveryBusy).toBe(false)
    expect(current.discoveryError).toBe("")
  })
})

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe("Git Workbench text dialogs", () => {
  test("validates required multi-field input, trims values, and cancels without submitting", () => {
    const restorePrompt = rejectBrowserPrompt()
    const current = state()
    const submit = vi.fn()

    try {
      workbench.openTextDialog(current, {
        title: "Create branch",
        confirm: "Create branch",
        fields: [
          { id: "name", label: "New branch name", required: true },
          { id: "start", label: "Start point (optional)" },
        ],
        submit,
      })
      workbench.submitTextDialog(current, current.dialog!, { name: "   ", start: " main " })
      expect(submit).not.toHaveBeenCalled()
      expect(current.dialog?.values).toEqual({ name: "   ", start: " main " })
      expect(current.dialog?.error).toEqual({ field: "name", message: "New branch name is required." })

      workbench.closeTextDialog(current)
      expect(current.dialog).toBeUndefined()
      expect(submit).not.toHaveBeenCalled()

      workbench.openTextDialog(current, {
        title: "Create branch",
        confirm: "Create branch",
        fields: [
          { id: "name", label: "New branch name", required: true },
          { id: "start", label: "Start point (optional)" },
        ],
        submit,
      })
      workbench.submitTextDialog(current, current.dialog!, { name: " feature-name ", start: " main " })
      expect(submit).toHaveBeenCalledWith({ name: "feature-name", start: "main" })
    } finally {
      restorePrompt()
    }
  })

  test("passes branch and squash dialog values to the existing Git action contracts", async () => {
    const restorePrompt = rejectBrowserPrompt()
    const originalConfirm = globalThis.confirm
    globalThis.confirm = () => true
    const actions: Record<string, unknown>[] = []
    const current = state()
    const host = api(actions)

    try {
      workbench.promptCreateBranch(host, current)
      expect(current.dialog?.fields.map((field) => field.id)).toEqual(["name", "start"])
      await workbench.submitTextDialog(current, current.dialog!, { name: " local-smoke ", start: " main " })
      expect(actions[0]).toMatchObject({
        action: "createBranch",
        directory: "C:/repo",
        name: "local-smoke",
        start: "main",
      })

      workbench.promptSquash(host, current, {
        hash: "1111111111111111111111111111111111111111",
        subject: "feat: existing subject",
        parents: ["0000000000000000000000000000000000000000"],
      })
      expect(current.dialog?.values.message).toBe("feat: existing subject")
      await workbench.submitTextDialog(current, current.dialog!, { message: " squash message " })
      expect(actions[1]).toMatchObject({
        action: "squashRange",
        directory: "C:/repo",
        start: "0000000000000000000000000000000000000000",
        end: "1111111111111111111111111111111111111111",
        message: "squash message",
      })
    } finally {
      globalThis.confirm = originalConfirm
      restorePrompt()
    }
  })

  test("preserves both branch fields, focus, and selection through a renderAll rebuild", async () => {
    const restorePrompt = rejectBrowserPrompt()
    const current = state()
    const submit = vi.fn()
    const mounted = mountDialogRenderer(current)

    try {
      workbench.openTextDialog(current, {
        title: "Create branch",
        confirm: "Create branch",
        fields: [
          { id: "name", label: "New branch name", required: true, multiline: false },
          { id: "start", label: "Start point (optional)", multiline: false },
        ],
        submit,
      })
      await flush()
      const before = Array.from(mounted.element().querySelectorAll("input"))
      changeInput(before[0]!, "feature-preserved")
      changeInput(before[1]!, "origin/dev", 2, 7)
      before[1]!.focus()
      before[1]!.dispatchEvent(new Event("select", { bubbles: true }))

      workbench.renderAll(current)
      await flush()
      workbench.renderAll(current)
      await flush()

      const after = Array.from(mounted.element().querySelectorAll("input"))
      expect(after.map((input) => input.value)).toEqual(["feature-preserved", "origin/dev"])
      expect(document.activeElement).toBe(after[1])
      expect(after[1]?.selectionStart).toBe(2)
      expect(after[1]?.selectionEnd).toBe(7)

      mounted.element().querySelector<HTMLButtonElement>(".oc-git-workbench__button--primary")!.click()
      expect(submit).toHaveBeenCalledWith({ name: "feature-preserved", start: "origin/dev" })
      expect(current.dialog).toBeUndefined()
    } finally {
      mounted.dispose()
      restorePrompt()
    }
  })

  test("traps focus, closes on Escape after Tab, and keeps multiline Enter distinct from form submit", async () => {
    const restorePrompt = rejectBrowserPrompt()
    const current = state()
    const submitBranch = vi.fn()
    const mounted = mountDialogRenderer(current)

    try {
      workbench.openTextDialog(current, {
        title: "Create branch",
        confirm: "Create branch",
        fields: [
          { id: "name", label: "New branch name", required: true, multiline: false },
          { id: "start", label: "Start point (optional)", multiline: false },
        ],
        submit: submitBranch,
      })
      await flush()
      const controls = Array.from(mounted.element().querySelectorAll<HTMLElement>("input, button"))
      controls.at(-1)!.focus()
      controls.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(controls[0])
      controls[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
      )
      expect(document.activeElement).toBe(controls.at(-1)!)
      controls.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))
      expect(document.activeElement).toBe(controls[0])
      controls[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
      expect(current.dialog).toBeUndefined()

      workbench.openTextDialog(current, {
        title: "Create branch",
        confirm: "Create branch",
        fields: [
          { id: "name", label: "New branch name", required: true, multiline: false },
          { id: "start", label: "Start point (optional)", multiline: false },
        ],
        submit: submitBranch,
      })
      await flush()
      const branchInputs = Array.from(mounted.element().querySelectorAll("input"))
      changeInput(branchInputs[0]!, "enter-submit")
      changeInput(branchInputs[1]!, "dev")
      branchInputs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      expect(submitBranch).toHaveBeenCalledWith({ name: "enter-submit", start: "dev" })

      const submitSquash = vi.fn()
      workbench.openTextDialog(current, {
        title: "Squash commits",
        confirm: "Squash",
        fields: [{ id: "message", label: "Squash commit message", value: "Existing subject", required: true }],
        submit: submitSquash,
      })
      await flush()
      const textarea = mounted.element().querySelector("textarea")!
      changeInput(textarea, "Line one")
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
      expect(submitSquash).not.toHaveBeenCalled()
      expect(current.dialog).toBeDefined()
      mounted
        .element()
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      expect(submitSquash).toHaveBeenCalledWith({ message: "Line one" })
      expect(current.dialog).toBeUndefined()
    } finally {
      mounted.dispose()
      restorePrompt()
    }
  })
})

describe("Git Workbench action icons", () => {
  test("Resolve all and AI Commit use the workbench branch motif with distinct action marks", async () => {
    const assets = "../../../../.opencode/plugin-sources/git-workbench-app/assets/"
    const resolve = await Bun.file(new URL(`${assets}git-action-resolve-all.svg`, import.meta.url)).text()
    const commit = await Bun.file(new URL(`${assets}git-action-ai-commit.svg`, import.meta.url)).text()

    for (const [name, svg] of [
      ["resolve-all", resolve],
      ["ai-commit", commit],
    ]) {
      expect(svg).toContain('d="M7.5 7.5h9c4.7 0 7.5 2.8 7.5 7.5v5"')
      expect(svg).toContain("currentColor")
      expect(svg).not.toContain('color="white"')
      expect(
        await Bun.file(
          new URL(`${assets.replace("plugin-sources/", "plugins/")}git-action-${name}.svg`, import.meta.url),
        ).text(),
      ).toBe(svg)
    }
    expect(resolve).toContain('aria-label="Resolve all conflicts"')
    expect(resolve).not.toContain('d="m23.9 5.3')
    expect(commit).toContain('aria-label="AI commit"')
    expect(commit).toContain('d="m23.9 5.3')
  })
})

describe("Git Workbench conflict actions", () => {
  test("stages one conflict with Resolve and all conflicts with Resolve all", async () => {
    const current = state()
    const actions: Record<string, unknown>[] = []
    const section = workbench.renderConflicts(api(actions), current, {
      conflicts: [{ file: "src/one.ts" }, { file: "src/two.ts" }],
    })

    section.querySelector<HTMLButtonElement>('[aria-label="Resolve"]')!.click()
    await flush()
    expect(actions[0]).toMatchObject({ action: "stage", directory: "C:/repo", files: ["src/one.ts"] })

    const allActions: Record<string, unknown>[] = []
    const allSection = workbench.renderConflicts(api(allActions), state(), {
      conflicts: [{ file: "src/one.ts" }, { file: "src/two.ts" }],
    })
    allSection.querySelector<HTMLButtonElement>('[aria-label="Resolve all conflicts"]')!.click()
    await flush()
    expect(allActions[0]).toMatchObject({
      action: "stage",
      directory: "C:/repo",
      files: ["src/one.ts", "src/two.ts"],
    })
  })
})
