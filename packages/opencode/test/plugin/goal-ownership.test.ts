import { describe, expect, test } from "bun:test"
import { createGoalOwnershipRegistry } from "@/plugin/completion"

describe("goalOwnershipRegistry", () => {
  test("a registered active goal owns its session; unregistered sessions do not", async () => {
    const registry = createGoalOwnershipRegistry()
    const release = registry.register("C:/repo", ({ sessionID }) => sessionID === "ses_goal")
    expect(await registry.owned("C:/repo", "ses_goal")).toBe(true)
    expect(await registry.owned("C:/repo", "ses_other")).toBe(false)
    expect(await registry.owned("C:/other", "ses_goal")).toBe(false)
    release()
    expect(await registry.owned("C:/repo", "ses_goal")).toBe(false)
  })

  test("a policy error fails closed to owned so the host owner stands down", async () => {
    const registry = createGoalOwnershipRegistry()
    const release = registry.register("C:/repo", () => {
      throw new Error("plugin crashed")
    })
    try {
      expect(await registry.owned("C:/repo", "ses_goal")).toBe(true)
    } finally {
      release()
    }
  })

  test("a hung policy times out fail-closed to owned", async () => {
    const registry = createGoalOwnershipRegistry(10)
    const release = registry.register("C:/repo", () => new Promise<boolean>(() => {}))
    try {
      expect(await registry.owned("C:/repo", "ses_goal")).toBe(true)
    } finally {
      release()
    }
  })

  test("a policy returning false does not claim ownership", async () => {
    const registry = createGoalOwnershipRegistry()
    const release = registry.register("C:/repo", async () => false)
    try {
      expect(await registry.owned("C:/repo", "ses_goal")).toBe(false)
    } finally {
      release()
    }
  })

  test("ownedSync answers synchronously and fails closed for async or throwing policies", () => {
    const registry = createGoalOwnershipRegistry()
    const releaseSync = registry.register("C:/repo", ({ sessionID }) => sessionID === "ses_goal")
    expect(registry.ownedSync("C:/repo", "ses_goal")).toBe(true)
    expect(registry.ownedSync("C:/repo", "ses_other")).toBe(false)
    releaseSync()

    const releaseAsync = registry.register("C:/repo", () => Promise.resolve(false))
    try {
      expect(registry.ownedSync("C:/repo", "ses_goal")).toBe(true)
    } finally {
      releaseAsync()
    }

    const releaseThrow = registry.register("C:/repo", () => {
      throw new Error("crashed")
    })
    try {
      expect(registry.ownedSync("C:/repo", "ses_goal")).toBe(true)
    } finally {
      releaseThrow()
    }

    expect(registry.ownedSync("C:/other", "ses_goal")).toBe(false)
  })

  test("ownedSync consumes a rejected asynchronous policy while failing closed", async () => {
    const registry = createGoalOwnershipRegistry()
    const release = registry.register("C:/repo", async () => {
      await Promise.resolve()
      throw new Error("late plugin failure")
    })
    try {
      expect(registry.ownedSync("C:/repo", "ses_goal")).toBe(true)
      await Bun.sleep(10)
    } finally {
      release()
    }
  })
})
