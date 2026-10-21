import { describe, expect, test } from "bun:test"
import { assertBrowserTargetURL, selectBrowserTarget } from "./browser-target"

type Target = { id: string; url: string }
const idOf = async (target: Target) => target.id
const urlOf = (target: Target) => target.url

describe("selectBrowserTarget", () => {
  test("uses the exact current-instance target when duplicate URLs exist", async () => {
    const first = { id: "target-a", url: "https://example.com/" }
    const second = { id: "target-b", url: "https://example.com/" }
    expect(
      await selectBrowserTarget({
        targets: [first, second],
        url: first.url,
        targetID: second.id,
        targetIDOf: idOf,
        urlOf,
      }),
    ).toBe(second)
  })

  test("does not fall back to a matching URL when the current-instance target mismatches", async () => {
    const target = { id: "foreign-target", url: "https://example.com/" }
    expect(
      await selectBrowserTarget({
        targets: [target],
        url: target.url,
        targetID: "expected-target",
        targetIDOf: idOf,
        urlOf,
      }),
    ).toBeUndefined()
  })

  test("fails safely when duplicate URLs have no exact target identity", async () => {
    const targets = [
      { id: "target-a", url: "https://example.com/" },
      { id: "target-b", url: "https://example.com/" },
    ]
    expect(await selectBrowserTarget({ targets, url: targets[0]!.url, targetIDOf: idOf, urlOf })).toBeUndefined()
  })

  test("allows the URL fallback only when it is unique", async () => {
    const target = { id: "target-a", url: "https://example.com/" }
    expect(await selectBrowserTarget({ targets: [target], url: target.url, targetIDOf: idOf, urlOf })).toBe(target)
  })
})

describe("assertBrowserTargetURL", () => {
  test("accepts the exact authorized HTTP(S) origin", () => {
    expect(() => assertBrowserTargetURL("https://example.com/path", "https://example.com")).not.toThrow()
  })

  test("rejects non-web targets and origin changes with a retryable error", () => {
    expect(() => assertBrowserTargetURL("file:///secret", "https://example.com")).toThrow("only control HTTP(S)")
    expect(() => assertBrowserTargetURL("https://other.example/path", "https://example.com")).toThrow(
      "origin changed from https://example.com to https://other.example; retry the action",
    )
  })
})
