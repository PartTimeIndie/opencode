export interface RetryOptions {
  attempts?: number
  delay?: number
  factor?: number
  maxDelay?: number
  retryIf?: (error: unknown) => boolean
}

const TRANSIENT_MESSAGES = [
  "load failed",
  "network connection was lost",
  "network request failed",
  "failed to fetch",
  "econnreset",
  "econnrefused",
  "etimedout",
  "socket hang up",
]

function isTransientError(error: unknown): boolean {
  if (!error) return false
  const status = errorStatus(error)
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) return true
  // oxlint-disable-next-line no-base-to-string -- error is unknown, intentional coercion for message matching
  const message = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MESSAGES.some((m) => message.includes(m))
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return 0
  const direct = "status" in error && typeof error.status === "number" ? error.status : 0
  if (direct) return direct
  const cause = "cause" in error ? error.cause : undefined
  if (cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number") return cause.status
  return "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 0
}

export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, delay = 500, factor = 2, maxDelay = 10000, retryIf = isTransientError } = options

  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !retryIf(error)) throw error
      const wait = Math.min(delay * Math.pow(factor, attempt), maxDelay)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
  throw lastError
}
