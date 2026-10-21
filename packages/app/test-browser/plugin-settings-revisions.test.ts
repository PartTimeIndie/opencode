import { createComputed, createRoot } from "solid-js"
import { expect, test } from "bun:test"
import {
  APP_PLUGIN_SETTINGS_CHANGED,
  APP_PLUGIN_SETTINGS_ITEM_CHANGED,
  dispatchAppPluginSettingsChanged,
  dispatchAppPluginSettingsItemChanged,
  subscribeAppPluginSettingsChanges,
} from "../src/plugin/app-plugin-settings-events"
import { createPluginSettingsRevisions } from "../src/components/settings-v2/plugin-settings-revisions"

test("plugin settings changes invalidate only their own settings panel", () => {
  const revisions = createPluginSettingsRevisions()
  let reviewRenders = 0
  let problemSolverRenders = 0

  createRoot((dispose) => {
    createComputed(() => {
      revisions.get("multi-agent-review-app")
      reviewRenders++
    })
    createComputed(() => {
      revisions.get("multi-agent-problem-solver-app")
      problemSolverRenders++
    })

    expect(reviewRenders).toBe(1)
    expect(problemSolverRenders).toBe(1)

    revisions.bump("multi-agent-review-app")
    expect(reviewRenders).toBe(2)
    expect(problemSolverRenders).toBe(1)

    revisions.bump()
    expect(reviewRenders).toBe(3)
    expect(problemSolverRenders).toBe(2)
    dispose()
  })
})

test("plugin settings changes and storage changes share scoped notifications", () => {
  const changes: (string | undefined)[] = []
  const unsubscribe = subscribeAppPluginSettingsChanges((pluginID) => changes.push(pluginID))

  dispatchAppPluginSettingsChanged("multi-agent-review-app", "reviewers")
  dispatchAppPluginSettingsItemChanged("multi-agent-problem-solver-app")
  unsubscribe()
  dispatchAppPluginSettingsItemChanged("ignored-after-cleanup")

  expect(changes).toEqual(["multi-agent-review-app", "multi-agent-problem-solver-app"])
})

test("production settings events rerun one of 100 plugin panels while the global path reruns all", () => {
  const pluginIDs = Array.from({ length: 100 }, (_, index) => `plugin-${index}`)
  const scoped = createPluginSettingsRevisions()
  const global = createPluginSettingsRevisions()
  const scopedRenders = new Map(pluginIDs.map((pluginID) => [pluginID, 0] as const))
  const globalRenders = new Map(pluginIDs.map((pluginID) => [pluginID, 0] as const))

  createRoot((dispose) => {
    pluginIDs.forEach((pluginID) => {
      createComputed(() => {
        scoped.get(pluginID)
        scopedRenders.set(pluginID, (scopedRenders.get(pluginID) ?? 0) + 1)
      })
      createComputed(() => {
        global.get(pluginID)
        globalRenders.set(pluginID, (globalRenders.get(pluginID) ?? 0) + 1)
      })
    })

    const unsubscribe = subscribeAppPluginSettingsChanges((pluginID) => scoped.bump(pluginID))
    dispatchAppPluginSettingsChanged("plugin-50", "reviewers")
    expect([...scopedRenders.values()].filter((count) => count === 2)).toHaveLength(1)
    expect([...scopedRenders.values()].filter((count) => count === 1)).toHaveLength(99)

    dispatchAppPluginSettingsItemChanged("plugin-50")
    expect(scopedRenders.get("plugin-50")).toBe(3)
    expect([...scopedRenders.values()].filter((count) => count === 1)).toHaveLength(99)

    global.bump()
    expect([...globalRenders.values()].filter((count) => count === 2)).toHaveLength(100)
    unsubscribe()
    dispose()
  })
})
