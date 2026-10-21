import { mkdirSync, writeFileSync } from "node:fs"
import { expect, test, type Page, type Request } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { fixture, longFixture, pageMessages, pageMessagesFor } from "./session-timeline.fixture"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { createRealSessionArchive } from "../utils/real-session-archive"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const forbiddenText = ["Load details", "Show earlier steps"]

type SmokeState = {
  ids: string[]
  visibleIds: string[]
  messageIds: string[]
  visibleMessageIds: string[]
  topVisibleId?: string
  signature: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  errorToasts: string[]
  forbiddenText: string[]
}

type SmokeWindow = Window & {
  __timelineSmokeState?: () => SmokeState
  __timelineSmokeErrorToasts?: string[]
  __timelineSmokeForbiddenText?: string[]
}

test.describe("smoke: session timeline", () => {
  test.setTimeout(240_000)

  test("keeps the visible message fixed while prepending history", async ({ page }) => {
    const requests: { before?: string; phase: "start" | "end"; at: number }[] = []
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
      messageDelay: 3_000,
      onMessages: (input) => requests.push({ before: input.before, phase: input.phase, at: performance.now() }),
    })
    await configureSmokePage(page, fixture.directory)

    await navigateToSession(page, fixture.directory, fixture.targetID, fixture.expected.targetTitle)
    await waitForTimelineStable(page)
    const scroller = timelineScroller(page)
    await pointAtTimeline(page)
    const deadline = Date.now() + 120_000
    while (!requests.some((request) => request.before && request.phase === "start")) {
      if (Date.now() >= deadline) throw new Error("Timed out scrolling to the history boundary")
      await page.mouse.wheel(0, -240)
      await page.waitForTimeout(20)
    }
    const olderRequestCompleted = () => requests.some((request) => request.before && request.phase === "end")
    for (let index = 0; index < 12; index++) {
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(20)
    }
    const keys = await visibleTimelinePartIDs(scroller)
    expect(keys.length).toBeGreaterThan(0)
    const positions = () =>
      scroller.evaluate((element, keys) => {
        const top = element.getBoundingClientRect().top
        return Object.fromEntries(
          keys.map((key) => {
            const row = element.querySelector<HTMLElement>(`[data-timeline-part-id="${key}"]`)
            return [key, row ? Math.round((row.getBoundingClientRect().top - top) * devicePixelRatio) / devicePixelRatio : null]
          }),
        )
      }, keys)
    const before = await positions()
    const completedBeforeMeasurement = olderRequestCompleted()

    if (!completedBeforeMeasurement) await expect.poll(olderRequestCompleted).toBe(true)
    await waitForTimelineStable(page)
    await expect.poll(positions).toEqual(before)
  })

  test("preserves the timeline gap above the composer", async ({ page }) => {
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await configureSmokePage(page, fixture.directory)

    await navigateToSession(page, fixture.directory, fixture.targetID, fixture.expected.targetTitle)
    await waitForTimelineStable(page)
    const scroller = timelineScroller(page)
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await waitForTimelineStable(page)

    const spacer = scroller.locator('[data-timeline-row="bottom-spacer"]')
    await expect(spacer).toBeVisible()
    expect(await spacer.evaluate((element) => element.getBoundingClientRect().height)).toBe(64)
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(1)
  })

  test("paints cached session tabs at the latest message", async ({ page }) => {
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: (sessionID) => ({ items: fixture.messages[sessionID as keyof typeof fixture.messages] ?? [] }),
    })
    await configureSmokePage(page, fixture.directory)
    await page.addInitScript(
      ({ dirBase64, sourceID, targetID }) => {
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify(
            [sourceID, targetID].map((sessionId) => ({
              type: "session",
              server: "http://127.0.0.1:4096",
              dirBase64,
              sessionId,
            })),
          ),
        )
      },
      { dirBase64: base64Encode(fixture.directory), sourceID: fixture.sourceID, targetID: fixture.targetID },
    )

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)
    await switchTitlebarSession(page, fixture.sourceID, fixture.expected.sourceTitle)

    const destination = fixture.messages[fixture.targetID].map((message) => message.info.id)
    const last = fixture.expected.targetMessageIDs.at(-1)!
    await page.evaluate(
      ({ destination, last }) => {
        const ids = new Set(destination)
        const samples: Array<{ ids: string[]; last: boolean; bottomError?: number }> = []
        const firstPaintNodes = new WeakSet<Node>()
        let firstPaint = false
        let removedFirstPaintNodes = 0
        let running = true
        new MutationObserver((records) => {
          if (!firstPaint || !running) return
          records.forEach((record) =>
            record.removedNodes.forEach((node) => {
              if (firstPaintNodes.has(node)) removedFirstPaintNodes += 1
              if (!(node instanceof Element)) return
              node.querySelectorAll("*").forEach((element) => {
                if (firstPaintNodes.has(element)) removedFirstPaintNodes += 1
              })
            }),
          )
        }).observe(document.documentElement, { childList: true, subtree: true })
        const sample = () => {
          if (!running) return
          setTimeout(() => {
            if (!running) return
            const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
              element.querySelector("[data-timeline-row]"),
            )
            if (root) {
              const view = root.getBoundingClientRect()
              const visible = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
                .filter((element) => {
                  const rect = element.getBoundingClientRect()
                  return rect.bottom > view.top && rect.top < view.bottom
                })
                .map((element) => element.dataset.messageId!)
                .filter((id) => ids.has(id))
              const bottom = root
                .querySelector<HTMLElement>('[data-timeline-row="bottom-spacer"]')
                ?.getBoundingClientRect()
              samples.push({
                ids: visible,
                last: visible.includes(last),
                bottomError: bottom ? bottom.bottom - view.bottom : undefined,
              })
              if (!firstPaint && visible.includes(last) && Math.abs((bottom?.bottom ?? Infinity) - view.bottom) <= 1) {
                firstPaint = true
                root.querySelectorAll<HTMLElement>("[data-timeline-key]").forEach((row) => {
                  const rect = row.getBoundingClientRect()
                  if (rect.bottom <= view.top || rect.top >= view.bottom) return
                  firstPaintNodes.add(row)
                  row.querySelectorAll("*").forEach((element) => firstPaintNodes.add(element))
                })
              }
            }
            requestAnimationFrame(sample)
          }, 0)
        }
        ;(
          window as Window & {
            __sessionTabPaint?: { samples: typeof samples; removed: () => number; stop: () => void }
          }
        ).__sessionTabPaint = {
          samples,
          removed: () => removedFirstPaintNodes,
          stop: () => {
            running = false
          },
        }
        requestAnimationFrame(sample)
      },
      { destination, last },
    )

    await switchTitlebarSession(page, fixture.targetID, fixture.expected.targetTitle)
    await page.waitForFunction(() =>
      (
        window as Window & { __sessionTabPaint?: { samples: Array<{ ids: string[] }> } }
      ).__sessionTabPaint?.samples.some((sample) => sample.ids.length > 0),
    )
    await page.waitForTimeout(200)
    const first = await page.evaluate(() => {
      const probe = (
        window as Window & {
          __sessionTabPaint?: {
            samples: Array<{ ids: string[]; last: boolean; bottomError?: number }>
            removed: () => number
            stop: () => void
          }
        }
      ).__sessionTabPaint!
      probe.stop()
      return { first: probe.samples.find((sample) => sample.ids.length > 0), removed: probe.removed() }
    })
    expect(first.first?.last).toBe(true)
    expect(Math.abs(first.first?.bottomError ?? Infinity)).toBeLessThanOrEqual(1)
    expect(first.removed).toBe(0)
  })

  test("paints a cold session tab at the latest message", async ({ page }, testInfo) => {
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages: (sessionID) => ({ items: fixture.messages[sessionID as keyof typeof fixture.messages] ?? [] }),
    })
    await configureSmokePage(page, fixture.directory)
    await page.addInitScript(
      ({ dirBase64, sourceID, targetID }) => {
        localStorage.setItem(
          "opencode.global.dat:tabs",
          JSON.stringify(
            [sourceID, targetID].map((sessionId) => ({
              type: "session",
              server: "http://127.0.0.1:4096",
              dirBase64,
              sessionId,
            })),
          ),
        )
      },
      { dirBase64: base64Encode(fixture.directory), sourceID: fixture.sourceID, targetID: fixture.targetID },
    )
    await navigateToSession(page, fixture.directory, fixture.sourceID, fixture.expected.sourceTitle)
    const last = fixture.expected.targetMessageIDs.at(-1)!
    const destination = fixture.messages[fixture.targetID].map((message) => message.info.id)
    await page.evaluate(
      ({ destination, last }) => {
        const ids = new Set(destination)
        const samples: Array<{ destination: boolean; last: boolean; bottomError?: number }> = []
        const sample = () => {
          const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
            element.querySelector("[data-timeline-row]"),
          )
          if (root) {
            const view = root.getBoundingClientRect()
            const spacer = root
              .querySelector<HTMLElement>('[data-timeline-row="bottom-spacer"]')
              ?.getBoundingClientRect()
            const messages = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].filter((element) => {
              const rect = element.getBoundingClientRect()
              return rect.bottom > view.top && rect.top < view.bottom
            })
            samples.push({
              destination: messages.some((element) => ids.has(element.dataset.messageId!)),
              last: messages.some((element) => element.dataset.messageId === last),
              bottomError: spacer ? spacer.bottom - view.bottom : undefined,
            })
          }
          requestAnimationFrame(() => setTimeout(sample, 0))
        }
        ;(window as Window & { __coldTabSamples?: typeof samples }).__coldTabSamples = samples
        requestAnimationFrame(() => setTimeout(sample, 0))
      },
      { destination, last },
    )

    await switchTitlebarSession(page, fixture.targetID, fixture.expected.targetTitle)
    await page.waitForFunction(() =>
      (window as Window & { __coldTabSamples?: Array<{ destination: boolean }> }).__coldTabSamples?.some(
        (sample) => sample.destination,
      ),
    )
    const result = await page.evaluate(() => {
      const samples = (
        window as Window & {
          __coldTabSamples?: Array<{ destination: boolean; last: boolean; bottomError?: number }>
        }
      ).__coldTabSamples!
      return samples.find((sample) => sample.destination)!
    })
    expect(result.last).toBe(true)
    expect(Math.abs(result.bottomError ?? Infinity)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath("cold-session-warmup.png"), fullPage: true })
    await page.screenshot({ path: testInfo.outputPath("cold-session-latest.png"), fullPage: true })
  })

  test("renders seeded timeline in order while paging through history", async ({ page }, testInfo) => {
    const errors = trackPageErrors(page)
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await configureSmokePage(page, fixture.directory)

    await expectActiveProject(page, fixture.project.name)
    await navigateToSession(page, fixture.directory, fixture.sourceID, fixture.expected.sourceTitle)
    await expectSessionReady(page)
    await navigateToSession(page, fixture.directory, fixture.targetID, fixture.expected.targetTitle)
    const expectedPartIDs = fixture.expected.targetPartIDs
    const expectedMessageIDs = fixture.expected.targetMessageIDs
    await expectSessionTimelineReady(page, expectedPartIDs, expectedMessageIDs, errors)
    await expectCanScrollToStart(page, expectedPartIDs, expectedMessageIDs, errors)
    await page.screenshot({ path: testInfo.outputPath("seeded-timeline-paged.png"), fullPage: true })
  })

  test("shows a promoted prompt immediately in an old running session", async ({ page }, testInfo) => {
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    const events: { directory: string; payload: Record<string, unknown> }[] = []
    const requests: { sessionID: string; before?: string; phase: "start" | "end" }[] = []
    page.on("requestfailed", (request) => networkFailures.push(`${request.method()} ${request.url()}`))
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })
    await mockOpenCodeServer(page, {
      sessions: longFixture.sessions,
      provider: longFixture.provider,
      directory: longFixture.directory,
      project: longFixture.project,
      pageMessages: (sessionID, limit, before) => pageMessagesFor(longFixture.messages, sessionID, limit, before),
      onMessages: (input) => requests.push(input),
      sessionStatus: { [longFixture.targetID]: { type: "busy" } },
      eventRetry: 10,
      events: () => events.splice(0),
    })
    await configureSmokePage(page, longFixture.directory)
    await navigateToSession(page, longFixture.directory, longFixture.targetID, longFixture.expected.targetTitle)
    await expectSessionTimelineMessagesReady(page, longFixture.expected.targetMessageIDs, errors)
    expect(longFixture.expected.targetMessageIDs.length).toBeGreaterThan(160)

    const promotedID = "msg_zzzz_promoted_user"
    const assistantID = "msg_zzzz_promoted_zassistant"
    events.push(
      {
        directory: longFixture.directory,
        payload: {
          id: "evt_promoted_prompt",
          type: "session.next.prompt.promoted",
          properties: {
            sessionID: longFixture.targetID,
            messageID: promotedID,
            timestamp: 1_700_002_000_000,
            timeCreated: 1_700_002_000_000,
            prompt: { text: "Continue this old running session." },
          },
        },
      },
      {
        directory: longFixture.directory,
        payload: {
          id: "evt_promoted_step",
          type: "session.next.step.started",
          properties: {
            sessionID: longFixture.targetID,
            assistantMessageID: assistantID,
            timestamp: 1_700_002_001_000,
            agent: "build",
            model: { providerID: "opencode", id: "claude-opus-4-6", variant: "max" },
          },
        },
      },
      {
        directory: longFixture.directory,
        payload: {
          id: "evt_promoted_text_started",
          type: "session.next.text.started",
          properties: {
            sessionID: longFixture.targetID,
            assistantMessageID: assistantID,
            textID: "text_promoted",
            timestamp: 1_700_002_001_100,
          },
        },
      },
      {
        directory: longFixture.directory,
        payload: {
          id: "evt_promoted_text_ended",
          type: "session.next.text.ended",
          properties: {
            sessionID: longFixture.targetID,
            assistantMessageID: assistantID,
            textID: "text_promoted",
            text: "Assistant continued from the promoted prompt.",
            timestamp: 1_700_002_001_200,
          },
        },
      },
    )

    const promoted = page.locator(`[data-timeline-row="UserMessage"][data-message-id="${promotedID}"]`)
    await expect(promoted).toBeVisible()
    await expect(promoted).toContainText("Continue this old running session.")
    await expect(page.getByText("Assistant continued from the promoted prompt.", { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("promoted-prompt-desktop.png"), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await promoted.scrollIntoViewIfNeeded()
    await expect(promoted).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("promoted-prompt-mobile.png"), fullPage: true })

    await page.setViewportSize({ width: 1440, height: 900 })
    await pointAtTimeline(page)
    const deadline = Date.now() + 60_000
    while (!requests.some((request) => request.before && request.phase === "end")) {
      if (Date.now() >= deadline) throw new Error("Timed out loading older messages after the promoted prompt")
      await page.mouse.wheel(0, -600)
      await page.waitForTimeout(20)
    }
    await timelineScroller(page).evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    await expect(promoted).toBeVisible()

    expectNoSmokeErrors(errors, [], [])
    expect(networkFailures).toEqual([])
  })

  test("keeps resumed Morning Review output in view with mixed generation message IDs", async ({ page }, testInfo) => {
    const errors = trackPageErrors(page)
    const networkFailures: string[] = []
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText === "net::ERR_ABORTED") return
      networkFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
    })
    page.on("response", (response) => {
      if (response.status() >= 400) networkFailures.push(`${response.status()} ${response.url()}`)
    })
    const messages = structuredClone(longFixture.messages)
    const history = messages[longFixture.targetID]
    const resumedID = "msg_06d8e45f2001F5K1Hrks6Vfk9F"
    const latestID = "msg_06dbbe5e0001morningcontinued"
    const liveTexts = [
      { id: "text_morning_first", text: "Morning Review continued successfully." },
      { id: "text_morning_second", text: "The latest findings are visible here." },
    ]
    const authoritativeMarker = "Authoritative Morning Review snapshot accepted."
    const ids = new Map(
      history.map((message, index) => [
        message.info.id,
        index === 0
          ? "msg_80daf1f1f62f000994c26e3603"
          : index === history.length - 2
            ? resumedID
            : `msg_80db${String(index).padStart(8, "0")}`,
      ]),
    )
    history.forEach((message) => {
      message.info.id = ids.get(message.info.id)!
      if (typeof message.info.parentID === "string") message.info.parentID = ids.get(message.info.parentID)!
      message.parts.forEach((part) => {
        part.messageID = message.info.id
      })
    })
    history.at(-2)!.parts = [
      {
        id: "prt_morning_resume",
        type: "text",
        messageID: resumedID,
        sessionID: longFixture.targetID,
        text: "Continue the Morning Review after the failed attempt.",
      },
    ]
    history.at(-1)!.parts = [
      {
        id: "prt_morning_paused",
        type: "text",
        messageID: history.at(-1)!.info.id,
        sessionID: longFixture.targetID,
        text: "Morning Review is ready to continue.",
      },
    ]
    const events: { directory: string; payload: Record<string, unknown> }[] = []
    const requests: { sessionID: string; before?: string; limit: number; phase: "start" | "end" }[] = []
    await mockOpenCodeServer(page, {
      sessions: longFixture.sessions,
      provider: longFixture.provider,
      directory: longFixture.directory,
      project: longFixture.project,
      pageMessages: (sessionID, limit, before) => pageMessagesFor(messages, sessionID, limit, before),
      onMessages: (input) => requests.push(input),
      eventRetry: 10,
      events: () => events.splice(0),
    })
    await configureSmokePage(page, longFixture.directory)
    await navigateToSession(page, longFixture.directory, longFixture.sourceID, longFixture.expected.sourceTitle)
    await expect
      .poll(() => requests.some((request) => request.sessionID === longFixture.targetID && request.phase === "end"), {
        timeout: 60_000,
      })
      .toBe(true)
    await switchTitlebarSession(page, longFixture.targetID, longFixture.expected.targetTitle)
    expect(history.filter((message) => message.info.role === "user").length).toBeGreaterThan(160)
    await expect(page.getByText("Morning Review is ready to continue.", { exact: true })).toBeInViewport()

    const timestamp = 1_700_002_001_000
    const requestsBeforeLive = requests.filter(
      (request) => request.sessionID === longFixture.targetID && request.phase === "end",
    ).length
    events.push(
      { directory: longFixture.directory, payload: { type: "session.status", properties: {
        sessionID: longFixture.targetID, status: { type: "busy" },
      } } },
      ...[
        {
          type: "session.next.step.started",
          properties: {
            assistantMessageID: latestID,
            agent: "build",
            model: { providerID: "opencode", id: "claude-opus-4-6", variant: "max" },
          },
        },
        ...liveTexts.flatMap((item) => [
          { type: "session.next.text.started", properties: { assistantMessageID: latestID, textID: item.id } },
          {
            type: "session.next.text.delta",
            properties: { assistantMessageID: latestID, textID: item.id, delta: item.text },
          },
        ]),
      ].map((event, index) => ({
        directory: longFixture.directory,
        payload: {
          id: `evt_morning_${index}`,
          type: event.type,
          properties: { sessionID: longFixture.targetID, timestamp: timestamp + index, ...event.properties },
        },
      })),
    )
    const liveLocators = liveTexts.map((item) => page.getByText(item.text, { exact: true }))
    for (const locator of liveLocators) await expect(locator).toBeInViewport()
    const second = await liveLocators[1]!.elementHandle()
    if (!second) throw new Error("Second streamed Morning Review text is not mounted")
    expect(
      await liveLocators[0]!.evaluate(
        (first, second) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        second,
      ),
    ).toBe(true)
    expect(
      await Promise.all(
        liveLocators.map((locator) =>
          locator.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const scroller = element.closest(".scroll-view__viewport")?.getBoundingClientRect()
            return !!scroller && rect.bottom > scroller.top && rect.top < scroller.bottom
          }),
        ),
      ),
    ).toEqual([true, true])
    await expect
      .poll(() => timelineScroller(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2)
    expect(requests.filter((request) => request.sessionID === longFixture.targetID && request.phase === "end")).toHaveLength(
      requestsBeforeLive,
    )
    await expect(page.getByText(authoritativeMarker, { exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath("morning-review-desktop-live.png"), fullPage: true })
    const newest = structuredClone(history.at(-1)!)
    newest.info = { ...newest.info, id: latestID, parentID: resumedID, time: { created: timestamp } }
    delete newest.info.finish
    newest.parts = [
      ...liveTexts.map((item) => ({
        id: item.id,
        type: "text" as const,
        messageID: latestID,
        sessionID: longFixture.targetID,
        text: item.text,
      })),
      {
        id: "text_morning_authoritative",
        type: "text",
        messageID: latestID,
        sessionID: longFixture.targetID,
        text: authoritativeMarker,
      },
    ]
    history.push(newest)
    const requestsBeforeRefresh = requests.filter(
      (request) => request.sessionID === longFixture.targetID && request.phase === "end",
    ).length
    events.push({
      directory: longFixture.directory,
      payload: {
        id: "evt_morning_authoritative_boundary",
        type: "session.next.text.ended",
        properties: {
          sessionID: longFixture.targetID,
          timestamp: timestamp + 10,
          assistantMessageID: latestID,
          textID: liveTexts[1]!.id,
          text: liveTexts[1]!.text,
        },
      },
    })
    await expect
      .poll(
        () => requests.filter((request) => request.sessionID === longFixture.targetID && request.phase === "end").length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(requestsBeforeRefresh)
    await expect(page.getByText(authoritativeMarker, { exact: true })).toBeInViewport()
    for (const locator of liveLocators) await expect(locator).toBeInViewport()
    await expect
      .poll(() => timelineScroller(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2)
    await page.screenshot({ path: testInfo.outputPath("morning-review-desktop-refresh.png"), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    for (const locator of liveLocators) await expect(locator).toBeInViewport()
    await expect(page.getByText(authoritativeMarker, { exact: true })).toBeInViewport()
    await expect
      .poll(() => timelineScroller(page).evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2)
    await page.screenshot({ path: testInfo.outputPath("morning-review-mobile-refresh.png"), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    for (const locator of liveLocators) await expect(locator).toBeInViewport()
    await expect(page.getByText(authoritativeMarker, { exact: true })).toBeInViewport()
    expect(requests.every((request) => request.limit <= 200)).toBe(true)
    expect(networkFailures).toEqual([])
    expectNoSmokeErrors(errors, [], [])
  })

  test("keeps genuinely archived prefetched timeline history through paging refresh and hash restore", async ({
    page,
  }) => {
    const errors = trackPageErrors(page)
    const requests: { sessionID: string; before?: string; limit: number; phase: "start" | "end"; at: number }[] = []
    const networkFailures: string[] = []
    const archive = await createRealSessionArchive({
      session: longFixture.sessions.find((session) => session.id === longFixture.targetID)!,
      messages: longFixture.messages[longFixture.targetID],
    })
    page.once("close", () => void archive.dispose())
    const archivedBeforeOpen = await archive.inspect()
    expect(archivedBeforeOpen).toMatchObject({
      location: "archived",
      revision: 1,
      sessionCount: 1,
      activeSessionCount: 0,
      archivedMessageCount: 340,
      archivedLegacyMessageCount: 340,
    })
    expect(archivedBeforeOpen.shardBytes).toBeGreaterThan(0)
    const activeRequests = new Set<Request>()
    const refreshRequests = new Set<Request>()
    let forceRefreshing = false
    page.on("request", (request) => {
      if (new URL(request.url()).port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) activeRequests.add(request)
    })
    page.on("requestfinished", (request) => activeRequests.delete(request))
    page.on("requestfailed", (request) => {
      const url = new URL(request.url())
      activeRequests.delete(request)
      if (
        (refreshRequests.delete(request) ||
          (forceRefreshing && (url.pathname === "/global/event" || url.pathname === "/perf/record"))) &&
        request.failure()?.errorText === "net::ERR_ABORTED"
      )
        return
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096")) {
        networkFailures.push(`${request.method()} ${url.pathname} ${request.failure()?.errorText ?? "failed"}`)
      }
    })
    page.on("response", (response) => {
      const url = new URL(response.url())
      if (url.port === (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096") && response.status() >= 400) {
        networkFailures.push(`${response.status()} ${url.pathname}`)
      }
    })

    await mockOpenCodeServer(page, {
      sessions: longFixture.sessions,
      provider: longFixture.provider,
      directory: longFixture.directory,
      project: longFixture.project,
      pageMessages: (sessionID, limit, before) =>
        sessionID === longFixture.targetID
          ? archive.pageMessages(sessionID, limit, before)
          : pageMessagesFor(longFixture.messages, sessionID, limit, before),
      onMessages: (input) => requests.push({ ...input, at: Date.now() }),
    })
    await configureSmokePage(page, longFixture.directory)
    await configureRestoredSessionTabs(page, longFixture.directory, longFixture.sourceID, longFixture.targetID)

    await navigateToSession(page, longFixture.directory, longFixture.sourceID, longFixture.expected.sourceTitle)
    await expectSessionReady(page)
    const targetTab = page.locator(`[data-dock-tab][data-session-id="${longFixture.targetID}"]`).getByRole("tab")
    await expect(targetTab).toHaveAttribute("aria-selected", "false")
    await expect
      .poll(() => requests.some((request) => request.sessionID === longFixture.targetID && request.phase === "start"), {
        timeout: 60_000,
      })
      .toBe(true)
    await expect
      .poll(() => requests.some((request) => request.sessionID === longFixture.targetID && request.phase === "end"), {
        timeout: 60_000,
      })
      .toBe(true)
    const prefetchedTargetRequestCount = requests.filter((request) => request.sessionID === longFixture.targetID).length
    await switchTitlebarSession(page, longFixture.targetID, longFixture.expected.targetTitle)
    await expectSessionTimelineMessagesReady(page, longFixture.expected.targetMessageIDs, errors)
    await page.waitForTimeout(100)
    expect(requests.filter((request) => request.sessionID === longFixture.targetID)).toHaveLength(
      prefetchedTargetRequestCount,
    )
    await switchTitlebarSession(page, longFixture.sourceID, longFixture.expected.sourceTitle)
    await switchTitlebarSession(page, longFixture.targetID, longFixture.expected.targetTitle)
    await expectSessionTimelineMessagesReady(page, longFixture.expected.targetMessageIDs, errors)
    expect(longFixture.expected.targetMessageIDs.length).toBeGreaterThan(160)
    expect(requests.every((request) => request.limit <= 200)).toBe(true)

    const oldMessageID = "msg_user_smoke_0120"
    const boundaryAssistantPartID = "msg_assistant_smoke_0120:prt_text_2_smoke_0120"
    await expectCanScrollMessagesAcrossBoundary(
      page,
      longFixture.expected.targetMessageIDs,
      oldMessageID,
      boundaryAssistantPartID,
      errors,
    )
    expect(requests.some((request) => request.sessionID === longFixture.targetID && request.before && request.phase === "end")).toBe(
      true,
    )
    await expectBoundaryContentPresent(page, oldMessageID, boundaryAssistantPartID)

    const screenshotDir = "test-results/session-timeline-long"
    mkdirSync(screenshotDir, { recursive: true })
    writeFileSync(`${screenshotDir}/requests-before-refresh.json`, JSON.stringify({ requests, networkFailures }, null, 2))
    await page.screenshot({ path: `${screenshotDir}/desktop-loaded-older.png`, fullPage: true })

    await page.evaluate(({ dirBase64, messageID, targetID }) => {
      localStorage.setItem(
        "opencode.global.dat:tabs.recent",
        JSON.stringify({ key: `http://127.0.0.1:4096\n${dirBase64}\n${targetID}` }),
      )
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#message-${messageID}`)
    }, { dirBase64: base64Encode(longFixture.directory), messageID: oldMessageID, targetID: longFixture.targetID })
    activeRequests.forEach((request) => refreshRequests.add(request))
    const requestCountBeforeRefresh = requests.length
    forceRefreshing = true
    await page.reload({ waitUntil: "commit" }).finally(() => {
      forceRefreshing = false
    })
    await switchTitlebarSession(page, longFixture.targetID, longFixture.expected.targetTitle)
    await expectBoundaryContentPresent(page, oldMessageID, boundaryAssistantPartID)
    const refreshedTargetRequestCount = requests.filter((request) => request.sessionID === longFixture.targetID).length
    await page.evaluate(() => {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    })
    await page.evaluate((messageID) => {
      window.location.hash = `message-${messageID}`
    }, oldMessageID)
    await expectBoundaryContentPresent(page, oldMessageID, boundaryAssistantPartID)
    await page.waitForTimeout(100)
    expect(requests.filter((request) => request.sessionID === longFixture.targetID)).toHaveLength(
      refreshedTargetRequestCount,
    )
    const refreshedTargetPages = requests
      .slice(requestCountBeforeRefresh)
      .filter((request) => request.sessionID === longFixture.targetID && request.phase === "end")
      .map((request) => request.before ?? "latest")
    expect(new Set(refreshedTargetPages).size, JSON.stringify(refreshedTargetPages)).toBe(refreshedTargetPages.length)
    await page.screenshot({ path: `${screenshotDir}/desktop-hash-restore.png`, fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expectBoundaryContentPresent(page, oldMessageID, boundaryAssistantPartID)
    await page.screenshot({ path: `${screenshotDir}/mobile-hash-restore.png`, fullPage: true })

    const state = await timelineState(page)
    const archivedAfterRead = await archive.inspect()
    writeFileSync(
      `${screenshotDir}/final-state.json`,
      JSON.stringify({ requests, state, networkFailures, archivedBeforeOpen, archivedAfterRead }, null, 2),
    )
    expect(archivedAfterRead).toEqual(archivedBeforeOpen)
    expectNoSmokeErrors(errors, state.errorToasts, state.forbiddenText)
    expect(networkFailures).toEqual([])
    expect(requests.every((request) => request.limit <= 200)).toBe(true)
  })
})

async function configureSmokePage(page: Page, directory: string) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: true,
          shellToolPartsExpanded: true,
          showReasoningSummaries: true,
          showSessionProgressBar: true,
        },
      }),
    )
  })

  await page.addInitScript(({ directory, dirBase64, sourceID, targetID }) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: {
          local: [{ worktree: directory, expanded: true }],
        },
        lastProject: {
          local: directory,
        },
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:tabs",
      JSON.stringify(
        [sourceID, targetID].map((sessionId) => ({
          type: "session",
          server: "http://127.0.0.1:4096",
          dirBase64,
          sessionId,
        })),
      ),
    )
    localStorage.setItem(
      "opencode.global.dat:tabs.recent",
      JSON.stringify({ key: `http://127.0.0.1:4096\n${dirBase64}\n${targetID}` }),
    )
  }, { directory, dirBase64: base64Encode(directory), sourceID: fixture.sourceID, targetID: fixture.targetID })

  await page.addInitScript(() => {
    const smoke = window as SmokeWindow
    smoke.__timelineSmokeErrorToasts = []
    smoke.__timelineSmokeForbiddenText = []
    const partSelector = "[data-timeline-part-id], [data-timeline-part-ids]"
    const idsOf = (el: HTMLElement) =>
      [el.dataset.timelinePartId, ...(el.dataset.timelinePartIds?.split(",") ?? [])].filter((id): id is string => !!id)

    smoke.__timelineSmokeState = () => {
      const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
        el.querySelector("[data-timeline-row], [data-session-title]"),
      )
      if (!scroller) {
        return {
          ids: [],
          visibleIds: [],
          messageIds: [],
          visibleMessageIds: [],
          topVisibleId: undefined,
          signature: "",
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          errorToasts: smoke.__timelineSmokeErrorToasts ?? [],
          forbiddenText: smoke.__timelineSmokeForbiddenText ?? [],
        }
      }

      const ids: string[] = []
      const visibleIds: string[] = []
      const scrollerRect = scroller.getBoundingClientRect()
      let topVisibleId: string | undefined
      for (const el of scroller.querySelectorAll<HTMLElement>(partSelector)) {
        const next = idsOf(el)
        ids.push(...next)

        const rect = el.getBoundingClientRect()
        if (rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom) {
          if (!topVisibleId) topVisibleId = next[0]
          visibleIds.push(...next)
        }
      }

      const messageIds: string[] = []
      const visibleMessageIds: string[] = []
      const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].map((el) => {
        const rect = el.getBoundingClientRect()
        const id = el.dataset.messageId
        if (id) {
          messageIds.push(id)
          if (rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom) visibleMessageIds.push(id)
        }
        return {
          id,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        }
      })
      const signature = JSON.stringify({
        top: Math.round(scroller.scrollTop),
        height: Math.round(scroller.scrollHeight),
        rows,
        ids,
      })

      return {
        ids,
        visibleIds,
        messageIds,
        visibleMessageIds,
        topVisibleId,
        signature,
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        clientHeight: Math.round(scroller.clientHeight),
        errorToasts: smoke.__timelineSmokeErrorToasts ?? [],
        forbiddenText: smoke.__timelineSmokeForbiddenText ?? [],
      }
    }
    let recordFrame: number | undefined
    const record = () => {
      for (const toast of document.querySelectorAll<HTMLElement>('[data-component="toast"][data-variant="error"]')) {
        const text = toast.textContent?.trim()
        if (text && !smoke.__timelineSmokeErrorToasts!.includes(text)) smoke.__timelineSmokeErrorToasts!.push(text)
      }
      const text = document.body?.textContent ?? ""
      for (const value of ["Load details", "Show earlier steps"]) {
        if (text.includes(value) && !smoke.__timelineSmokeForbiddenText!.includes(value)) {
          smoke.__timelineSmokeForbiddenText!.push(value)
        }
      }
    }
    const start = () => {
      const root = document.documentElement ?? document.body
      if (!root) return
      new MutationObserver(() => {
        if (recordFrame) return
        recordFrame = requestAnimationFrame(() => {
          recordFrame = undefined
          record()
        })
      }).observe(root, { childList: true, subtree: true })
      record()
    }
    if (document.documentElement ?? document.body) start()
    else document.addEventListener("DOMContentLoaded", start, { once: true })
  })
}

async function expectCanScrollToStart(
  page: Page,
  expectedPartIDs: string[],
  expectedMessageIDs: string[],
  errors: string[],
) {
  await pointAtTimeline(page)
  const seenParts = new Set<string>()
  const seenMessages = new Set<string>()
  const samples: TraversalSample[] = []
  let current = await timelineState(page)
  let unchangedAtTop = 0

  for (let attempt = 0; attempt < 600; attempt++) {
    collectSeen(current, seenParts, seenMessages)
    samples.push(sampleTraversal(current, seenParts.size, seenMessages.size))
    expectNoSmokeErrors(errors, current.errorToasts, current.forbiddenText)
    expectOrderedIDs(expectedPartIDs, current.ids, "mounted part")
    expectOrderedIDs(expectedPartIDs, current.visibleIds, "visible part")
    expectOrderedIDs(expectedMessageIDs, unique(current.messageIds), "mounted message")
    expectOrderedIDs(expectedMessageIDs, unique(current.visibleMessageIds), "visible message")

    if (
      current.scrollTop <= 1 &&
      seenParts.size === expectedPartIDs.length &&
      seenMessages.size === expectedMessageIDs.length
    ) {
      expectCompleteScroll(current, expectedPartIDs, expectedMessageIDs, seenParts, seenMessages, samples)
      return
    }

    const before = current
    const changed = await scrollTimelineUp(page, current)
    current = await timelineState(page)
    if (!changed && current.signature === before.signature && current.scrollTop <= 1) unchangedAtTop++
    else unchangedAtTop = 0
    if (unchangedAtTop >= 2 && current.scrollTop <= 1) break
  }

  collectSeen(current, seenParts, seenMessages)
  samples.push(sampleTraversal(current, seenParts.size, seenMessages.size))
  expectCompleteScroll(current, expectedPartIDs, expectedMessageIDs, seenParts, seenMessages, samples)
}

async function timelineState(page: Page) {
  return page.evaluate(
    () =>
      (window as SmokeWindow).__timelineSmokeState?.() ?? {
        ids: [],
        visibleIds: [],
        messageIds: [],
        visibleMessageIds: [],
        topVisibleId: undefined,
        signature: "",
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        errorToasts: [],
        forbiddenText: [],
      },
  )
}

async function expectCanScrollMessagesAcrossBoundary(
  page: Page,
  expectedMessageIDs: string[],
  boundaryMessageID: string,
  boundaryAssistantPartID: string,
  errors: string[],
) {
  await pointAtTimeline(page)
  const seenParts = new Set<string>()
  const seenMessages = new Set<string>()
  const samples: TraversalSample[] = []
  let current = await timelineState(page)

  for (let attempt = 0; attempt < 400; attempt++) {
    collectSeen(current, seenParts, seenMessages)
    samples.push(sampleTraversal(current, seenParts.size, seenMessages.size))
    expectNoSmokeErrors(errors, current.errorToasts, current.forbiddenText)
    expectOrderedIDs(expectedMessageIDs, unique(current.messageIds), "mounted message")
    expectOrderedIDs(expectedMessageIDs, unique(current.visibleMessageIds), "visible message")

    if (
      current.visibleMessageIds.includes(boundaryMessageID) &&
      seenMessages.has(boundaryMessageID) &&
      seenParts.has(boundaryAssistantPartID)
    ) {
      return
    }

    await scrollTimelineUp(page, current)
    current = await timelineState(page)
  }

  collectSeen(current, seenParts, seenMessages)
  samples.push(sampleTraversal(current, seenParts.size, seenMessages.size))
  expect(seenMessages.has(boundaryMessageID), `older boundary message should be loaded\n${sampleSummary(samples)}`).toBe(true)
  expect(
    seenParts.has(boundaryAssistantPartID),
    `assistant output around the first loaded page boundary should be rendered\n${sampleSummary(samples)}`,
  ).toBe(true)
  expect(
    current.visibleMessageIds.includes(boundaryMessageID),
    `older boundary message should be visible before refresh\n${sampleSummary(samples)}`,
  ).toBe(true)
}

async function expectSessionTimelineMessagesReady(page: Page, expectedMessageIDs: string[], errors: string[]) {
  await expect
    .poll(() => timelineState(page).then((state) => state.messageIds.length), { timeout: 60_000 })
    .toBeGreaterThan(0)
  await waitForTimelineStable(page)
  for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0)
  const currentState = await timelineState(page)
  expectNoSmokeErrors(errors, currentState.errorToasts, currentState.forbiddenText)
  expectOrderedIDs(expectedMessageIDs, unique(currentState.messageIds), "mounted message")
  expectOrderedIDs(expectedMessageIDs, unique(currentState.visibleMessageIds), "visible message")
}

function timelineScroller(page: Page) {
  return page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
}

function visibleTimelinePartIDs(scroller: ReturnType<typeof timelineScroller>) {
  return scroller.evaluate((element) => {
    const view = element.getBoundingClientRect()
    return [...element.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
      .filter((row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > view.top && rect.top < view.bottom
      })
      .map((row) => row.dataset.timelinePartId)
      .filter((id): id is string => !!id)
      .slice(0, 3)
  })
}

async function pointAtTimeline(page: Page) {
  const box = await timelineScroller(page).boundingBox()
  if (!box) throw new Error("Timeline scroller is not visible")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

async function scrollTimelineUp(page: Page, before: SmokeState) {
  return page.evaluate(
    (prev) =>
      new Promise<boolean>((resolve) => {
        const scroller = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((el) =>
          el.querySelector("[data-timeline-row], [data-session-title]"),
        )
        if (!scroller) {
          resolve(false)
          return
        }

        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1, deltaMode: 0 }))
        scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(80, Math.round(scroller.clientHeight * 0.45)))

        const read = () => (window as SmokeWindow).__timelineSmokeState?.().signature ?? ""
        let frames = 0
        let stableFrames = 0
        let last = ""
        let changed = false
        const check = () => {
          const current = read()
          if (current !== prev) changed = true
          if (current === last) stableFrames++
          else {
            stableFrames = 0
            last = current
          }
          if (changed && stableFrames >= 2) {
            resolve(true)
            return
          }
          frames++
          if (frames >= 30) {
            resolve(changed)
            return
          }
          requestAnimationFrame(check)
        }
        requestAnimationFrame(check)
      }),
    before.signature,
  )
}

function expectOrderedIDs(expected: string[], actual: string[], label: string) {
  expect(actual.length, `${label} ids should not be empty`).toBeGreaterThan(0)
  const actualSet = new Set(actual)
  expect(actual, `${label} ids`).toEqual(expected.filter((id) => actualSet.has(id)))
}

function unique(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index)
}

function collectSeen(state: SmokeState, seenParts: Set<string>, seenMessages: Set<string>) {
  for (const id of state.ids) seenParts.add(id)
  for (const id of state.visibleIds) seenParts.add(id)
  for (const id of state.messageIds) seenMessages.add(id)
  for (const id of state.visibleMessageIds) seenMessages.add(id)
}

type TraversalSample = ReturnType<typeof sampleTraversal>

function sampleTraversal(state: SmokeState, seenParts: number, seenMessages: number) {
  return {
    seenParts,
    seenMessages,
    mounted: state.ids.length,
    visible: state.visibleIds.length,
    mountedMessages: unique(state.messageIds).length,
    visibleMessages: unique(state.visibleMessageIds).length,
    top: state.scrollTop,
    height: state.scrollHeight,
    first: state.ids[0],
    last: state.ids.at(-1),
    topVisible: state.topVisibleId,
    visibleFirst: state.visibleIds[0],
    visibleLast: state.visibleIds.at(-1),
  }
}

function sampleSummary(samples: TraversalSample[]) {
  return samples
    .filter((_, index) => index % Math.max(1, Math.floor(samples.length / 8)) === 0 || index === samples.length - 1)
    .map(
      (sample, index) =>
        `${index}: seenParts=${sample.seenParts} seenMessages=${sample.seenMessages} mounted=${sample.mounted}/${sample.mountedMessages} visible=${sample.visible}/${sample.visibleMessages} top=${sample.top}/${sample.height} first=${sample.first} last=${sample.last} topVisible=${sample.topVisible} visible=${sample.visibleFirst}..${sample.visibleLast}`,
    )
    .join("\n")
}

async function waitForTimelineStable(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => {
          const a = (window as SmokeWindow).__timelineSmokeState?.().signature ?? ""
          requestAnimationFrame(() => {
            const b = (window as SmokeWindow).__timelineSmokeState?.().signature ?? ""
            requestAnimationFrame(() =>
              resolve(!!a && a === b && b === ((window as SmokeWindow).__timelineSmokeState?.().signature ?? "")),
            )
          })
        })
      }),
  )
}

async function expectSessionTimelineReady(
  page: Page,
  expectedPartIDs: string[],
  expectedMessageIDs: string[],
  errors: string[],
) {
  await waitForTimelineStable(page)
  for (const text of forbiddenText) await expect(page.getByText(text)).toHaveCount(0)
  const currentState = await timelineState(page)
  expectNoSmokeErrors(errors, currentState.errorToasts, currentState.forbiddenText)
  expectOrderedIDs(expectedPartIDs, currentState.ids, "mounted part")
  expectOrderedIDs(expectedPartIDs, currentState.visibleIds, "visible part")
  expectOrderedIDs(expectedMessageIDs, unique(currentState.messageIds), "mounted message")
  expectOrderedIDs(expectedMessageIDs, unique(currentState.visibleMessageIds), "visible message")
}

function expectCompleteScroll(
  state: SmokeState,
  expectedPartIDs: string[],
  expectedMessageIDs: string[],
  seenParts: Set<string>,
  seenMessages: Set<string>,
  samples: TraversalSample[],
) {
  expect(state.scrollTop, `timeline should reach the start\n${sampleSummary(samples)}`).toBeLessThanOrEqual(1)
  expect(
    expectedPartIDs.filter((id) => !seenParts.has(id)),
    `missing visible timeline parts\n${sampleSummary(samples)}`,
  ).toEqual([])
  expect(
    expectedMessageIDs.filter((id) => !seenMessages.has(id)),
    `missing visible messages\n${sampleSummary(samples)}`,
  ).toEqual([])
  expect(new Set(expectedPartIDs).size).toBe(expectedPartIDs.length)
  expect(new Set(expectedMessageIDs).size).toBe(expectedMessageIDs.length)
  expect(expectedPartIDs.length).toBeGreaterThanOrEqual(331)
}

async function configureRestoredSessionTabs(page: Page, directory: string, sourceID: string, targetID: string) {
  await page.addInitScript(
    ({ dirBase64, sourceID, targetID }) => {
      const server = "http://127.0.0.1:4096"
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify(
          [sourceID, targetID].map((sessionId) => ({
            type: "session",
            server,
            dirBase64,
            sessionId,
          })),
        ),
      )
      localStorage.setItem("opencode.global.dat:tabs.recent", JSON.stringify({ key: `${server}\n${dirBase64}\n${sourceID}` }))
    },
    { dirBase64: base64Encode(directory), sourceID, targetID },
  )
}

async function expectMessageVisible(page: Page, messageID: string) {
  await expect
    .poll(() => timelineState(page).then((state) => state.visibleMessageIds.includes(messageID)), { timeout: 120_000 })
    .toBe(true)
  await expect(page.locator(`[data-message-id="${messageID}"]`).first()).toBeVisible()
}

async function expectBoundaryContentPresent(page: Page, messageID: string, assistantPartID: string) {
  await expectMessageVisible(page, messageID)
  await expect
    .poll(() => timelineState(page).then((state) => state.ids.includes(assistantPartID)), { timeout: 120_000 })
    .toBe(true)
}

async function expectActiveProject(page: Page, projectName: string) {
  await page.goto("/")
  await expectAppVisible(page.getByRole("button", { name: new RegExp(projectName, "i") }).first())
  await expect(page).toHaveURL(/\/$/)
}

async function navigateToSession(page: Page, directory: string, sessionId: string, expectedTitle: string) {
  await page.goto(`/${base64Encode(directory)}/session/${sessionId}`)
  const tab = page.locator(`[data-dock-tab][data-session-id="${sessionId}"]`).getByRole("tab")
  await expectAppVisible(tab)
  await tab.click()
  await expect(tab).toHaveAttribute("aria-selected", "true")
  await expect(page).toHaveURL(/\/$/)
  await expectSessionTitle(page, expectedTitle)
}

async function switchTitlebarSession(page: Page, sessionID: string, title: string) {
  const href = `/${base64Encode(fixture.directory)}/session/${sessionID}`
  const tab = page.locator(`[data-slot="titlebar-tabs"] a[href="${href}"]`).first()
  if (await tab.isVisible()) await tab.click()
  else await page.getByRole("tab", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click()
  await expectSessionTitle(page, title)
}

async function expectSessionReady(page: Page) {
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
}
