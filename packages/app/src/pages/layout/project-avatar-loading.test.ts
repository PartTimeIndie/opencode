import { describe, expect, test } from "bun:test"

const component = await Bun.file(
  new URL("../../../../ui/src/v2/components/project-avatar-v2.tsx", import.meta.url),
).text()
const css = await Bun.file(
  new URL("../../../../ui/src/v2/components/project-avatar-v2.css", import.meta.url),
).text()

describe("ProjectAvatar running status", () => {
  test("renders an accessible loading ring and lets attention replace it", () => {
    expect(component).toContain('data-slot="project-avatar-loader" role="status" aria-label="Session is running"')
    expect(component).toContain("split.loading && !split.status")
    expect(component).toContain("split.status || (!split.loading && split.unread)")
  })

  test("keeps the ring animated while reducing motion for reduced-motion users", () => {
    const rule = css.match(/\[data-slot="project-avatar-loader"\]\s*\{([\s\S]*?)\}/)?.[1] ?? ""

    expect(rule).toContain("right: -4px")
    expect(rule).toContain("top: -4px")
    expect(rule).toContain("animation: project-avatar-v2-loading-spin")
    expect(css).toContain("@keyframes project-avatar-v2-loading-spin")
    expect(css).toContain("@keyframes project-avatar-v2-loading-pulse")
    expect(css).toContain("animation: project-avatar-v2-loading-pulse 1.4s ease-in-out infinite")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  })
})
