## Memory-safe Markdown caching

- Keep the shared Markdown render cache bounded by both entry count and estimated retained string bytes. Large session or tool output must still render, but must not remain in the global cache. Cover byte-budget, oversized-entry, and entry-count eviction in unit tests.

## Markdown file previews

- Read project-relative session Markdown links through the scoped file reader, never against the renderer URL. Missing, denied, binary files and missing readers must fail visibly without a web-route fallback. Decode before normalizing slashes and reject parent segments, control characters, UNC and drive-qualified paths before reading. Preserve desktop-only opening for `file:` links.
- Remote documents resolve nested links and images against their document URL, never through the project reader. Preview-owned image loads must work on first open, including delayed responses; do not depend on an image resolver created for the original chat message.
- Keep previews bounded to 2 MiB. Closing or unmounting aborts pending requests and removes handlers/timers. Only the topmost preview handles Escape/Tab; keep the background inert, retain nested link wrappers, and restore focus on close. Header and code Copy share a fallback-capable helper. Cover routing, images, limits, cancellation and copy with unit tests plus real browser regression checks on desktop/mobile and light/dark themes.
