// Keep plugin behavior contracts in the normal app unit suite.
await import(new URL("../../../../.opencode/plugin-sources/session-schaubild-app/core.test.js", import.meta.url).href)
await import(new URL("../../../../.opencode/plugin-sources/session-schaubild-app/app.test.js", import.meta.url).href)
