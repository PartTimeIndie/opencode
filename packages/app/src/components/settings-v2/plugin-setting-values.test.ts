import { describe, expect, test } from "bun:test"
import { createPluginSettingItem, pluginSettingDefaults, readPluginSetting, updatePluginSetting } from "./plugin-setting-values"

describe("nested plugin settings", () => {
  test("edits one list row without discarding other rows or unknown plugin data", () => {
    const before = {
      rows: [
        { model: "missing/model", voice: "old", extra: true },
        { model: "second", voice: "keep" },
      ],
      future: 7,
    }
    const after = updatePluginSetting(before, ["rows", 0, "voice"], "new")
    expect(after).toEqual({
      rows: [
        { model: "missing/model", voice: "new", extra: true },
        { model: "second", voice: "keep" },
      ],
      future: 7,
    })
    expect(before.rows[0]?.voice).toBe("old")
    expect(readPluginSetting(after, ["rows", 0, "model"], "")).toBe("missing/model")
  })

  test("uses defaults for absent fields while retaining false and empty values", () => {
    expect(readPluginSetting({ enabled: false }, ["enabled"], true)).toBe(false)
    expect(readPluginSetting({ name: "" }, ["name"], "default")).toBe("")
    expect(readPluginSetting(undefined, ["nested", "name"], "default")).toBe("default")
    expect(updatePluginSetting(undefined, ["nested", "name"], "value")).toEqual({ nested: { name: "value" } })
  })

  test("new list rows own independent mutable defaults", () => {
    const fields = [
      { key: "nested", type: "object" as const, label: "Nested", default: { values: [] as string[] }, fields: [] },
    ]
    const first = pluginSettingDefaults(fields)
    const second = pluginSettingDefaults(fields)
    ;(first.nested as { values: string[] }).values.push("only first")
    expect(second).toEqual({ nested: { values: [] } })
    expect(fields[0]?.default).toEqual({ values: [] })
  })

  test("overlay fields store no value while nested fields keep flat settings keys", () => {
    const fields = [
      { key: "template", type: "textarea" as const, label: "Template", default: "polish" },
      {
        key: "improvementPrompts",
        type: "overlay" as const,
        label: "Improvement prompts",
        fields: [{ key: "defaultImprovementSkills", type: "skill-list" as const, label: "Skills", default: ["first"] }],
      },
    ]
    expect(pluginSettingDefaults(fields)).toEqual({ template: "polish" })
    // The overlay is a layout container: nested fields read and write their own flat plugin settings key.
    expect(readPluginSetting({ defaultImprovementSkills: ["second"] }, ["defaultImprovementSkills"], [])).toEqual(["second"])
    expect(updatePluginSetting({ template: "polish" }, ["defaultImprovementSkills"], ["second"])).toEqual({
      template: "polish",
      defaultImprovementSkills: ["second"],
    })
  })
})


test("a neutral list plugin can compute fresh defaults without mutating saved rows", () => {
  const items = [{ name: "Existing", retained: true }]
  const field = { key: "exports", type: "list" as const, label: "Exports", default: [], fields: [],
    createItem(rows: readonly Record<string, unknown>[]) { rows[0]!.name = "changed copy"; return { name: `Export ${rows.length + 1}`, files: [] } } }
  const next = createPluginSettingItem(field, items)
  expect(items).toEqual([{ name: "Existing", retained: true }])
  expect(next).toEqual({ name: "Export 2", files: [] })
  expect(() => createPluginSettingItem({ ...field, createItem: () => [] as never }, items)).toThrow("must be an object")
})

test("speech profiles use the generic list and preserve current defaults and legacy data", async () => {
  const speech = await import(new URL("../../../../../.opencode/plugin-sources/speech-to-text-app/index.js", import.meta.url).href)
  let skills = ["first"]
  const field = speech.applicationProfileSetting({ get: () => skills })
  expect(field.type).toBe("list")
  expect(field.key).toBe("applicationProfiles")
  expect(field.fields.map((item: { key: string }) => item.key)).toEqual(["name", "processKey", "enabled", "includeSlashCommands", "improvementSkills", "prompt"])
  const legacy = [{ name: "Custom", processKey: "application-1", enabled: false, prompt: "Keep instructions", unknown: 42 }]
  expect(createPluginSettingItem(field, legacy)).toMatchObject({ processKey: "application-2", improvementSkills: ["first"] })
  skills = ["second"]
  expect(createPluginSettingItem(field, legacy)).toMatchObject({ processKey: "application-2", improvementSkills: ["second"] })
  expect(updatePluginSetting(legacy, [0, "name"], "Renamed")).toEqual([{ ...legacy[0], name: "Renamed" }])
  expect(legacy[0]).toEqual({ name: "Custom", processKey: "application-1", enabled: false, prompt: "Keep instructions", unknown: 42 })
})
