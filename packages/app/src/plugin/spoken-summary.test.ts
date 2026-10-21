// Keep plugin behavior contracts in the normal app unit suite.
await import(new URL("../../../../.opencode/plugin-sources/spoken-summary-app/core.test.js", import.meta.url).href)
await import(new URL("../../../../.opencode/plugin-sources/spoken-summary-app/playback.test.js", import.meta.url).href)
await import(new URL("../../../../.opencode/plugin-sources/spoken-summary-app/app.test.js", import.meta.url).href)
