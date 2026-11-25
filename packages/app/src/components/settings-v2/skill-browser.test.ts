import { expect, test } from "bun:test"
import { createSkillBrowser } from "./skill-browser"

test("skills stay unloaded and collapsed until requested; reopening reuses the catalog", async () => {
  let calls = 0
  const browser = createSkillBrowser(async () => { calls++; return ["one", "two"] })
  expect(browser.expanded()).toBe(false)
  expect(browser.items()).toBeUndefined()
  expect(calls).toBe(0)
  browser.reveal()
  await Promise.resolve()
  expect(browser.expanded()).toBe(true)
  expect(browser.items()).toEqual(["one", "two"])
  browser.collapse()
  browser.reveal()
  expect(calls).toBe(1)
})

test("rapid open and search navigation share a single in-flight read", async () => {
  let calls = 0
  let finish!: (items: string[]) => void
  const browser = createSkillBrowser(() => { calls++; return new Promise<string[]>((resolve) => { finish = resolve }) })
  browser.reveal()
  browser.collapse()
  browser.reveal()
  expect(browser.loading()).toBe(true)
  expect(calls).toBe(1)
  finish(["loaded"])
  await Promise.resolve()
  expect(browser.items()).toEqual(["loaded"])
  expect(browser.loading()).toBe(false)
})

test("a failed read is not an empty catalog and can be retried explicitly", async () => {
  let fail = true
  const browser = createSkillBrowser(async () => {
    if (fail) throw new Error("Unavailable")
    return []
  })
  browser.reveal()
  await Promise.resolve()
  expect(browser.error()).toBe("Unavailable")
  expect(browser.items()).toBeUndefined()
  fail = false
  await browser.refresh()
  expect(browser.error()).toBeUndefined()
  expect(browser.items()).toEqual([])
})

test("policy saves refresh an already opened catalog", async () => {
  let values = ["before"]
  const browser = createSkillBrowser(async () => values)
  browser.reveal()
  await Promise.resolve()
  values = ["after"]
  await browser.refresh()
  expect(browser.items()).toEqual(["after"])
})

test("a policy refresh during a read queues one fresh read instead of losing the update", async () => {
  let calls = 0
  let finish!: (items: string[]) => void
  const browser = createSkillBrowser(() => {
    calls++
    if (calls === 1) return new Promise<string[]>((resolve) => { finish = resolve })
    return Promise.resolve(["new policy"])
  })
  browser.reveal()
  await browser.refresh()
  finish(["old policy"])
  await Promise.resolve()
  await Promise.resolve()
  expect(calls).toBe(2)
  expect(browser.items()).toEqual(["new policy"])
})

test("closing settings prevents a late result from updating a disposed catalog", async () => {
  let finish!: (items: string[]) => void
  const browser = createSkillBrowser(() => new Promise<string[]>((resolve) => { finish = resolve }))
  browser.reveal()
  browser.dispose()
  finish(["stale"])
  await Promise.resolve()
  expect(browser.items()).toBeUndefined()
})
