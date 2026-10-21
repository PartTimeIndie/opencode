import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { BrowserTool } from "@opencode-ai/core/tool/browser"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_browser_tool_test")
const actions: Record<string, unknown>[] = []
const assertions: PermissionV2.AssertInput[] = []
let browserAvailable = true
let browserStatusError: Error | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    materializationRules: () => Effect.succeed([]),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const capabilities = Layer.succeed(
  CapabilityLease.Service,
  CapabilityLease.Service.of({
    activate: () => Effect.die("unused"),
    snapshot: () => Effect.succeed({ browser_read: 1, browser_write: 2 }),
    valid: () => Effect.succeed(true),
    revoke: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission), Layer.provide(capabilities))
const bridge = BrowserTool.bridgeLayer({
  action: async (action) => {
    actions.push(action)
    if (action.type === "browser.status" && browserStatusError) throw browserStatusError
    if (action.type === "browser.status")
      return browserAvailable
        ? {
            browser: {
              mode: "webview",
              url: "http://localhost:3000/",
              actualURL: "http://localhost:3000/current",
            },
          }
        : { browser: undefined }
    if (action.type === "browser.snapshot")
      return {
        url: "http://localhost:3000/",
        title: "Browser target",
        text: "Hello",
        accessibility: '- heading "Hello" [level=1]',
        elements: [
          { ref: "e1", tag: "button", role: "button", name: "Save", type: "submit", value: "", disabled: false },
        ],
        evidence: { console: ["[warning] slow"], network: ["[404] GET http://localhost:3000/missing"] },
        screenshotBase64: "aW1hZ2U=",
      }
    if (action.type === "browser.wait" && action.ref) return { url: "http://localhost:3000/", waited: action.ref }
    if (action.type === "browser.wait") return { url: "http://localhost:3000/next", title: "Next" }
    return { url: "http://localhost:3000/", title: "Browser target" }
  },
})
const tools = BrowserTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(bridge))
const it = testEffect(Layer.mergeAll(registry, permission, capabilities, bridge, tools))

const reset = () => {
  actions.length = 0
  assertions.length = 0
  browserAvailable = true
  browserStatusError = undefined
}

const call = (name: string, input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name, input },
})

describe("BrowserTool", () => {
  it.effect("registers bounded native Browser Dock tools under separate read and write permissions", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      expect(
        (
          yield* toolDefinitions(registry, undefined, undefined, {
            sessionID,
            agent: toolIdentity.agent,
          })
        ).map((tool) => tool.name),
      ).toEqual([
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_navigate",
        "browser_wait",
      ])
    }),
  )

  it.effect("returns text, accessibility, element refs, evidence, and an optional screenshot attachment", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call("browser_snapshot", { screenshot: true }))

      expect(settled.output?.content).toHaveLength(2)
      expect(settled.output?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("[e1] <button> role=button"),
      })
      expect(settled.output?.content[1]).toMatchObject({ type: "file", mime: "image/jpeg", name: "browser.jpg" })
      expect(actions).toEqual([
        { type: "browser.status" },
        {
          type: "browser.snapshot",
          screenshot: true,
          maxTextChars: 20_000,
          maxElements: 150,
          expectedOrigin: "http://localhost:3000",
        },
      ])
      expect(assertions).toMatchObject([
        {
          action: "browser_read",
          resources: ["http://localhost:3000"],
          save: ["http://localhost:3000"],
        },
      ])
    }),
  )

  it.effect("normalizes an unavailable Browser Dock into an actionable tool error", () =>
    Effect.gen(function* () {
      reset()
      browserAvailable = false
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call("browser_snapshot", {}))).toEqual({
        type: "error",
        value: "No active Browser Dock webview is available. Call browser_navigate with an HTTP(S) URL first.",
      })
      expect(JSON.stringify(yield* executeTool(registry, call("browser_snapshot", {})))).not.toContain(
        "An error occurred in Effect.tryPromise",
      )
    }),
  )

  it.effect("unwraps the concrete desktop bridge cause from Effect promise failures", () =>
    Effect.gen(function* () {
      reset()
      browserStatusError = new Error("An error occurred in Effect.tryPromise", {
        cause: new Error("Desktop Browser bridge failed (409): no active Browser Dock webview"),
      })
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call("browser_snapshot", {}))).toEqual({
        type: "error",
        value: "Desktop Browser bridge failed (409): no active Browser Dock webview",
      })
    }),
  )

  it.effect("uses snapshot refs for click, type, and wait without arbitrary script execution", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, call("browser_click", { ref: "e1" }))
      yield* executeTool(registry, call("browser_type", { ref: "e2", text: "hello", pressEnter: true }))
      expect(yield* executeTool(registry, call("browser_wait", { ref: "e3" }))).toEqual({
        type: "text",
        value: "Browser wait completed (e3) on http://localhost:3000/.",
      })

      expect(actions).toEqual([
        { type: "browser.status" },
        {
          type: "browser.click",
          ref: "e1",
          button: "left",
          timeout: 10_000,
          expectedOrigin: "http://localhost:3000",
        },
        { type: "browser.status" },
        {
          type: "browser.type",
          ref: "e2",
          text: "hello",
          clear: true,
          pressEnter: true,
          timeout: 10_000,
          expectedOrigin: "http://localhost:3000",
        },
        { type: "browser.status" },
        {
          type: "browser.wait",
          ref: "e3",
          state: "visible",
          timeout: 15_000,
          expectedOrigin: "http://localhost:3000",
        },
      ])
      expect(assertions.map((item) => item.action)).toEqual(["browser_write", "browser_write", "browser_read"])
      expect(assertions.map((item) => item.resources)).toEqual([
        ["http://localhost:3000"],
        ["http://localhost:3000"],
        ["http://localhost:3000"],
      ])
      expect(assertions[1]?.metadata).toEqual({ type: "browser.type", ref: "e2", textLength: 5 })
      expect(JSON.stringify(assertions)).not.toContain("hello")
    }),
  )

  it.effect("navigates only HTTP(S) URLs and waits for the active page", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      expect(
        yield* executeTool(registry, call("browser_navigate", { url: "https://example.com", newTab: true })),
      ).toEqual({ type: "text", value: "Browser Dock navigated to http://localhost:3000/next (Next)." })
      expect(actions).toEqual([
        { type: "browser.open", url: "https://example.com", expectedOrigin: "https://example.com" },
        { type: "browser.wait", state: "visible", timeout: 15_000, expectedOrigin: "https://example.com" },
      ])
      expect(assertions).toMatchObject([
        {
          action: "browser_write",
          resources: ["https://example.com"],
          save: ["https://example.com"],
        },
      ])

      reset()
      expect(yield* executeTool(registry, call("browser_navigate", { url: "file:///secret" }))).toEqual({
        type: "error",
        value: "Invalid tool input: url must use http:// or https://",
      })
      expect(actions).toEqual([])
      expect(assertions).toEqual([])
    }),
  )

  it.effect("rejects ambiguous selectors before calling the desktop bridge", () =>
    Effect.gen(function* () {
      reset()
      const registry = yield* ToolRegistry.Service
      expect(yield* executeTool(registry, call("browser_click", { ref: "e1", selector: "button" }))).toEqual({
        type: "error",
        value: "Invalid tool input: provide either ref or selector, not both",
      })
      expect(actions).toEqual([])
    }),
  )

  test("does not advertise Browser Dock tools outside an active Desktop bridge", () => {
    expect(
      BrowserTool.isDesktopAvailable({ OPENCODE_CLIENT: "cli", OPENCODE_DESKTOP_BRIDGE_FILE: "bridge.json" }),
    ).toBe(false)
    expect(BrowserTool.isDesktopAvailable({ OPENCODE_CLIENT: "desktop" })).toBe(false)
    expect(
      BrowserTool.isDesktopAvailable({ OPENCODE_CLIENT: "desktop", OPENCODE_DESKTOP_BRIDGE_FILE: "bridge.json" }),
    ).toBe(true)
  })
})
