import { expect, test } from "bun:test"
import { pluginDisplayName } from "../src/util/plugin-name"

test("plugin labels prefer metadata while handling legacy paths and packages", () => {
  expect(pluginDisplayName("voice-conversation-app", " Voice Conversation ")).toBe("Voice Conversation")
  expect(pluginDisplayName("file:///C:/plugins/speech-to-text-app/index.js")).toBe("Speech To Text")
  expect(pluginDisplayName("C:\\plugins\\visual-qa-app\\index.ts")).toBe("Visual QA")
  expect(pluginDisplayName("@scope/opencode-scheduler@1.2.3")).toBe("Scheduler")
  expect(pluginDisplayName("./plugins/git-workbench-app/", " ")).toBe("GIT Workbench")
  expect(pluginDisplayName("some-plugin", 42)).toBe("Some")
})
