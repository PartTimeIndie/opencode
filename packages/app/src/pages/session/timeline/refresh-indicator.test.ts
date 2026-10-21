import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createRefreshIndicator } from "./refresh-indicator"

test("delays the refresh indicator for an already-loaded session", async () => {
  const state = createRoot((dispose) => {
    return {
      dispose,
      visible: createRefreshIndicator({
        sessionID: () => "ses_loaded",
        refreshing: () => true,
        ready: () => true,
        delay: 20,
      }),
    }
  })

  await Bun.sleep(5)
  expect(state.visible()).toBe(false)
  await Bun.sleep(25)
  expect(state.visible()).toBe(true)
  state.dispose()
})

test("cancels a delayed indicator when the refresh finishes quickly", async () => {
  let refreshing = true
  const state = createRoot((dispose) => {
    return {
      dispose,
      visible: createRefreshIndicator({
        sessionID: () => "ses_loaded",
        refreshing: () => refreshing,
        ready: () => true,
        delay: 20,
      }),
    }
  })

  await Bun.sleep(5)
  refreshing = false
  await Bun.sleep(25)
  expect(state.visible()).toBe(false)
  state.dispose()
})

test("shows the refresh indicator immediately while a session loads for the first time", () => {
  createRoot((dispose) => {
    const visible = createRefreshIndicator({
      sessionID: () => "ses_new",
      refreshing: () => true,
      ready: () => false,
    })

    expect(visible()).toBe(true)
    dispose()
  })
})
