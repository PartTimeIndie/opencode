export const SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 15_000
export const SESSION_MESSAGE_REQUEST_RETRIES = 1
export const SESSION_MESSAGE_REQUEST_TIMEOUT_NAME = "SessionMessageRequestTimeout"

export const isSessionMessageRequestTimeoutError = (error: unknown) =>
  error instanceof Error && error.name === SESSION_MESSAGE_REQUEST_TIMEOUT_NAME

export function withSessionMessageRequestTimeout<T>(input: {
  task: (signal: AbortSignal) => Promise<T>
  signal: AbortSignal
  timeoutMs?: number
  retries?: number
}) {
  const timeoutMs = input.timeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS
  const retries = input.retries ?? SESSION_MESSAGE_REQUEST_RETRIES

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let attempt = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = () => {}
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      input.signal.removeEventListener("abort", abort)
    }
    const succeed = (value: T) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    abort = () => fail(input.signal.reason ?? new DOMException("The request was aborted", "AbortError"))

    if (input.signal.aborted) {
      abort()
      return
    }
    input.signal.addEventListener("abort", abort, { once: true })

    const run = () => {
      const requestController = new AbortController()
      const signal = AbortSignal.any([input.signal, requestController.signal])
      const current = ++attempt
      timer = setTimeout(() => {
        requestController.abort()
        if (current <= retries && !input.signal.aborted) {
          run()
          return
        }
        fail(
          Object.assign(new Error(`Session message request timed out after ${attempt} attempts of ${timeoutMs}ms`), {
            name: SESSION_MESSAGE_REQUEST_TIMEOUT_NAME,
          }),
        )
      }, timeoutMs)

      void Promise.resolve()
        .then(() => input.task(signal))
        .then(
          (value) => {
            if (current !== attempt) return
            succeed(value)
          },
          (error) => {
            if (current !== attempt) return
            fail(error)
          },
        )
    }

    run()
  })
}
