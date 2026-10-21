import { describe, expect, test } from "bun:test"
import { collectDeepLinkArgs, createDeepLinkDelivery } from "./deep-links"

describe("desktop deep links", () => {
  test("collects initial opencode protocol args", () => {
    expect(collectDeepLinkArgs(["OpenCode.exe", "opencode://scheduled-job-run?runId=1"])).toEqual([
      "opencode://scheduled-job-run?runId=1",
    ])
  })

  test("preserves multiple deep links in order", () => {
    expect(
      collectDeepLinkArgs([
        "OpenCode.exe",
        "opencode://open-project?directory=C%3A%5Cwork",
        "--flag",
        "opencode://scheduled-job-run?runId=2",
      ]),
    ).toEqual(["opencode://open-project?directory=C%3A%5Cwork", "opencode://scheduled-job-run?runId=2"])
  })

  test("ignores non-opencode arguments", () => {
    expect(collectDeepLinkArgs(["OpenCode.exe", "https://opencode.ai", "C:/work", "--opencode://bad"])).toEqual([])
  })
})

describe("deep link delivery", () => {
  test("delivers a live link once without replaying it on a later renderer consume", () => {
    const delivery = createDeepLinkDelivery(["opencode://initial"])
    const sent: string[][] = []

    expect(delivery.consume()).toEqual(["opencode://initial"])
    delivery.emit(["opencode://scheduled-job-run?runId=1"], (urls) => sent.push(urls))

    expect(sent).toEqual([["opencode://scheduled-job-run?runId=1"]])
    expect(delivery.consume()).toEqual([])
  })

  test("queues links while the renderer reloads and consumes them once after recovery", () => {
    const delivery = createDeepLinkDelivery()
    const sent: string[][] = []

    delivery.consume()
    delivery.suspend()
    delivery.emit(["opencode://scheduled-job-run?runId=2"], (urls) => sent.push(urls))

    expect(sent).toEqual([])
    expect(delivery.consume()).toEqual(["opencode://scheduled-job-run?runId=2"])
    expect(delivery.consume()).toEqual([])
  })
})
