import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectNoSmokeErrors, trackPageErrors } from "../utils/errors"

test("retained plugin signals release detached views after disposal", async ({ page }) => {
  await page.route("**/__plugin-memory-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Plugin disposal memory regression</title>",
    }),
  )
  await page.goto("/__plugin-memory-test")
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const cdp = await page.context().newCDPSession(page)

  await page.evaluate(async () => {
    // Vite serves the actual implementation, not a copy of the disposal logic.
    const mountPath = "/src/plugin/mount-lifecycle.ts"
    const scopePath = "/src/plugin/scope-lifecycle.ts"
    const mounts = await import(mountPath)
    const scopes = await import(scopePath)
    const signals: AbortSignal[] = []
    const views: WeakRef<HTMLElement>[] = []
    const state = { signals, views }
    Object.assign(window, { pluginMemoryTest: state })

    function cycle() {
      const view = document.createElement("section")
      view.append(document.createElement("div"))
      views.push(new WeakRef(view))
      const dispose = mounts.mountPluginElement({
        element: document.createElement("div"),
        mount(signal: AbortSignal) {
          signals.push(signal)
        },
      })
      const scope = { id: "test", controller: new AbortController(), disposers: [] }
      signals.push(scope.controller.signal)
      const disposer = scopes.createPluginScopeDisposer({
        current: () => scope,
        snapshot: () => [[scope.id, scope]],
        release: () => {},
      })
      // V8's default abort DOMException captures this function and its view.
      // Keeping the signal must not keep this completed cleanup's closure.
      function cleanup() {
        dispose()
        view.remove()
        return disposer.dispose(scope.id)
      }
      return cleanup()
    }

    for (let index = 0; index < 40; index++) await cycle()
  })

  // Collect in a separate task so WeakRef's current-job keepalive has ended.
  await cdp.send("HeapProfiler.collectGarbage")
  const result = await page.evaluate(() => {
    const state = (
      window as unknown as {
        pluginMemoryTest: { signals: AbortSignal[]; views: WeakRef<HTMLElement>[] }
      }
    ).pluginMemoryTest
    return {
      retained: state.views.filter((view) => view.deref()).length,
      total: state.views.length,
      aborted: state.signals.every((signal) => signal.aborted && signal.reason.name === "AbortError"),
    }
  })
  expect(result).toEqual({ retained: 0, total: 40, aborted: true })
  expect(errors).toEqual([])
})

test("store-backed scopes and floating controls release view-capturing callbacks", async ({ page }) => {
  await page.route("**/__plugin-memory-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Plugin scope memory regression</title>",
    }),
  )
  await page.goto("/__plugin-memory-test")
  const cdp = await page.context().newCDPSession(page)
  await page.evaluate(async () => {
    const storePath = "/e2e/fixtures/plugin-memory.ts"
    const scopePath = "/src/plugin/scope-lifecycle.ts"
    const floatingPath = "/src/plugin/floating.ts"
    const { createStore } = await import(storePath)
    const { createPluginScopeDisposer } = await import(scopePath)
    const { createFloatingHost } = await import(floatingPath)
    const retained: unknown[] = []
    const views: WeakRef<HTMLElement>[] = []
    const signals: AbortSignal[] = []
    Object.assign(window, { pluginMemoryTest: { retained, views, signals } })

    async function cycle() {
      const view = document.createElement("section")
      views.push(new WeakRef(view))
      const scope = { id: "test", controller: new AbortController(), disposers: [() => view.remove()] }
      retained.push(scope)
      signals.push(scope.controller.signal)
      const [store] = createStore({ scope })
      const disposer = createPluginScopeDisposer({
        current: () => store.scope,
        snapshot: () => [[scope.id, store.scope]],
        release: () => {},
      })
      await disposer.disposeAll()

      const host = createFloatingHost({
        authorized: () => true,
        track: (dispose: () => void) => dispose,
        subscribe: () => () => {},
      })
      const handle = host.open({
        id: "memory",
        title: "Memory regression",
        sessions: { directory: "/fixture", ids: ["one"] },
        mount({ signal, element }: { signal: AbortSignal; element: HTMLElement }) {
          signals.push(signal)
          views.push(new WeakRef(element))
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      handle.close()
    }
    for (let index = 0; index < 40; index++) await cycle()
  })
  // Blink retains the last removed panel until the next rendering lifecycle.
  // Finish that lifecycle before measuring JS retention, rather than allowing
  // any detached views in the assertion or waiting for an arbitrary timeout.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  await cdp.send("HeapProfiler.collectGarbage")
  const result = await page.evaluate(() => {
    const state = (
      window as unknown as {
        pluginMemoryTest: { views: WeakRef<HTMLElement>[]; signals: AbortSignal[] }
      }
    ).pluginMemoryTest
    return {
      retained: state.views.filter((view) => view.deref()).length,
      total: state.views.length,
      aborted: state.signals.every((signal) => signal.aborted && signal.reason.name === "AbortError"),
    }
  })
  expect(result).toEqual({ retained: 0, total: 80, aborted: true })
})

test("real plugin overlays release their views and leave the app usable", async ({ page }) => {
  const directory = "C:/OpenCode/PluginMemory"
  const errors = trackPageErrors(page)
  const failed: string[] = []
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`)
  })
  await mockOpenCodeServer(page, {
    directory,
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "memory-model": { id: "memory-model", name: "Memory Model", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "memory-model" },
    },
    project: {
      id: "memory",
      worktree: directory,
      vcs: "git",
      name: "plugin-memory",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    sessions: [
      {
        id: "ses_memory",
        slug: "memory",
        projectID: "memory",
        directory,
        title: "Renderer memory regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "memory-test",
            spec: "memory-test",
            version: "1",
            hash: "memory-test",
            capabilities: ["ui:toolbar", "ui:overlay"],
            module: "/app/plugin/memory-test/1/index.js",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/memory-test/1/index.js**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: `
      export default {
        id: "memory-test",
        app(api) {
          globalThis.overlayMemoryTest = { signals: [], views: [] }
          api.toolbar.register({
            id: "open", title: "Open memory panel", placement: "composer", icon: { name: "code" },
            run() {
              api.ui.overlay.open({
                id: "memory", title: "Memory test panel",
                mount({ element, signal }) {
                  element.textContent = "Plugin panel can be closed safely."
                  globalThis.overlayMemoryTest.signals.push(signal)
                  globalThis.overlayMemoryTest.views.push(new WeakRef(element))
                },
              })
            },
          })
        },
      }
    `,
    }),
  )
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem(
      "opencode.global.dat:plugin-toolbar-visibility",
      JSON.stringify({
        version: 1,
        global: { "memory-test/open": true },
        projects: {},
      }),
    )
  })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/?dir=${base64Encode(directory)}&session=ses_memory`)
  const open = page.getByRole("button", { name: "Open memory panel", exact: true })
  const panel = page.getByRole("dialog", { name: "Memory test panel", exact: true })
  for (let index = 0; index < 20; index++) {
    await open.click()
    await expect(panel).toBeVisible()
    await expect(panel).toContainText("Plugin panel can be closed safely.")
    await page.getByRole("button", { name: "Close Memory test panel", exact: true }).click()
    await expect(panel).toBeHidden()
  }
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("HeapProfiler.collectGarbage")
  expect(
    await page.evaluate(() => {
      const state = (
        window as unknown as {
          overlayMemoryTest: { signals: AbortSignal[]; views: WeakRef<HTMLElement>[] }
        }
      ).overlayMemoryTest
      return {
        retained: state.views.filter((view) => view.deref()).length,
        total: state.views.length,
        aborted: state.signals.every(
          (signal) => signal.aborted && signal.reason.name === "AbortError" && signal.reason.stack === "",
        ),
      }
    }),
  ).toEqual({ retained: 0, total: 20, aborted: true })
  await expect(open).toBeEnabled()
  await expect(page.locator('[data-component="session-composer"]')).toBeVisible()
  if (process.env.VISUAL_QA_SCREENSHOT_DIR) {
    await page.screenshot({
      path: `${process.env.VISUAL_QA_SCREENSHOT_DIR}/renderer-memory-after-20-overlays.png`,
      fullPage: true,
    })
  }
  expectNoSmokeErrors(errors, [], failed)
})
