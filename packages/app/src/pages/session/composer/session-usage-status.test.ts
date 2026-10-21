import { describe, expect, test } from "bun:test"
import type { UsageSummary } from "./session-usage-status"
import {
  formatRunDuration,
  generationRateText,
  isStaleRunningActivity,
  runDurationMs,
  shouldPollUsage,
  usageStatusSegments,
  usageStatusText,
  usageStatusTitle,
  usageTotal,
} from "./session-usage-status"

function totals(input: number, output = 0) {
  return {
    input,
    output,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    total: input + output,
  }
}

function summary(input: {
  own?: number
  descendants?: number
  descendantSessions?: number
  asOf?: number
  sessionGenerationMs?: number
  run?: {
    own: number
    descendants?: number
    complete?: boolean
    running?: boolean
    kind?: string
    timeEnd?: number
    timeUpdated?: number
    measuredTotal?: number
    measurementComplete?: boolean
    generationMs?: number
    models?: {
      selected?: { model: { id: string; providerID: string; variant?: string; chain?: { id: string; name: string; steps: { id: string; providerID: string }[] } | null }; source: "prompt" | "model-switch"; sequence: number }[]
      observed?: { model: { id: string; providerID: string }; sequence: number }[]
    }
  }
}): UsageSummary {
  const sessionOwn = totals(input.own ?? 0)
  const sessionDescendants = totals(input.descendants ?? 0)
  return {
    sessionID: "ses_test",
    asOf: input.asOf ?? 0,
    session: {
      own: sessionOwn,
      descendants: sessionDescendants,
      total: totals(sessionOwn.total + sessionDescendants.total),
      descendantSessions: input.descendantSessions ?? 0,
      complete: true,
      ...(input.sessionGenerationMs === undefined ? {} : { generationMs: input.sessionGenerationMs }),
    },
    ...(input.run
      ? {
          run: {
            activityID: "act_test",
            kind: input.run.kind ?? "prompt",
            status: input.run.running ? "running" : "completed",
            running: input.run.running ?? false,
            timeStart: 0,
            ...(input.run.timeEnd === undefined ? {} : { timeEnd: input.run.timeEnd }),
            ...(input.run.timeUpdated === undefined ? {} : { timeUpdated: input.run.timeUpdated }),
            own: totals(input.run.own),
            descendants: totals(input.run.descendants ?? 0),
            total: totals(input.run.own + (input.run.descendants ?? 0)),
            complete: input.run.complete ?? true,
            ...(input.run.complete === false ? { reason: "no subagent provenance" } : {}),
            ...(input.run.generationMs === undefined ? {} : { generationMs: input.run.generationMs }),
            ...(input.run.measuredTotal === undefined && input.run.measurementComplete === undefined
              ? {}
              : {
                  measurement: {
                    own: {
                      complete: false,
                      reportedSteps: 0,
                      unreportedSteps: 0,
                      categories: {
                        input: { complete: false },
                        output: { complete: false },
                        reasoning: { complete: false },
                        cacheRead: { complete: false },
                        cacheWrite: { complete: false },
                        inputTotal: { complete: false },
                        outputTotal: { complete: false },
                        total: { complete: false },
                      },
                    },
                    descendants: {
                      complete: true,
                      reportedSteps: 0,
                      unreportedSteps: 0,
                      categories: {
                        input: { known: 0, complete: true },
                        output: { known: 0, complete: true },
                        reasoning: { known: 0, complete: true },
                        cacheRead: { known: 0, complete: true },
                        cacheWrite: { known: 0, complete: true },
                        inputTotal: { known: 0, complete: true },
                        outputTotal: { known: 0, complete: true },
                        total: { known: 0, complete: true },
                      },
                    },
                    total: {
                      complete: input.run.measurementComplete ?? false,
                      reportedSteps: 1,
                      unreportedSteps: 0,
                      categories: {
                        input: { complete: false },
                        output: { complete: false },
                        reasoning: { complete: false },
                        cacheRead: { complete: false },
                        cacheWrite: { complete: false },
                        inputTotal: { complete: false },
                        outputTotal: { complete: false },
                        total: {
                          ...(input.run.measuredTotal === undefined ? {} : { known: input.run.measuredTotal }),
                          complete: input.run.measurementComplete ?? false,
                        },
                      },
                    },
                  },
                }),
            ...(input.run.models
              ? {
                  models: {
                    selected: input.run.models.selected ?? [],
                    observed: input.run.models.observed ?? [],
                    complete: true,
                  },
                }
              : {}),
          },
        }
      : {}),
  }
}

describe("usageTotal", () => {
  test("adds own and descendant totals", () => {
    expect(usageTotal(summary({ own: 120, descendants: 60 }))).toBe(180)
  })
})

describe("usageStatusText", () => {
  test("renders run and session segments with subagent totals", () => {
    const text = usageStatusText(summary({ own: 120, descendants: 60, run: { own: 5, descendants: 12 } }))
    expect(text).toMatch(/Run ~17 · Session 180 tokens/)
  })

  test("renders session only for legacy sessions without runs", () => {
    expect(usageStatusText(summary({ own: 1000 }))).toMatch(/Session 1k tokens/)
  })

  test("renders nothing before any usage is reported", () => {
    expect(usageStatusText(undefined)).toBeUndefined()
    expect(usageStatusText(summary({}))).toBeUndefined()
  })
})

describe("usageStatusSegments", () => {
  test("marks incomplete run attribution instead of claiming exact values", () => {
    const segments = usageStatusSegments(summary({ own: 500, run: { own: 10, complete: false } }))
    expect(segments[0]!.text).toMatch(/^Run ~/)
    expect(segments[0]!.text).not.toContain("·")
  })

  test("keeps exact marks when provenance is complete", () => {
    const segments = usageStatusSegments(
      summary({ own: 500, descendants: 300, run: { own: 10, descendants: 20, measuredTotal: 30, measurementComplete: true } }),
    )
    expect(segments[0]!.text).not.toMatch(/Run ~/)
    expect(segments[1]!.text).not.toMatch(/Session ~/)
  })

  test("shows measured zero, estimates partial values, and keeps missing measurements unknown", () => {
    expect(usageStatusSegments(summary({ run: { own: 0, measuredTotal: 0, measurementComplete: true } }))[0]?.text).toBe("Run 0")
    expect(usageStatusSegments(summary({ run: { own: 5, measuredTotal: 5 } }))[0]?.text).toBe("Run ~5")
    expect(usageStatusSegments(summary({ run: { own: 0 } }))[0]?.text).toBe("Run —")
  })
})

describe("generation rate segments", () => {
  test("renders run and session tok/s from measured provider streaming time", () => {
    const value = summary({ own: 120, descendants: 60, run: { own: 5, descendants: 12 } })
    value.session.own.output = 800
    value.session.own.reasoning = 200
    value.session.generationMs = 5000
    value.run!.own.output = 30
    value.run!.own.reasoning = 10
    value.run!.generationMs = 1000
    const segments = usageStatusSegments(value)
    expect(segments[0]!.text).toBe("Run ~17 · 40 tok/s")
    expect(segments[1]!.text).toBe("Session 180 tokens · 200 tok/s")
    expect(usageStatusText(value)).toBe("Run ~17 · 40 tok/s · Session 180 tokens · 200 tok/s")
    expect(usageStatusTitle(value)).toContain("tool waits excluded")
    expect(segments[0]!.title).toContain("own provider streaming time")
  })

  test("keeps measured zero rate visible instead of hiding it", () => {
    expect(generationRateText(0, 1000)).toBe("0 tok/s")
  })

  test("hides rates when streaming time is unknown or below the sample floor", () => {
    const unknown = summary({ own: 120, run: { own: 5 } })
    expect(usageStatusSegments(unknown).map((segment) => segment.text)).toEqual(["Run ~5", "Session 120 tokens"])
    const tooShort = summary({ own: 120, run: { own: 5 } })
    tooShort.session.generationMs = 400
    tooShort.run!.generationMs = 400
    expect(usageStatusSegments(tooShort).map((segment) => segment.text).some((text) => text.includes("tok/s"))).toBe(false)
  })

  test("keeps legacy footer text byte-identical without generation measurements", () => {
    expect(usageStatusText(summary({ own: 120, descendants: 60, run: { own: 5, descendants: 12 } }))).toBe(
      "Run ~17 · Session 180 tokens",
    )
  })
})

describe("usageStatusTitle", () => {
  test("explains the own/subagent split and incomplete attribution", () => {
    const title = usageStatusTitle(summary({ own: 500, descendants: 300, run: { own: 10, descendants: 4, complete: false } }))
    expect(title).toContain("Session (own 500 + subagents 300)")
    expect(title).toContain("Run (prompt)")
    expect(title).toContain("incomplete")
  })

  test("shows durable historical model and chain evidence", () => {
    const title = usageStatusTitle(
      summary({
        run: {
          own: 20,
          models: {
            selected: [
              {
                model: {
                  providerID: "openai",
                  id: "gpt-test",
                  variant: "high",
                  chain: {
                    id: "chain-test",
                    name: "Reliable",
                    steps: [
                      { providerID: "openai", id: "gpt-test" },
                      { providerID: "anthropic", id: "claude-test" },
                    ],
                  },
                },
                source: "prompt",
                sequence: 1,
              },
              {
                model: {
                  providerID: "openai",
                  id: "gpt-test",
                  chain: {
                    id: "chain-test",
                    name: "Reliable v2",
                    steps: [{ id: "gemini-test", providerID: "google" }],
                  },
                },
                source: "model-switch",
                sequence: 2,
              },
            ],
          },
        },
      }),
    )
    expect(title).toContain("openai/gpt-test (high)")
    expect(title).toContain("Reliable: openai/gpt-test → anthropic/claude-test")
    expect(title).toContain("Reliable v2: google/gemini-test")
  })

  test("does not report chain details for a historical model whose chain was explicitly cleared", () => {
    const title = usageStatusTitle(summary({
      run: {
        own: 20,
        models: {
          selected: [{ model: { providerID: "openai", id: "gpt-test", chain: null }, source: "prompt", sequence: 1 }],
        },
      },
    }))
    expect(title).toContain("Models: selected openai/gpt-test")
    expect(title).not.toContain("Chains:")
  })
})

describe("runDurationMs", () => {
  test("advances a live run from the server snapshot without more requests", () => {
    expect(runDurationMs(summary({ asOf: 5_000, run: { own: 0, running: true } }), 2_500)).toBe(7_500)
  })

  test("freezes completed duration at the durable activity end time", () => {
    expect(runDurationMs(summary({ asOf: 10_000, run: { own: 0, timeEnd: 8_250, timeUpdated: 9_000 } }))).toBe(8_250)
    expect(formatRunDuration(8_250)).toBe("8s")
  })

  test("uses the durable updated time when a terminal response has no explicit end time", () => {
    expect(runDurationMs(summary({ run: { own: 0, timeUpdated: 8_250 } }))).toBe(8_250)
  })

  test("anchors each live duration to its newest server snapshot", () => {
    const first = summary({ asOf: 10_000, run: { own: 0, running: true } })
    const refreshed = summary({ asOf: 25_000, run: { own: 0, running: true } })
    expect(runDurationMs(first, 1_000)).toBe(11_000)
    expect(runDurationMs(refreshed)).toBe(25_000)
  })

  test("does not invent a duration when the end time is unavailable", () => {
    expect(runDurationMs(summary({ run: { own: 0 } }))).toBeUndefined()
    expect(formatRunDuration(undefined)).toBeUndefined()
  })
})

describe("isStaleRunningActivity", () => {
  test("rejects a late running snapshot after its terminal event even without an earlier snapshot", () => {
    expect(isStaleRunningActivity(summary({ run: { own: 0, running: true } }), "act_test", true)).toBe(true)
  })

  test("keeps live snapshots and snapshots for a new activity", () => {
    const live = summary({ run: { own: 0, running: true } })
    expect(isStaleRunningActivity(live, "act_test", false)).toBe(false)
    expect(isStaleRunningActivity(live, "act_next", true)).toBe(false)
  })
})

describe("reload contract — footer must stay visible after reload when session/activity stable", () => {
  test("usage segments persist when session data present", () => {
    const s = summary({ own: 120, descendants: 60, run: { own: 35, complete: false, running: true } })
    const segs = usageStatusSegments(s)
    expect(segs.length).toBeGreaterThan(0)
    expect(segs.some(s => s.text.includes("Session"))).toBe(true)
  })
})

describe("shouldPollUsage", () => {
  test("polls while running and after settling once loaded", () => {
    expect(shouldPollUsage(undefined, true)).toBe(true)
    expect(shouldPollUsage(summary({ own: 5, run: { own: 1, running: true } }), false)).toBe(true)
    expect(shouldPollUsage(summary({ own: 5 }), false)).toBe(false)
  })
})
