import { describe, expect, test } from "bun:test"
import { parse } from "jsonc-parser"
import { createComposerRegistry } from "./composer-registry"
import type { AppHostComposerTarget, AppHostComposerBeforeSubmitHandler } from "@opencode-ai/plugin/app"
import {
  filterToolbarItems,
  moveToolbarItemIDs,
  orderToolbarItems,
  toolbarItemEnabled,
  type ToolbarContext,
  type ToolbarItemLike,
} from "./toolbar"

const composerLeftContext: ToolbarContext = {
  placement: "composer",
  align: "left",
  directory: "C:/repo",
  sessionID: "ses_1",
}

describe("plugin toolbar filtering", () => {
  test("defaults toolbar items to the top right placement", () => {
    const items: ToolbarItemLike[] = [
      { id: "default", title: "Default" },
      { id: "composer", title: "Composer", placement: "composer", align: "right" },
    ]

    expect(filterToolbarItems(items, { placement: "top", align: "right" }).map((item) => item.id)).toEqual(["default"])
    expect(filterToolbarItems(items, composerLeftContext).map((item) => item.id)).toEqual([])
  })

  test("sorts composer left and right groups independently", () => {
    const items: ToolbarItemLike[] = [
      { id: "right-late", title: "Right Late", placement: "composer", align: "right", order: 20 },
      { id: "left-late", title: "Left Late", placement: "composer", align: "left", order: 20 },
      { id: "left-early", title: "Left Early", placement: "composer", align: "left", order: 10 },
      { id: "right-early", title: "Right Early", placement: "composer", align: "right", order: 10 },
    ]

    expect(filterToolbarItems(items, composerLeftContext).map((item) => item.id)).toEqual(["left-early", "left-late"])
    expect(filterToolbarItems(items, { placement: "composer", align: "right" }).map((item) => item.id)).toEqual([
      "right-early",
      "right-late",
    ])
  })

  test("applies a saved user order before plugin defaults", () => {
    const items: ToolbarItemLike[] = [
      { id: "early", title: "Early", order: 10 },
      { id: "late", title: "Late", order: 20 },
      { id: "new", title: "New", order: 5 },
    ]

    expect(orderToolbarItems(items, ["late", "early"]).map((item) => item.id)).toEqual(["late", "early", "new"])
    expect(
      filterToolbarItems(items, { placement: "top", align: "right" }, ["late", "early"]).map((item) => item.id),
    ).toEqual(["late", "early", "new"])
  })

  test("moves toolbar item ids without crossing list boundaries", () => {
    const items: ToolbarItemLike[] = [
      { id: "first", title: "First" },
      { id: "second", title: "Second" },
      { id: "third", title: "Third" },
    ]

    expect(moveToolbarItemIDs(items, "second", "up")).toEqual(["second", "first", "third"])
    expect(moveToolbarItemIDs(items, "second", "down")).toEqual(["first", "third", "second"])
    expect(moveToolbarItemIDs(items, "first", "up")).toEqual(["first", "second", "third"])
    expect(moveToolbarItemIDs(items, "third", "down")).toEqual(["first", "second", "third"])
  })

  test("moves within placement and alignment groups while preserving interleaved items", () => {
    const items: ToolbarItemLike[] = [
      { id: "left-first", title: "Left First", placement: "composer", align: "left" },
      { id: "right-only", title: "Right Only", placement: "composer", align: "right" },
      { id: "left-second", title: "Left Second", placement: "composer", align: "left" },
      { id: "top-only", title: "Top Only", placement: "top", align: "right" },
    ]

    expect(moveToolbarItemIDs(items, "left-second", "up")).toEqual([
      "left-second",
      "right-only",
      "left-first",
      "top-only",
    ])
    expect(moveToolbarItemIDs(items, "right-only", "up")).toEqual([
      "left-first",
      "right-only",
      "left-second",
      "top-only",
    ])
  })

  test("uses visible context to hide toolbar items", () => {
    const items: ToolbarItemLike[] = [
      { id: "hidden", title: "Hidden", placement: "composer", visible: () => false },
      {
        id: "project",
        title: "Project",
        placement: "composer",
        visible: (context) => Boolean(context.directory),
      },
    ]

    expect(filterToolbarItems(items, composerLeftContext).map((item) => item.id)).toEqual(["project"])
    expect(filterToolbarItems(items, { placement: "composer", align: "left" }).map((item) => item.id)).toEqual([])
  })

  test("keeps disabled toolbar items renderable", () => {
    const items: ToolbarItemLike[] = [
      { id: "disabled", title: "Disabled", placement: "composer", enabled: () => false },
    ]

    expect(filterToolbarItems(items, composerLeftContext).map((item) => item.id)).toEqual(["disabled"])
    expect(toolbarItemEnabled(items[0]!, composerLeftContext)).toBe(false)
  })
})

describe("git workbench toolbar registration", () => {
  test("keeps the old toolbar setting as composer commit fallback", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugins/git-workbench-app/index.js", import.meta.url),
    ).text()

    expect(source).toContain('key: "showComposerCommit"')
    expect(source).toContain('key: "commitChain"')
    expect(source).toContain('type: "model-target"')
    expect(source).toContain('commitChain: "chain:default"')
    expect(source).toContain('api.settings.get("showToolbarCommit", DEFAULT_SETTINGS.showComposerCommit)')
    expect(source).toContain('id: "aiCommit"')
    expect(source).toContain('title: "Commit All Open Changes"')
    expect(source).toContain('icon: { src: TOOLBAR_ICON, alt: "Commit All Open Changes", size: "large" }')
    expect(source).toContain('placement: "composer"')
    expect(source).toContain('align: "right"')
    expect(source).toContain("order: 70")
    expect(source).toContain("visible: () => true")
    expect(source).toContain("enabled: () => !busy")
    expect(source).toContain("await runCommitAllOpenChanges(api, state, ctx)")
    expect(source).toContain("runCommitAllOpenChanges(api, state, { directory: selectedDirectory(api, state) })")
    expect(source).not.toContain("runCommitAllOpenChanges(api, state, api.host.navigation.current())")
    expect(source).toContain("api.host.git.snapshot({ directory, limit: state.settings.historyLimit })")
    expect(source).toContain("api.host.git.discover({ directory, maxDepth: 3 })")
    expect(source).toContain("commitTargetForSession(state.commitTargets, sessionID, directory)")
    expect(source).toContain("api.host.git.discover({ directory, maxDepth: 3 })")
    expect(source).toContain('title: "Choose repository to commit"')
    expect(source).toContain('api.kv.set("commitTargetsBySession", state.commitTargets)')
    expect(source).toContain("const busy = state.commitBusy === true")
    expect(source).toContain("setCommitBusy(state, true)")
    expect(source).toContain("cancel: () => setCommitBusy(state, false)")
    expect(source).toContain("composerToolbarBusy: undefined")
    expect(source).toContain("state.syncComposerToolbar = syncComposerToolbar")
    expect(source).toContain("state.syncComposerToolbar?.()")
    expect(source).toContain('setBusy(state, "refresh")')
    expect(source).not.toContain("&& !state.busy")
    expect(source).toContain("if (state.busy) return")
    expect(source).toContain("await refreshWorkbench(api, state, { force: true })")
    expect(source).toContain("() => refreshWorkbench(api, state)")
    expect(source).toContain("Boolean(state.busy || state.discoveryBusy)")
    expect(source).toContain('textButton("Refresh", () => refreshWorkbench(api, state)')
    expect(source).not.toContain('textButton("Refresh", () => refreshSnapshot(api, state)')
    expect(source).toContain('appendProjectGroup(select, "Open projects", groups.projects)')
    expect(source).toContain('appendProjectGroup(select, "Discovered repositories", groups.discovered)')
    expect(source).toContain("{ requireDangerActions: false }")
    expect(source).toContain("context?.directory || selectedDirectory(api, state)")
    expect(source).toContain("const directory = context.directory || selectedDirectory(api, state)")
    expect(source).toContain(
      "api.host.navigation.subscribe((navigation, event) => syncNavigationDirectory(api, state, navigation, event))",
    )
    expect(source).toContain("if (!event?.activated && state.directory) return")
    expect(source).toContain("if (state.directory !== directory) return")
    expect(source).toContain("color-scheme: inherit")
    expect(source).toContain(".oc-git-workbench__project-select option")
    expect(source).toContain("background: var(--surface-panel, var(--background-stronger))")
    expect(source).toContain("state.settings.showDangerActions && commit.parents?.[0]")
    expect(source).toContain("Cherry-pick ${commit.short || commit.hash.slice(0, 12)}")
    expect(source).toContain("Merge ${branch.name} into the current branch?")
    expect(source).toContain('label: "New branch name"')
    expect(source).toContain('label: "Start point (optional)"')
    expect(source).toContain('label: "Squash commit message"')
    expect(source).not.toContain("window.prompt")
    expect(source).not.toContain('key: "showToolbarCommit"')
    expect(source).not.toContain('id: "stageAllChanges"')
  })
})

describe("local desktop deploy toolbar registration", () => {
  test("keeps the deploy button visible in Windows web when host commands are available", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugins/local-desktop-deploy-app/index.js", import.meta.url),
    ).text()

    expect(source).toContain("canRunHostCommand(api)")
    expect(source).toContain("isWindowsHost()")
    expect(source).toContain("api.ui.loading.with")
    expect(source).toContain("HANDOFF_TIMEOUT_MS = 30 * 1000")
    expect(source).toContain("timeoutMs: HANDOFF_TIMEOUT_MS")
    expect(source).toContain('deployCommandScript(["automatic", "--detach"')
    expect(source).toContain('"--approved-close"')
    expect(source).toContain('"--force-close-approved"')
    expect(source).toContain('"--restart"')
    expect(source).toContain('deployCommandScript(["status"])')
    expect(source).toContain("currentDeployStatus(api, ctx.directory)")
    expect(source).not.toContain("deploy-asar.ts")
    expect(source).not.toContain("app.asar")
    expect(source).not.toContain("window.api.relaunch()")
    expect(source).toContain('title: "Build and Deploy"')
    expect(source).toContain("COMPOSER_TOOLBAR_ORDER = 60")
    expect(source).not.toContain("canRunHostCommand(api) && canRelaunch()")
  })
})

describe("progressive plan builder toolbar registration", () => {
  test("registers an always-enabled composer toggle immediately after prompt improve", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/progressive-plan-builder-app/index.js", import.meta.url),
    ).text()
    const config = await Bun.file(new URL("../../../../.opencode/app.jsonc", import.meta.url)).text()

    expect(config).toContain("./plugins/progressive-plan-builder-app")
    expect(source).toContain('id: "progressivePlanBuilder"')
    expect(source).toContain("order: 51")
    expect(source).toContain('placement: "composer"')
    expect(source).toContain('align: "right"')
    expect(source).toContain("appendOnSubmit: true")
    expect(source).toContain('name: "progressive-plan-builder"')
    expect(source).not.toContain("enabled:")
    expect(source).not.toContain("visible:")
  })
})

describe("prompt improve toolbar registration", () => {
  test("keeps prompt improve after the review toggles", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugins/prompt-improve-app/index.js", import.meta.url),
    ).text()
    const manifest = await Bun.file(
      new URL("../../../../.opencode/plugins/prompt-improve-app/package.json", import.meta.url),
    ).json()
    const config = await Bun.file(new URL("../../../../.opencode/app.jsonc", import.meta.url)).text()

    expect(config).toContain("./plugins/prompt-improve-app")
    expect(manifest.opencode.app.capabilities).toContain("host:ai")
    expect(source).toContain('id: "promptImprove"')
    expect(source).toContain('title: "Improve Prompt"')
    expect(source).toContain('placement: "composer"')
    expect(source).toContain('align: "right"')
    expect(source).toContain("order: 50")
    expect(source).toContain('kind: "mount"')
    expect(source).toContain('modelChain: "chain:default"')
    expect(source).toContain('type: "model-target"')
    expect(source).toContain("autoSelectDefault: true")
    expect(source).not.toContain("openai/gpt-5.5")
    expect(source).toContain('key: "promptTemplate"')
    expect(source).toContain('type: "textarea"')
    expect(source).toContain('"{prompt}"')
    expect(source).not.toContain('returnAfter: "sentence"')
    expect(source).not.toContain("maxTokens: 60")
    expect(source).toContain("function promptImproveMaxTokens(prompt)")
    expect(source).toContain("generation: { maxTokens: promptImproveMaxTokens(prompt), temperature: 0 }")
    expect(source).toContain("tools: []")
    expect(source).toContain("function promptImproveUserPrompt(prompt, template)")
    expect(source).toContain("function unwrapMarkdownFence(text)")
    expect(source).toContain("function promptFromJson(text)")
    expect(source).toContain("JSON.parse(text)")
    expect(source).toContain('"improvedPrompt"')
    expect(source).toContain("function stripPromptLabel(text)")
    expect(source).toContain("function decodeCommonEscapes(text)")
    expect(source).not.toContain("function textOnlyPromptRewrite(prompt)")
    expect(source).not.toContain("optimisticApplied")
    expect(source).toContain("expectedText: composer.text")
    expect(source).toContain('console.info("[prompt-improve-app] timing"')
    expect(source).not.toContain("enabled:")
    expect(source).not.toContain("visible:")
  })
})

describe("visual qa toolbar registration", () => {
  test("keeps the project-local toggle active as the first right composer plugin", async () => {
    const config = await Bun.file(new URL("../../../../.opencode/app.jsonc", import.meta.url)).text()

    expect(config).toContain("./plugins/visual-qa-app")
  })

  test("keeps the optional project-local toggle scoped to the mounted composer", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/visual-qa-app/index.js", import.meta.url),
    ).text()
    const icon = await Bun.file(
      new URL("../../../../.opencode/plugins/visual-qa-app/assets/visual-qa.svg", import.meta.url),
    ).text()

    expect(source).toContain("order: 10")
    expect(source).toContain("appendOnSubmit: true")
    expect(source).toContain('name: "visual-qa-testing"')
    expect(source).not.toContain("api.kv")
    expect(source).not.toContain("ACTIVE_KEY")
    expect(icon).not.toContain('color="white"')
  })
})

describe("session navigator dock registration", () => {
  test("opens itself through the dock API without DOM tab clicks", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url),
    ).text()

    expect(source).toContain('AUTO_OPEN_STORAGE_KEY = "opencode.app-plugin.session-navigator-app.auto-opened.v1"')
    expect(source).toContain('const previous = api.dock.state.item("sessionNavigator")')
    expect(source).toContain('defaultArea: "left"')
    expect(source).toContain('if (localStorage.getItem(AUTO_OPEN_STORAGE_KEY) !== "true")')
    expect(source).toContain('api.dock.open.item("sessionNavigator", { area: previous.area ?? "left", reveal: false })')
    expect(source).toContain('localStorage.setItem(AUTO_OPEN_STORAGE_KEY, "true")')
    expect(source).not.toContain("document.querySelector")
    expect(source).not.toContain("data-dock-tab")
    expect(source).not.toContain("[0, 1000, 3000, 7000, 12000]")
  })
})

describe("multi-agent review toolbar registration", () => {
  test("registers an always-enabled composer toggle", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/multi-agent-review-app/index.js", import.meta.url),
    ).text()
    const config = await Bun.file(new URL("../../../../.opencode/app.jsonc", import.meta.url)).text()
    const opencodeConfig = await Bun.file(new URL("../../../../.opencode/opencode.jsonc", import.meta.url)).text()
    const projectSkill = Bun.file(new URL("../../../../.opencode/skills/multi-agent-review/SKILL.md", import.meta.url))

    expect(config).toContain("./plugins/multi-agent-review-app")
    expect(source).toContain('id: "multiAgentReview"')
    expect(source).toContain('SKILL_REFERENCE = "/multi-agent-review"')
    expect(source).toContain("order: 30")
    expect(source).toContain('placement: "composer"')
    expect(source).toContain('align: "right"')
    expect(source).toContain("appendOnSubmit: true")
    expect(source).toContain('name: "multi-agent-review"')
    expect(source).not.toContain("api.kv")
    expect(source).not.toContain("ACTIVE_KEY")
    expect(
      await Bun.file(
        new URL("../../../../.opencode/plugins/multi-agent-review-app/assets/multi-agent-review.svg", import.meta.url),
      ).text(),
    ).not.toContain('color="white"')
    expect(opencodeConfig).toContain('"review-code-simplifier"')
    expect(opencodeConfig).toContain('"daily-review-code-simplifier"')
    expect(opencodeConfig).toContain('"orchestrator-gpt-5-6-luna-max"')
    expect(opencodeConfig).toContain('"research-opencode-glm-5-3"')
    expect(opencodeConfig).toContain('"daily-review-opencode-glm-5-3"')
    expect(opencodeConfig).toContain('"zhipuai-coding-plan/glm-5.3"')
    expect(opencodeConfig).toContain('"skill": "allow"')
    expect(await projectSkill.exists()).toBe(false)
    expect(source).not.toContain("enabled:")
    expect(source).not.toContain("visible:")
  })

  test("pins the daily review scheduler agents to the GLM 5.3 high model contract", async () => {
    const jsonc = await Bun.file(new URL("../../../../.opencode/opencode.jsonc", import.meta.url)).text()
    const parsed = parse(jsonc, [], { allowTrailingComma: true }) as {
      agent: Record<string, { model?: string; variant?: string; description?: string }>
    }
    for (const key of ["daily-review-gpt-xhigh", "daily-review-gpt-high", "daily-review-code-simplifier"]) {
      const agent = parsed.agent[key]
      expect(agent, `missing agent definition for ${key}`).toBeDefined()
      expect(agent?.model, `model drift for ${key}`).toBe("zhipuai-coding-plan/glm-5.3")
      expect(agent?.variant, `variant drift for ${key}`).toBe("high")
      expect(agent?.description ?? "", `stale model name in description for ${key}`).toContain("GLM 5.3 High")
      expect(agent?.description ?? "", `stale model name in description for ${key}`).not.toContain("GPT-5.6")
    }
  })
})

describe("multi-agent problem solver toolbar registration", () => {
  test("registers after multi-agent review and before prompt improve", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/multi-agent-problem-solver-app/index.js", import.meta.url),
    ).text()
    const config = await Bun.file(new URL("../../../../.opencode/app.jsonc", import.meta.url)).text()
    const projectSkill = Bun.file(
      new URL("../../../../.opencode/skills/multi-agent-problem-solver/SKILL.md", import.meta.url),
    )

    expect(config).toContain("./plugins/multi-agent-problem-solver-app")
    expect(source).toContain('id: "multiAgentProblemSolver"')
    expect(source).toContain('SKILL_REFERENCE = "/multi-agent-problem-solver"')
    expect(source).toContain("COMPOSER_TOOLBAR_ORDER = 40")
    expect(source).toContain('placement: "composer"')
    expect(source).toContain('align: "right"')
    expect(source).toContain('kind: "mount"')
    expect(source).toContain("detail.appendText(SKILL_REFERENCE)")
    expect(source).toContain("const toolbarContext = mountContext.context ?? {}")
    expect(source).toContain("mountContext.element.replaceChildren(button)")
    expect(source).toContain("api.host.composer.beforeSubmit(toolbarContext, onBeforeSubmit)")
    expect(source).toContain("previous?.composerID === toolbarContext.composerID")
    expect(source).not.toContain("api.kv")
    expect(source).not.toContain("ACTIVE_KEY")
    expect(
      await Bun.file(
        new URL(
          "../../../../.opencode/plugins/multi-agent-problem-solver-app/assets/multi-agent-problem-solver.svg",
          import.meta.url,
        ),
      ).text(),
    ).not.toContain('color="white"')
    expect(await projectSkill.exists()).toBe(false)
    expect(source).not.toContain("enabled:")
    expect(source).not.toContain("visible:")
  })
})

describe("goal toolbar registration", () => {
  test("registers a composer mount that prefixes /goal through host.composer", async () => {
    const source = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/goal-app/index.js", import.meta.url),
    ).text()
    const manifest = await Bun.file(
      new URL("../../../../.opencode/plugin-sources/goal-app/package.json", import.meta.url),
    ).json()
    const config = await Bun.file(new URL("../../../../.opencode/app.jsonc", import.meta.url)).text()
    const command = Bun.file(new URL("../../../../.opencode/command/goal.md", import.meta.url))

    expect(config).toContain("./plugins/goal-app")
    expect(manifest.opencode.app.capabilities).toContain("ui:toolbar")
    expect(manifest.opencode.app.capabilities).toContain("host:composer")
    expect(manifest.opencode.app.capabilities).not.toContain("client")
    expect(await command.exists()).toBe(true)
    expect(source).toContain('id: "sessionGoal"')
    expect(source).toContain("COMPOSER_TOOLBAR_ORDER = 55")
    expect(source).toContain('placement: "composer"')
    expect(source).toContain('align: "right"')
    expect(source).toContain('kind: "mount"')
    expect(source).toContain("const toolbarContext = mountContext.context ?? {}")
    expect(source).toContain("api.host.composer.read(toolbarContext)")
    expect(source).toContain("api.host.composer.change({")
    expect(source).toContain("expectedText: text")
    expect(source).not.toContain("api.client.session.update")
    expect(source).toContain('dataset.action = "session-goal"')
  })
})

test("next-message toolbar toggles preserve active state across remounts", async () => {
  type Registration = {
    mount: (context: {
      element: HTMLElement
      context: { placement: "composer"; align: "right"; directory: string; sessionID: string; composerID: string }
    }) => (() => void) | void
  }

  await Promise.all(
    ["multi-agent-problem-solver-app"].map(async (id) => {
      const source = new URL(`../../../../.opencode/plugin-sources/${id}/index.js`, import.meta.url)
      const registrations: Registration[] = []
      const plugin = (await import(source.href)) as {
        default: {
          app: (api: {
            toolbar: { register: (item: Registration) => void }
            settings: { register: (settings: unknown) => () => void }
            signal: AbortSignal
            client: { global: { config: { get: (input: { throwOnError: boolean; signal: AbortSignal }) => Promise<{ data?: unknown }> } } }
            host: {
              composer: {
                beforeSubmit(target: AppHostComposerTarget, handler: AppHostComposerBeforeSubmitHandler): () => void
              }
            }
          }) => void
        }
      }
      const registry = createComposerRegistry()
      plugin.default.app({
        toolbar: { register: (item) => registrations.push(item) },
        settings: { register: () => () => {} },
        signal: new AbortController().signal,
        client: { global: { config: { get: async () => ({ data: {} }) } } },
        host: {
          composer: {
            beforeSubmit: (target, handler) => registry.beforeSubmit({ ...target, serverID: "test" }, handler),
          },
        },
      })

      expect(registrations).toHaveLength(1)

      const element = document.createElement("div")
      const context = {
        element,
        context: {
          placement: "composer" as const,
          align: "right" as const,
          directory: "C:/OpenCode/One",
          sessionID: "ses_one",
          composerID: "composer_one",
        },
      }
      const cleanup = registrations[0]!.mount(context)
      element.querySelector<HTMLButtonElement>("button")!.click()
      expect(element.querySelector("button")?.getAttribute("aria-pressed")).toBe("true")
      cleanup?.()

      const remountCleanup = registrations[0]!.mount(context)
      expect(element.querySelector("button")?.getAttribute("aria-pressed")).toBe("true")
      remountCleanup?.()

      const nextContextCleanup = registrations[0]!.mount({
        ...context,
        context: { ...context.context, sessionID: "ses_two" },
      })
      expect(element.querySelector("button")?.getAttribute("aria-pressed")).toBe("false")
      nextContextCleanup?.()
    }),
  )
})

test("generated plugin runtime parity after coordinated plugin release", async () => {
  for (const id of ["visual-qa-app", "multi-agent-review-app", "progressive-plan-builder-app", "multi-agent-problem-solver-app"]) {
    const runtime = new URL(`../../../../.opencode/plugins/${id}/index.js`, import.meta.url)
    const source = new URL(`../../../../.opencode/plugin-sources/${id}/index.js`, import.meta.url)
    expect((await Bun.file(runtime).text()).replaceAll("\r\n", "\n")).toBe(
      (await Bun.file(source).text()).replaceAll("\r\n", "\n"),
    )
  }
})
