import { describe, expect, test, vi } from "bun:test"
import { shouldAutofocusQuestionDock } from "./session-question-autofocus"
import { fullscreenCloseButtonRight, shouldCloseVideoFullscreenOnEscape } from "./session-question-video"
import { finalizeRemainingOption, finalizeRemainingOverlay } from "./question-dock-types"
import {
  SurfaceRequestTimeoutError,
  runSurfaceRequestWithRetries,
  shouldRetrySurfaceRequest,
} from "./session-question-retry"

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

describe("runSurfaceRequestWithRetries", () => {
  test("retries timed out question requests and returns a later success", async () => {
    vi.useFakeTimers()
    try {
      const attempts: number[] = []
      const statuses: string[] = []
      const request = runSurfaceRequestWithRetries({
        timeoutMs: 10,
        retries: 2,
        onStatus: (status) => statuses.push(status.type === "retrying" ? `${status.type}:${status.retry}` : status.type),
        run: (signal, attempt) => {
          attempts.push(attempt)
          if (attempt === 2) return Promise.resolve("ok")
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new SurfaceRequestTimeoutError()), { once: true })
          })
        },
      })

      vi.advanceTimersByTime(10)
      await flush()
      vi.advanceTimersByTime(10)
      await flush()

      await expect(request).resolves.toBe("ok")
      expect(attempts).toEqual([0, 1, 2])
      expect(statuses).toEqual(["submitting", "retrying:1", "retrying:2"])
    } finally {
      vi.useRealTimers()
    }
  })

  test("rejects after all retry attempts time out", async () => {
    vi.useFakeTimers()
    try {
      const attempts: number[] = []
      const request = runSurfaceRequestWithRetries({
        timeoutMs: 10,
        retries: 2,
        run: (signal, attempt) => {
          attempts.push(attempt)
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new SurfaceRequestTimeoutError()), { once: true })
          })
        },
      })

      for (const _ of Array.from({ length: 3 })) {
        vi.advanceTimersByTime(10)
        await flush()
      }

      await expect(request).rejects.toBeInstanceOf(SurfaceRequestTimeoutError)
      expect(attempts).toEqual([0, 1, 2])
    } finally {
      vi.useRealTimers()
    }
  })

  test("does not retry terminal request failures", async () => {
    const error = new Error("Question is gone")
    const attempts: number[] = []

    await expect(
      runSurfaceRequestWithRetries({
        retries: 2,
        shouldRetry: (candidate) => candidate !== error,
        run: (_signal, attempt) => {
          attempts.push(attempt)
          return Promise.reject(error)
        },
      }),
    ).rejects.toBe(error)
    expect(attempts).toEqual([0])
  })

  test("does not retry a question reply after an explicit abort (prevents duplicate POST)", async () => {
    const attempts: number[] = []
    let reconciliations = 0
    let controller: AbortController | undefined
    const request = runSurfaceRequestWithRetries({
      timeoutMs: 1000,
      retries: 2,
      shouldRetry: shouldRetrySurfaceRequest,
      reconcileBeforeRetry: async () => {
        reconciliations++
        return { type: "retry" }
      },
      onController: (candidate) => {
        controller = candidate ?? controller
      },
      run: (signal, attempt) => {
        attempts.push(attempt)
        return new Promise<unknown>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
        })
      },
    })
    await flush()
    // Explicit cancellation remains terminal, so it must not submit another
    // non-idempotent reply after surfacing an AbortError.
    controller?.abort()
    await expect(request).rejects.toBeInstanceOf(DOMException)
    expect(attempts).toEqual([0])
    expect(reconciliations).toBe(0)
  })

  test("treats a timed-out reply as settled when reconciliation no longer finds it", async () => {
    vi.useFakeTimers()
    try {
      const attempts: number[] = []
      const request = runSurfaceRequestWithRetries({
        timeoutMs: 10,
        retries: 2,
        shouldRetry: shouldRetrySurfaceRequest,
        reconcileBeforeRetry: async () => ({ type: "settled", value: "already-settled" }),
        run: (signal, attempt) => {
          attempts.push(attempt)
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
          })
        },
      })

      vi.advanceTimersByTime(10)
      await flush()

      await expect(request).resolves.toBe("already-settled")
      expect(attempts).toEqual([0])
    } finally {
      vi.useRealTimers()
    }
  })

  test("retries a timed-out reply only after reconciliation confirms it is still pending", async () => {
    vi.useFakeTimers()
    try {
      const attempts: number[] = []
      const statuses: string[] = []
      const request = runSurfaceRequestWithRetries({
        timeoutMs: 10,
        retries: 2,
        shouldRetry: shouldRetrySurfaceRequest,
        reconcileBeforeRetry: async () => ({ type: "retry" }),
        onStatus: (status) => statuses.push(status.type === "retrying" ? `${status.type}:${status.retry}` : status.type),
        run: (signal, attempt) => {
          attempts.push(attempt)
          if (attempt === 1) return Promise.resolve("submitted")
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
          })
        },
      })

      vi.advanceTimersByTime(10)
      await flush()

      await expect(request).resolves.toBe("submitted")
      expect(attempts).toEqual([0, 1])
      expect(statuses).toEqual(["submitting", "retrying:1"])
    } finally {
      vi.useRealTimers()
    }
  })

  test("does not retry when the pending-list reconciliation itself fails", async () => {
    vi.useFakeTimers()
    try {
      const attempts: number[] = []
      const reconcileError = new Error("Pending list unavailable")
      const request = runSurfaceRequestWithRetries({
        timeoutMs: 10,
        retries: 2,
        shouldRetry: shouldRetrySurfaceRequest,
        reconcileBeforeRetry: async () => Promise.reject(reconcileError),
        run: (signal, attempt) => {
          attempts.push(attempt)
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
          })
        },
      })

      vi.advanceTimersByTime(10)
      await flush()

      await expect(request).rejects.toBe(reconcileError)
      expect(attempts).toEqual([0])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("shouldRetrySurfaceRequest", () => {
  test("does not retry after an explicit abort or when the question is already gone", () => {
    expect(shouldRetrySurfaceRequest(new DOMException("aborted", "AbortError"))).toBe(false)
    expect(shouldRetrySurfaceRequest(new Error("Question request not found"))).toBe(false)
    expect(shouldRetrySurfaceRequest({ status: 404 })).toBe(false)
  })

  test("retries transient errors and timeouts that are neither abort nor not-found", () => {
    expect(shouldRetrySurfaceRequest(new SurfaceRequestTimeoutError())).toBe(true)
    expect(shouldRetrySurfaceRequest(new Error("network error"))).toBe(true)
    expect(shouldRetrySurfaceRequest({ status: 500 })).toBe(true)
  })
})

describe("shouldCloseVideoFullscreenOnEscape", () => {
  test("closes only for an unclaimed Escape while fullscreen or its opening trigger owns focus", () => {
    expect(shouldCloseVideoFullscreenOnEscape({ key: "Escape", defaultPrevented: false, focusOwner: "fullscreen" })).toBe(true)
    expect(shouldCloseVideoFullscreenOnEscape({ key: "Escape", defaultPrevented: false, focusOwner: "trigger" })).toBe(true)
    expect(shouldCloseVideoFullscreenOnEscape({ key: "Escape", defaultPrevented: false, focusOwner: "other" })).toBe(false)
    expect(shouldCloseVideoFullscreenOnEscape({ key: "Escape", defaultPrevented: true, focusOwner: "fullscreen" })).toBe(false)
    expect(shouldCloseVideoFullscreenOnEscape({ key: "Enter", defaultPrevented: false, focusOwner: "fullscreen" })).toBe(false)
  })
})

describe("fullscreenCloseButtonRight", () => {
  test("reserves the Windows caption controls at the current webview zoom", () => {
    expect(fullscreenCloseButtonRight({ windowsDesktop: true, zoom: 1 })).toBe("calc(138px + 1rem)")
    expect(fullscreenCloseButtonRight({ windowsDesktop: true, zoom: 2 })).toBe("calc(69px + 1rem)")
    expect(fullscreenCloseButtonRight({ windowsDesktop: true, zoom: 0.5 })).toBe("calc(138px + 1rem)")
  })

  test("keeps the normal inset outside Windows desktop", () => {
    expect(fullscreenCloseButtonRight({ windowsDesktop: false, zoom: 1 })).toBe("1rem")
  })
})

describe("shouldAutofocusQuestionDock", () => {
  test("does not autofocus while the composer prompt input is active", () => {
    const input = document.createElement("div")
    input.dataset.component = "prompt-input"
    input.tabIndex = 0
    document.body.append(input)
    input.focus()

    try {
      expect(shouldAutofocusQuestionDock({})).toBe(false)
    } finally {
      input.remove()
    }
  })

  test("allows autofocus when enabled and the composer is not active", () => {
    document.body.focus()

    expect(shouldAutofocusQuestionDock({ activeElement: document.body })).toBe(true)
    expect(shouldAutofocusQuestionDock({ autofocus: false, activeElement: document.body })).toBe(false)
  })
})

describe("finalizeRemaining options", () => {
  test("finds the request-wide finalize option", () => {
    const options = [
      { id: "yes", label: "Ja" },
      { id: "done", label: "Genug fuer heute", finalizeRemaining: true },
    ]

    expect(finalizeRemainingOption(options)?.label).toBe("Genug fuer heute")
    expect(finalizeRemainingOption([{ id: "yes", label: "Ja" }])).toBeUndefined()
    expect(finalizeRemainingOption(undefined)).toBeUndefined()
  })

  test("overlay answers every open question with its own finalize option and keeps answered ones", () => {
    const finalize = { id: "done", label: "Genug fuer heute", finalizeRemaining: true as const }

    const overlay = finalizeRemainingOverlay([
      { options: [{ id: "yes", label: "Ja" }, finalize], answered: true },
      { options: [{ id: "yes", label: "Ja" }, finalize], answered: false },
      { options: [{ id: "yes", label: "Ja" }], answered: false },
      { options: undefined, answered: false },
    ])

    expect(overlay[0]).toBeUndefined()
    expect(overlay[1]?.label).toBe("Genug fuer heute")
    expect(overlay[2]).toBeUndefined()
    expect(overlay[3]).toBeUndefined()
  })
})
