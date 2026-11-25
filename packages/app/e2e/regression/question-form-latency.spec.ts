import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"

// Portable large-form fixture: no user sessions, product decks or external repo.
test("large forms keep typing responsive and preserve local action/answer semantics", async ({ page }, info) => {
  const directory = "C:/OpenCode/FormLatencyFixture"
  const dirBase64 = Buffer.from(directory).toString("base64url")
  const sessionID = "ses_form_latency"
  const currentID = "ses_form_latency_empty"
  const replies: unknown[] = []
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const fields = [
    { id: "text", type: "textarea", label: "Edit text", defaultValue: "" },
    { id: "first", type: "select", label: "First", defaultValue: "A", options: ["", "A", "B", "C"].map(id => ({ id, label: id || "Empty" })) },
    { id: "second", type: "hidden", defaultValue: "B" },
    { id: "third", type: "hidden", defaultValue: "C" },
    { id: "shift", type: "button", label: "Remove first" },
    { id: "quantity", type: "number", label: "Quantity", min: 1, max: 4, defaultValue: 4 },
    ...Array.from({ length: 494 }, (_, i) => ({ id: `extra${i}`, type: "text", defaultValue: `value${i}` })),
  ]
  const request = {
    id: "que_form_latency", sessionID,
    questions: [{ type: "form", question: "Edit fixture", form: {
      version: 1, id: "latency-fixture", title: "Large form", submitLabel: "Send fixture", fields,
      actions: [{ id: "shift-chain", trigger: { event: "click", source: "shift" }, steps: [
        { type: "setValue", target: "values.first", value: "${values.second}" },
        { type: "setValue", target: "values.second", value: "${values.third}" },
        { type: "setValue", target: "values.third", value: "" },
      ] }],
      layout: { type: "vstack", children: [
        ...["text", "first", "quantity", "shift"].map(field => ({ type: "field", field })),
        { type: "vstack", when: { field: "first", equals: "B" }, children: [{ type: "text", text: "Shift complete" }] },
        ...Array.from({ length: 40 }, (_, i) => ({ type: "vstack", when: { field: `extra${i}`, equals: "show" }, children: [{ type: "field", field: `extra${i}` }] })),
      ] },
    } }],
  }
  await mockOpenCodeServer(page, {
    directory,
    project: { id: "proj_latency", worktree: directory, vcs: "git", name: "latency-fixture", time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: { all: [], connected: [], default: {} },
    sessions: [sessionID, currentID].map(id => ({ id, slug: id, projectID: "proj_latency", directory, title: id, version: "dev", time: { created: 1, updated: 1 } })),
    pageMessages: () => ({ items: [] }), questions: () => replies.length ? [] : [request],
    events: () => [{ directory, payload: { id: "evt_latency", type: "surface.asked", properties: request } }],
    onQuestionReply: reply => { replies.push(reply.body); return true },
    onSessionCreate: () => { throw new Error("No session creation") },
  })
  await page.addInitScript(({ directory, dirBase64, currentID }) => {
    localStorage.setItem("settings.v3", "{}")
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", dirBase64, sessionId: currentID }]))
  }, { directory, dirBase64, currentID })
  await page.goto(`/${dirBase64}/session/${currentID}`)
  const form = page.locator('[data-slot="question-form"]').filter({ hasText: "Large form" })
  await expect(form).toBeVisible()
  await page.evaluate(() => {
    const timings: number[] = []
    Object.assign(window, { formInputTimings: timings })
    document.addEventListener("input", event => {
      if (!(event.target instanceof HTMLTextAreaElement)) return
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => timings.push(performance.now() - start)))
    }, true)
  })
  const text = form.locator("textarea")
  await text.pressSequentially("Edit text", { delay: 75 })
  await expect(text).toHaveValue("Edit text")
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "formInputTimings").length)).toBe(9)
  const times = await page.evaluate(() => Reflect.get(window, "formInputTimings") as number[])
  await info.attach("input-latency.json", { body: JSON.stringify({ times, maxMs: Math.max(...times) }), contentType: "application/json" })
  // Wide enough for CI scheduling, far below the reproduced multi-second stall.
  expect(Math.max(...times)).toBeLessThan(250)
  await form.getByRole("button", { name: "Remove first", exact: true }).click()
  await expect(form.getByText("Shift complete", { exact: true })).toBeVisible()
  await expect(form.locator("select")).toHaveValue("B")
  const popup = page.locator('[data-component="question-popup"]')
  const send = popup.getByRole("button", { name: "Send fixture", exact: true })
  await form.locator('input[type="number"]').fill("5")
  await expect(send).toBeDisabled()
  await form.locator('input[type="number"]').fill("4")
  await send.click()
  await expect.poll(() => replies.length).toBe(1)
  const reply = replies[0] as { answers: string[][] }
  const answer = JSON.parse(reply.answers[0]![0]!)
  expect(answer.values).toMatchObject({ text: "Edit text", first: "B", second: "C", third: "", quantity: 4, extra493: "value493" })
  expect(errors).toEqual([])
})
