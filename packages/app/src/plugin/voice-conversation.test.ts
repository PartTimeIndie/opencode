// Keep the durable plugin's behavioral contracts in the normal app unit suite.
await import(new URL("../../../../.opencode/plugin-sources/voice-conversation-app/core.test.js", import.meta.url).href)
await import(new URL("./voice-conversation-lifecycle.test.js", import.meta.url).href)
