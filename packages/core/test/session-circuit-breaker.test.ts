import { describe, expect, test } from "bun:test"
import { CircuitBreaker } from "@opencode-ai/core/session/circuit-breaker"

describe("CircuitBreaker", () => {
  test("opens after the failure threshold and recovers after OPEN_MS", () => {
    const breakers = CircuitBreaker.make()
    const key = "provider/test-open"
    expect(breakers.shouldSkip(key, 0)).toBe(false)
    breakers.recordFailure(key, 0)
    breakers.recordFailure(key, 0)
    expect(breakers.inspect(key).state).toBe("closed")
    breakers.recordFailure(key, 1_000)
    expect(breakers.inspect(key).state).toBe("open")
    expect(breakers.shouldSkip(key, 1_000)).toBe(true)
    expect(breakers.shouldSkip(key, 1_000 + CircuitBreaker.OPEN_MS)).toBe(false)
    expect(breakers.inspect(key).state).toBe("half-open")
    breakers.recordSuccess(key)
    expect(breakers.inspect(key).state).toBe("closed")
    expect(breakers.shouldSkip(key, 1_000 + CircuitBreaker.OPEN_MS)).toBe(false)
  })

  test("half-open failure reopens immediately", () => {
    const breakers = CircuitBreaker.make()
    const key = "provider/test-half-open"
    breakers.recordFailure(key, 0)
    breakers.recordFailure(key, 0)
    breakers.recordFailure(key, 0)
    breakers.shouldSkip(key, CircuitBreaker.OPEN_MS)
    breakers.recordFailure(key, CircuitBreaker.OPEN_MS)
    expect(breakers.inspect(key).state).toBe("open")
    expect(breakers.shouldSkip(key, CircuitBreaker.OPEN_MS)).toBe(true)
  })

  test("instances own their state independently", () => {
    const first = CircuitBreaker.make()
    const second = CircuitBreaker.make()
    const key = "provider/test-isolated"
    first.recordFailure(key, 0)
    first.recordFailure(key, 0)
    first.recordFailure(key, 0)
    expect(first.inspect(key).state).toBe("open")
    expect(first.shouldSkip(key, 0)).toBe(true)
    expect(second.inspect(key).state).toBe("closed")
    expect(second.shouldSkip(key, 0)).toBe(false)
  })
})
