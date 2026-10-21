import { describe, expect, test } from "bun:test"
import { RetryBackoff } from "./retry-backoff"

describe("RetryBackoff", () => {
  test("first failure schedules the base delay", () => {
    const state = RetryBackoff.recordFailure(RetryBackoff.fresh(), { ...RetryBackoff.defaultOptions, jitter: () => 0.5 })
    expect(state.attempt).toBe(1)
    expect(state.terminal).toBeFalse()
    expect(state.nextDelayMs).toBe(5_000)
  })

  test("delays grow exponentially and cap at maxDelayMs", () => {
    const options = { ...RetryBackoff.defaultOptions, jitter: () => 0.5 }
    let state = RetryBackoff.fresh()
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      state = RetryBackoff.recordFailure(state, options)
      delays.push(state.nextDelayMs)
    }
    expect(delays[0]).toBe(5_000)
    expect(delays[1]).toBe(10_000)
    expect(delays[2]).toBe(20_000)
    expect(delays[delays.length - 1]).toBe(60_000)
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(60_000)
  })

  test("jitter stays within 85 to 115 percent of the exponential delay", () => {
    const low = RetryBackoff.recordFailure(RetryBackoff.fresh(), {
      ...RetryBackoff.defaultOptions,
      jitter: () => 0,
    })
    const high = RetryBackoff.recordFailure(RetryBackoff.fresh(), {
      ...RetryBackoff.defaultOptions,
      jitter: () => 1,
    })
    expect(low.nextDelayMs).toBe(5_000)
    expect(high.nextDelayMs).toBe(5_750)
  })

  test("reaches the terminal state after the configured failure count", () => {
    const options = { ...RetryBackoff.defaultOptions, terminalAfterConsecutiveFailures: 3, jitter: () => 0.5 }
    let state = RetryBackoff.fresh()
    state = RetryBackoff.recordFailure(state, options)
    state = RetryBackoff.recordFailure(state, options)
    expect(state.terminal).toBeFalse()
    state = RetryBackoff.recordFailure(state, options)
    expect(state.terminal).toBeTrue()
    expect(state.nextDelayMs).toBe(0)
    // Terminal state persists; callers stop scheduling retries.
    const stuck = RetryBackoff.recordFailure(state, options)
    expect(stuck.terminal).toBeTrue()
  })

  test("terminal callers can keep a slow recovery probe without fast retrying", () => {
    const options = { ...RetryBackoff.defaultOptions, terminalAfterConsecutiveFailures: 2, jitter: () => 0.5 }
    const first = RetryBackoff.recordFailure(RetryBackoff.fresh(), options)
    expect(RetryBackoff.probeDelay(first, 60_000)).toBe(5_000)
    const terminal = RetryBackoff.recordFailure(first, options)
    expect(RetryBackoff.probeDelay(terminal, 60_000)).toBe(60_000)
    expect(RetryBackoff.probeDelay(RetryBackoff.recordFailure(terminal, options), 60_000)).toBe(60_000)
    expect(RetryBackoff.recordFailure(RetryBackoff.reset(), options).terminal).toBeFalse()
  })

  test("reset returns to a clean state after success", () => {
    const options = { ...RetryBackoff.defaultOptions, jitter: () => 0.5 }
    let state = RetryBackoff.recordFailure(RetryBackoff.fresh(), options)
    expect(state.attempt).toBe(1)
    state = RetryBackoff.reset()
    expect(state).toEqual(RetryBackoff.fresh())
  })
})
