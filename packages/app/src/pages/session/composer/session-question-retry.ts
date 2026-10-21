export const QUESTION_REQUEST_TIMEOUT_MS = 15_000
export const QUESTION_REQUEST_RETRIES = 2

export class SurfaceRequestTimeoutError extends Error {
  constructor() {
    super("Question request timed out")
    this.name = "SurfaceRequestTimeoutError"
  }
}

export function isQuestionNotFoundError(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes("Question request not found")) return true
    if (error.message.includes("Form action request is no longer pending")) return true
    if (isQuestionNotFoundError(error.cause)) return true
  }
  if (typeof error !== "object" || error === null) return false
  const value = error as Record<string, unknown>
  if (value.status === 404 || value.status === 410) return true
  if (value.name === "QuestionNotFoundError" || value._tag === "QuestionNotFoundError") return true
  if (isQuestionNotFoundError(value.body)) return true
  return isQuestionNotFoundError(value.data)
}

/**
 * Should-retry predicate for non-idempotent question reply/reject requests.
 * An abort is terminal because question replies are not idempotent. The caller
 * keeps submitted question requests alive across component cleanup: the server
 * can remove the question before its successful POST response reaches us.
 */
export function shouldRetrySurfaceRequest(error: unknown) {
  return !isQuestionNotFoundError(error) && !isAbortError(error)
}

function isAbortError(error: unknown) {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError") return true
  return isAbortError(error.cause)
}

export type SurfaceRequestStatus =
  | { type: "idle" }
  | { type: "submitting"; attempt: number }
  | { type: "retrying"; retry: number; maxRetries: number }
  | { type: "failed"; message: string }

export type SurfaceRequestRetryDecision<T> = { type: "retry" } | { type: "settled"; value: T }

function questionRequestAttempt<T>(
  run: (signal: AbortSignal, attempt: number) => Promise<T>,
  attempt: number,
  timeoutMs: number,
  onController?: (controller: AbortController | undefined) => void,
) {
  const controller = new AbortController()
  onController?.(controller)
  let timeout: number | undefined
  const timeoutFailure = new Promise<T>((_, reject) => {
    timeout = window.setTimeout(() => {
      reject(new SurfaceRequestTimeoutError())
      controller.abort()
    }, timeoutMs)
  })
  return Promise.race([run(controller.signal, attempt), timeoutFailure]).finally(() => {
    if (timeout !== undefined) window.clearTimeout(timeout)
    onController?.(undefined)
  })
}

export async function runSurfaceRequestWithRetries<T>(input: {
  run: (signal: AbortSignal, attempt: number) => Promise<T>
  retries?: number
  timeoutMs?: number
  shouldRetry?: (error: unknown) => boolean
  reconcileBeforeRetry?: (error: unknown, attempt: number) => Promise<SurfaceRequestRetryDecision<T>>
  onStatus?: (status: SurfaceRequestStatus) => void
  onController?: (controller: AbortController | undefined) => void
}) {
  const retries = input.retries ?? QUESTION_REQUEST_RETRIES
  const timeoutMs = input.timeoutMs ?? QUESTION_REQUEST_TIMEOUT_MS
  let lastError: unknown

  for (const attempt of Array.from({ length: retries + 1 }, (_, index) => index)) {
    input.onStatus?.(attempt === 0 ? { type: "submitting", attempt } : { type: "retrying", retry: attempt, maxRetries: retries })
    try {
      return await questionRequestAttempt(input.run, attempt, timeoutMs, input.onController)
    } catch (error) {
      lastError = error
      if (attempt >= retries || input.shouldRetry?.(error) === false) break
      const decision = await input.reconcileBeforeRetry?.(error, attempt)
      if (decision?.type === "settled") return decision.value
    }
  }

  throw lastError
}
