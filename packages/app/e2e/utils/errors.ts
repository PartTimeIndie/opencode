import { expect, type Page } from "@playwright/test"

export function trackPageErrors(page: Page) {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
  return errors
}

export function trackNetworkFailures(page: Page) {
  const failures: string[] = []
  page.on("requestfailed", (request) =>
    failures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`),
  )
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
  return failures
}

export function expectNoSmokeErrors(consoleErrors: string[], toastErrors: string[], forbiddenText: string[]) {
  expect({ consoleErrors, toastErrors, forbiddenText }).toEqual({
    consoleErrors: [],
    toastErrors: [],
    forbiddenText: [],
  })
}
