import { expect, test, type Page } from "@playwright/test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const directory = dirname(fileURLToPath(import.meta.url))
const componentURL = `/@fs/${resolve(directory, "../../../ui/src/components/resize-handle.tsx").replaceAll("\\", "/")}`
const stylesURL = `/@fs/${resolve(directory, "../../../ui/src/components/resize-handle.css").replaceAll("\\", "/")}`

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
})

test.describe("resize handle pointer input", () => {
  test("exposes a coarse pointer target and edge-aware keyboard controls", async ({ page }) => {
    await loadFixture(page)
    const handle = page.getByRole("separator")

    await expect(handle).toHaveAttribute("tabindex", "0")
    await expect(handle).toHaveAttribute("aria-orientation", "vertical")
    await expect(handle).toHaveAttribute("aria-valuemin", "160")
    await expect(handle).toHaveAttribute("aria-valuemax", "360")
    await expect(handle).toHaveAttribute("aria-valuenow", "200")
    await expect(handle).toHaveCSS("touch-action", "none")

    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(
      await handle.evaluate((element) => ({
        width: getComputedStyle(element, "::after").width,
        opacity: getComputedStyle(element, "::after").opacity,
        background: getComputedStyle(element, "::after").backgroundColor,
      })),
    ).toEqual({
      width: "1px",
      opacity: "0.55",
      background: "rgb(63, 63, 70)",
    })

    await handle.dispatchEvent("pointerdown", {
      pointerId: 99,
      pointerType: "pen",
      isPrimary: false,
      button: 0,
      clientX: 200,
      clientY: 120,
    })
    expect(await snapshot(page)).toMatchObject({
      externalPointerDown: 1,
      captures: [],
      bodyUserSelect: "text",
      bodyOverflow: "clip",
    })
    await handle.dispatchEvent("pointerdown", {
      pointerId: 100,
      pointerType: "pen",
      isPrimary: true,
      button: 2,
      clientX: 200,
      clientY: 120,
    })
    expect(await snapshot(page)).toMatchObject({
      externalPointerDown: 2,
      captures: [],
      bodyUserSelect: "text",
      bodyOverflow: "clip",
    })

    await handle.focus()
    await handle.press("ArrowLeft")
    await handle.press("ArrowRight")
    expect(await snapshot(page)).toMatchObject({
      sizes: [184, 216],
      keys: ["ArrowLeft", "ArrowRight"],
    })

    await loadFixture(page, "start")
    const startHandle = page.getByRole("separator")
    await startHandle.focus()
    await startHandle.press("ArrowLeft")
    await startHandle.press("ArrowRight")
    expect(await snapshot(page)).toMatchObject({
      sizes: [216, 184],
      keys: ["ArrowLeft", "ArrowRight"],
    })
  })

  test("captures a real touch drag and collapses only from the raw pointerup size", async ({ page }) => {
    await loadFixture(page)
    const touch = await beginTouch(page)

    expect(await snapshot(page)).toMatchObject({
      externalPointerDown: 1,
      captures: [expect.any(Number)],
      bodyUserSelect: "none",
      bodyOverflow: "hidden",
    })

    await touch.session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(touch.x - 100, touch.y)],
    })
    await touch.session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })

    expect(await snapshot(page)).toMatchObject({
      sizes: [160, 160],
      collapses: 1,
      releases: [expect.any(Number)],
      bodyUserSelect: "text",
      bodyOverflow: "clip",
      events: expect.arrayContaining(["pointerup", "lostpointercapture"]),
    })
  })

  test("cancel, lost capture, blur, and disposal restore body state without collapse", async ({ page }) => {
    await loadFixture(page)
    const canceled = await beginTouch(page)
    await canceled.session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [touchPoint(canceled.x - 100, canceled.y)],
    })
    await canceled.session.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    })
    expect(await snapshot(page)).toMatchObject({
      collapses: 0,
      bodyUserSelect: "text",
      bodyOverflow: "clip",
      events: expect.arrayContaining(["pointercancel", "lostpointercapture"]),
    })

    await loadFixture(page)
    const lost = await beginTouch(page)
    await page.evaluate(() => {
      const fixture = (window as FixtureWindow).resizeHandleFixture
      document
        .querySelector<HTMLElement>('[data-component="resize-handle"]')
        ?.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: fixture.pointerID }))
    })
    await expect
      .poll(async () => snapshot(page))
      .toMatchObject({
        collapses: 0,
        bodyUserSelect: "text",
        bodyOverflow: "clip",
        events: expect.arrayContaining(["lostpointercapture"]),
      })
    await lost.session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })

    await loadFixture(page)
    const blurred = await beginTouch(page)
    await page.evaluate(() => window.dispatchEvent(new Event("blur")))
    expect(await snapshot(page)).toMatchObject({
      collapses: 0,
      bodyUserSelect: "text",
      bodyOverflow: "clip",
    })
    await blurred.session.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    })

    await loadFixture(page)
    const disposed = await beginTouch(page)
    await page.evaluate(() => (window as FixtureWindow).resizeHandleFixture.dispose())
    expect(await snapshot(page)).toMatchObject({
      collapses: 0,
      bodyUserSelect: "text",
      bodyOverflow: "clip",
    })
    await disposed.session.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    })
  })
})

async function loadFixture(page: Page, edge: "start" | "end" = "end") {
  await page.unroute("**/resize-handle-pointer-fixture*")
  await page.route("**/resize-handle-pointer-fixture*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: fixtureHTML(),
    }),
  )
  await page.goto(`/resize-handle-pointer-fixture?edge=${edge}`)
  await page.waitForFunction(() => (window as FixtureWindow).resizeHandleFixture?.ready === true)
}

async function beginTouch(page: Page) {
  const box = await page.getByRole("separator").boundingBox()
  if (!box) throw new Error("Resize handle is not visible")
  const session = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(x, y)],
  })
  return { session, x, y }
}

function touchPoint(x: number, y: number) {
  return {
    x,
    y,
    id: 1,
    radiusX: 1,
    radiusY: 1,
    force: 1,
  }
}

function snapshot(page: Page) {
  return page.evaluate(() => {
    const fixture = (window as FixtureWindow).resizeHandleFixture
    return {
      sizes: fixture.sizes,
      collapses: fixture.collapses,
      externalPointerDown: fixture.externalPointerDown,
      keys: fixture.keys,
      captures: fixture.captures,
      releases: fixture.releases,
      events: fixture.events,
      bodyUserSelect: document.body.style.userSelect,
      bodyOverflow: document.body.style.overflow,
    }
  })
}

function fixtureHTML() {
  return `<!doctype html>
    <html style="--border-strong-base:rgb(63,63,70)">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body style="margin:0;user-select:text;overflow:clip">
        <div id="fixture" style="position:relative;width:200px;height:240px;margin:80px"></div>
        <script type="module">
          import { createComponent } from "/@id/solid-js"
          import { render } from "/@id/solid-js/web"
          import { ResizeHandle } from "${componentURL}"
          import "${stylesURL}"

          const fixture = (window.resizeHandleFixture = {
            ready: false,
            sizes: [],
            collapses: 0,
            externalPointerDown: 0,
            pointerID: -1,
            keys: [],
            captures: [],
            releases: [],
            events: [],
            dispose: () => {},
          })
          fixture.dispose = render(
            () =>
              createComponent(ResizeHandle, {
                direction: "horizontal",
                edge: new URL(location.href).searchParams.get("edge") === "start" ? "start" : "end",
                size: 200,
                min: 160,
                max: 360,
                collapseThreshold: 150,
                onResize: (size) => fixture.sizes.push(size),
                onCollapse: () => fixture.collapses++,
                onPointerDown: (event) => {
                  fixture.externalPointerDown++
                  fixture.pointerID = event.pointerId
                },
                onKeyDown: (event) => fixture.keys.push(event.key),
              }),
            document.querySelector("#fixture"),
          )
          const handle = document.querySelector('[data-component="resize-handle"]')
          const setPointerCapture = handle.setPointerCapture.bind(handle)
          const releasePointerCapture = handle.releasePointerCapture.bind(handle)
          handle.setPointerCapture = (pointerID) => {
            fixture.captures.push(pointerID)
            setPointerCapture(pointerID)
          }
          handle.releasePointerCapture = (pointerID) => {
            fixture.releases.push(pointerID)
            releasePointerCapture(pointerID)
          }
          for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
            handle.addEventListener(type, () => fixture.events.push(type))
          }
          fixture.ready = true
        </script>
      </body>
    </html>`
}

type FixtureWindow = Window &
  typeof globalThis & {
    resizeHandleFixture: {
      ready: boolean
      sizes: number[]
      collapses: number
      externalPointerDown: number
      pointerID: number
      keys: string[]
      captures: number[]
      releases: number[]
      events: string[]
      dispose: () => void
    }
  }
