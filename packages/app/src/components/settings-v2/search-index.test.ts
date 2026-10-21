import { describe, expect, test } from "bun:test"
import {
  SETTINGS_TAB_ORDER,
  canonicalSettingsTab,
  pluginSettingsFieldAction,
  pluginSettingsSearchEntries,
  pluginSettingsSectionAction,
  pluginToolbarAction,
  searchSettings,
} from "./search-index"

describe("searchSettings", () => {
  test("finds plugin-owned search terms and nested list fields without host-specific keywords", () => {
    const entries = pluginSettingsSearchEntries(
      [
        {
          id: "neutral-example",
          title: "Example",
          searchTerms: ["Sprachausgabe"],
          sections: [
            {
              title: "Options",
              fields: [
                {
                  key: "rows",
                  type: "list",
                  label: "Rows",
                  fields: [{ key: "speaker", type: "text", label: "Preferred narrator" }],
                },
              ],
            },
          ],
        },
      ],
      [],
    )
    expect(searchSettings((key) => key, "Sprachausgabe", entries).length).toBeGreaterThan(0)
    expect(searchSettings((key) => key, "narrator", entries)[0]?.anchor).toBe(
      pluginSettingsFieldAction("neutral-example", 0, "rows"),
    )
  })
  test("searches overlay-hidden fields and anchors them to the overlay button", () => {
    const entries = pluginSettingsSearchEntries(
      [
        {
          id: "speech",
          pluginID: "speech-to-text-app",
          title: "Speech to Text",
          sections: [
            {
              title: "Automatic improvement",
              fields: [
                { key: "improvementPromptTemplate", type: "textarea", label: "Improvement prompt template" },
                {
                  key: "improvementPrompts",
                  type: "overlay",
                  label: "Improvement prompts",
                  description: "Default improvement skills and per-application prompt overrides.",
                  fields: [
                    { key: "defaultImprovementSkills", type: "skill-list", label: "Default improvement skills" },
                    {
                      key: "applicationProfiles",
                      type: "list",
                      label: "Application profiles",
                      fields: [{ key: "prompt", type: "textarea", label: "Improvement prompt" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [],
    )
    const overlayAnchor = pluginSettingsFieldAction("speech-to-text-app", 0, "improvementPrompts")
    expect(searchSettings((key) => key, "application profiles", entries)[0]).toMatchObject({
      tab: "plugins",
      anchor: overlayAnchor,
      title: "Application profiles",
    })
    expect(searchSettings((key) => key, "improvement skills", entries)[0]).toMatchObject({
      anchor: overlayAnchor,
      title: "Default improvement skills",
    })
    // No entry may anchor to a field that only renders inside the overlay dialog.
    expect(entries.map((entry) => entry.anchor)).not.toContain(
      pluginSettingsFieldAction("speech-to-text-app", 0, "defaultImprovementSkills"),
    )
  })

  test("finds the follow-up message queue setting", () => {
    expect(searchSettings((key) => key, "message queue")[0]).toMatchObject({
      tab: "general",
      anchor: "settings-followup-behavior",
      title: "settings.general.row.followup.title",
    })
  })

  test("finds the browser automation setting", () => {
    expect(searchSettings((key) => key, "playwright")[0]).toMatchObject({
      tab: "general",
      anchor: "settings-browser-automation",
      title: "settings.general.row.browserAutomation.title",
    })
  })

  test("finds the default model chain setting and the safety chain row", () => {
    expect(searchSettings((key) => key, "default model chain")[0]).toMatchObject({
      tab: "models",
      anchor: "settings-model-default-chain",
    })
    expect(
      searchSettings((key) => key, "safety chain").some(
        (result) => result.tab === "general" && result.anchor === "settings-safety-review-chain",
      ),
    ).toBe(true)
  })

  test("finds storage integrity and archive controls", () => {
    expect(SETTINGS_TAB_ORDER.at(-2)).toBe("storage")
    expect(searchSettings((key) => key, "integrity dry run")[0]).toMatchObject({
      tab: "storage",
      anchor: "settings-storage-health",
      title: "settings.storage.section.health",
    })
    expect(searchSettings((key) => key, "archive blob backup").some((result) => result.tab === "storage")).toBe(true)
    expect(searchSettings((key) => key, "migration dry run")[0]?.anchor).toBe("settings-storage-migration-dry-run")
    expect(searchSettings((key) => key, "session retention")[0]?.anchor).toBe("settings-storage-session-retention")
    expect(searchSettings((key) => key, "snapshot cleanup")[0]).toMatchObject({
      tab: "storage",
      anchor: "settings-storage-cleanup",
      title: "settings.storage.cleanup.title",
    })
  })

  test("routes skill and plugin settings to one tab", () => {
    expect(SETTINGS_TAB_ORDER).not.toContain("skills")
    expect(canonicalSettingsTab("skills")).toBe("plugins")
    expect(searchSettings((key) => key, "microphone")).toEqual([])
  })

  test("finds every registered plugin setting and toolbar contribution", () => {
    const entries = pluginSettingsSearchEntries(
      [
        {
          id: "voice-tools",
          pluginID: "voice-tools-app",
          title: "Voice Tools",
          sections: [
            {
              title: "Transcription",
              fields: [
                {
                  key: "language",
                  type: "select",
                  label: "Spoken language",
                  description: "Language used for speech recognition.",
                  options: [
                    { value: "de", label: "German" },
                    { value: "en", label: "English" },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [
        {
          id: "voice-tools-app/record",
          pluginID: "voice-tools-app",
          title: "Record voice",
          tooltip: "Start recording",
        },
      ],
    )

    expect(searchSettings((key) => key, "German", entries)[0]).toMatchObject({
      tab: "plugins",
      anchor: pluginSettingsFieldAction("voice-tools-app", 0, "language"),
      title: "Spoken language",
    })
    expect(searchSettings((key) => key, "Voice Tools Transcription", entries)[0]).toMatchObject({
      tab: "plugins",
      title: "Voice Tools · Transcription",
    })
    expect(searchSettings((key) => key, "record voice", entries)[0]).toMatchObject({
      tab: "plugins",
      anchor: pluginToolbarAction("voice-tools-app/record"),
      title: "Record voice",
    })
    expect(pluginSettingsSectionAction("speech-to-text-app", 0)).toBe("settings-plugin-speech-to-text-app")
    expect(pluginSettingsSectionAction("speech-to-text-app", 1)).toBe("settings-plugin-speech-to-text-app-1")
  })

  test("does not return unrelated plugin rows for a short unmatched query", () => {
    const entries = pluginSettingsSearchEntries(
      [
        {
          id: "git-workbench",
          pluginID: "git-workbench-app",
          title: "Git Workbench",
          sections: [
            {
              title: "General",
              fields: [
                { key: "commitModel", type: "select", label: "Commit model", description: "Model used by AI Commit." },
              ],
            },
          ],
        },
      ],
      [],
    )
    expect(searchSettings((key) => key, "grok", entries).some((result) => result.title === "Commit model")).toBe(false)
  })

  test("finds configured grok reviewers", () => {
    const entries = pluginSettingsSearchEntries([{
      id: "neutral-reviews", title: "Quality checks", sections: [],
      searchEntries: () => [{ title: "Reviewer 1: cursor/grok-4.6", keywords: ["cursor/grok-4.6"] }],
    }], [])
    expect(searchSettings((key) => key, "grok", entries)[0]).toMatchObject({
      tab: "plugins",
      anchor: "settings-plugin-neutral-reviews",
      title: "Reviewer 1: cursor/grok-4.6",
    })
  })
})
