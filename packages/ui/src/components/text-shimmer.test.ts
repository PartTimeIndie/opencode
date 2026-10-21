import { expect, test } from "bun:test"

const css = await Bun.file(new URL("./text-shimmer.css", import.meta.url)).text()

test("active text shimmer keeps the working-text brightness pulse", () => {
  expect(css).toContain("animation-name: text-shimmer-sweep, text-shimmer-pulse")
  expect(css).toContain("animation-duration: var(--text-shimmer-duration), 2s")
  expect(css).toContain("@keyframes text-shimmer-pulse")
  expect(css).toContain("opacity: 0.4")
  expect(css).toContain("opacity: 1")
  expect(css).toContain("@media (prefers-reduced-motion: reduce)")
})
