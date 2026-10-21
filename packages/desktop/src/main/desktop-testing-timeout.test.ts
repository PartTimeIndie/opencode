import { describe, expect, test } from "bun:test"
import { desktopTestingRendererTimeout } from "./desktop-testing-timeout"

describe("desktopTestingRendererTimeout", () => {
  test("allows provider-backed plugin automation to finish", () => {
    expect(desktopTestingRendererTimeout("action", { type: "plugin.automation.run" })).toBe(120_000)
  })

  test("gives session admission time to finish after the UI is opened", () => {
    expect(desktopTestingRendererTimeout("action", { type: "session.open", sessionID: "session-1" })).toBe(60_000)
  })

  test("allows a cold session prompt to cross a thirty-second admission warmup", () => {
    expect(desktopTestingRendererTimeout("action", { type: "session.prompt", sessionID: "session-1" })).toBe(60_000)
  })

  test("allows a durable question reply to cross a thirty-second admission warmup", () => {
    expect(desktopTestingRendererTimeout("action", { type: "question.reply", requestID: "question-1" })).toBe(60_000)
  })

  test("keeps short renderer actions bounded", () => {
    expect(desktopTestingRendererTimeout("action", { type: "app.status" })).toBe(10_000)
    expect(desktopTestingRendererTimeout("screen-state")).toBe(10_000)
  })

  test("accepts a bounded plugin automation timeout override", () => {
    expect(desktopTestingRendererTimeout("action", { type: "plugin.automation.run", timeout: 45_000 })).toBe(45_000)
    expect(desktopTestingRendererTimeout("action", { type: "plugin.automation.run", timeout: 1 })).toBe(1_000)
    expect(desktopTestingRendererTimeout("action", { type: "plugin.automation.run", timeout: 900_000 })).toBe(600_000)
  })
})
