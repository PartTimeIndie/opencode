import { describe, expect, test } from "bun:test"
import { Message } from "@opencode-ai/llm"
import { Schema } from "effect"
import { AgentV2 } from "../src/agent"
import { Config } from "../src/config"
import { ConfigSkillGroups } from "../src/config/skill-groups"
import { AbsolutePath } from "../src/schema"
import { SkillV2 } from "../src/skill"
import { SkillCatalog } from "../src/skill/catalog"
import { SkillTool } from "../src/tool/skill"
import { ConfigV1 } from "../src/v1/config/config"
import { ConfigMigrateV1 } from "../src/v1/config/migrate"

const skill = (name: string, extra: Partial<SkillV2.Info> = {}) =>
  new SkillV2.Info({
    name,
    description: `Use ${name} for a specialized workflow with controlled inputs and verified outputs.`,
    content: `SECRET BODY ${name}`,
    location: AbsolutePath.make(`C:/fixtures/${name}/SKILL.md`),
    groups: ["media"],
    ...extra,
  })
const config: ConfigSkillGroups.Info = {
  enabled: true,
  groups: [{ id: "media", title: "Media", description: "Image, video and audio work." }],
}
const fixtures = [skill("image"), skill("video"), skill("audio")]

describe("description-only skill groups", () => {
  for (const count of [0, 1, 2, 3, 4])
    test(`${count} visible children use the minimum-three threshold`, () => {
      const catalog = SkillCatalog.project([...fixtures, skill("fourth")].slice(0, count), config)
      expect(catalog.root.map((item) => item.type)).toEqual(count >= 3 ? ["group"] : Array(count).fill("skill"))
    })
  test("root omits unopened descriptions and all bodies; expansion has direct descriptions only", () => {
    const catalog = SkillCatalog.project([...fixtures, skill("standalone", { groups: undefined })], config)
    expect(SkillCatalog.render(catalog)).not.toContain(fixtures[0].description!)
    expect(catalog.root.some((item) => item.name === "standalone")).toBe(true)
    expect(SkillCatalog.expand(catalog, "media")).toContain(fixtures[0].description!)
    expect(SkillCatalog.expand(catalog, "media")).not.toContain("SECRET BODY")
    expect(SkillCatalog.expand(catalog, "unknown")).toBeUndefined()
  })
  test("three children do not force a larger representation", () => {
    const catalog = SkillCatalog.project(fixtures, {
      enabled: true,
      groups: [{ ...config.groups[0], description: "x".repeat(2000) }],
    })
    expect(catalog.root.every((item) => item.type === "skill")).toBe(true)
  })
  test("manual, denied and missing-tool children cannot meet the threshold or leak", () => {
    const agent = new AgentV2.Info({
      ...AgentV2.Info.empty(AgentV2.ID.make("build")),
      permissions: [{ action: "skill", resource: "audio", effect: "deny" }],
    })
    const permitted = SkillV2.available(
      [...fixtures, skill("manual", { disableModelInvocation: true }), skill("tool", { requiredTools: ["missing"] })],
      agent,
      { mode: "explicit", entries: {} },
    )
    const catalog = SkillCatalog.project(permitted, config)
    expect(catalog.root.map((item) => item.name)).toEqual(["image", "video"])
    expect(SkillCatalog.render(catalog)).not.toContain("manual")
  })
  test("nested groups expose direct subgroups, not grandchildren", () => {
    const nested = {
      enabled: true,
      groups: [...config.groups, { id: "studio", title: "Studio", description: "Production", parent: "media" }],
    }
    const catalog = SkillCatalog.project(
      fixtures.map((item) => new SkillV2.Info({ ...item, groups: ["studio"] })),
      nested,
    )
    // A parent whose representation is not cheaper than its one child is flattened.
    expect(catalog.root.map((item) => item.name)).toEqual(["studio"])
    expect(SkillCatalog.expand(catalog, "studio")).toContain("<name>audio</name>")
  })
  test("multiple memberships and duplicate registration stay deterministic and deduplicated", () => {
    const multi = {
      enabled: true,
      groups: [...config.groups, { id: "second", title: "Second", description: "Second family" }],
    }
    const items = fixtures.map((item) => new SkillV2.Info({ ...item, groups: ["second", "media", "media"] }))
    const a = SkillCatalog.project([...items, items[0]], multi)
    const b = SkillCatalog.project([...items].reverse(), { ...multi, groups: [...multi.groups].reverse() })
    expect(a).toEqual(b)
    expect(Object.keys(a.groups)).toEqual(["media"])
    expect(a.groups.media).toHaveLength(3)
  })
  test("exact retained output suppresses repeats, lost or stale output reloads", () => {
    const catalog = SkillCatalog.project(fixtures, config)
    const output = SkillCatalog.expand(catalog, "media")!
    expect(SkillCatalog.expand(catalog, "media", [output])).toContain("already present")
    expect(SkillCatalog.expand(catalog, "media", [])).toBe(output)
    expect(SkillCatalog.expand(catalog, "media", ["summary mentions media"])).toBe(output)
    const changed = SkillCatalog.project([skill("image", { content: "changed" }), ...fixtures.slice(1)], config)
    expect(changed.revision).not.toBe(catalog.revision)
    expect(SkillCatalog.expand(changed, "media", [output])).not.toContain("already present")
  })
  test("explicit flat mode is a rollback, standalone and canonical names survive", () => {
    expect(SkillCatalog.project(fixtures).root).toHaveLength(3)
    expect(SkillCatalog.project(fixtures, { ...config, enabled: false }).root).toHaveLength(3)
    const catalog = SkillCatalog.project(fixtures, { ...config, memberships: { image: [] } })
    expect(catalog.root.every((item) => item.type === "skill")).toBe(true)
    expect(SkillV2.resolveSelected(fixtures, ["image"]).skills[0].content).toBe("SECRET BODY image")
  })
  test("both config dialects validate and migrate groups", () => {
    expect(Schema.decodeUnknownSync(Config.Info)({ skill_groups: config }).skill_groups).toEqual(config)
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ skill_groups: config }).skill_groups).toEqual(config)
    expect(
      ConfigMigrateV1.migrate(Schema.decodeUnknownSync(ConfigV1.Info)({ skill_groups: config })).skill_groups,
    ).toEqual(config)
    for (const groups of [
      [config.groups[0], config.groups[0]],
      [{ ...config.groups[0], parent: "missing" }],
      [{ ...config.groups[0], parent: "media" }],
    ]) {
      expect(() => Schema.decodeUnknownSync(ConfigSkillGroups.Info)({ groups })).toThrow()
    }
    expect(() =>
      Schema.decodeUnknownSync(ConfigSkillGroups.Info)({ groups: [], memberships: { image: ["missing"] } }),
    ).toThrow()
  })
  test("unknown explicit metadata is reported but ungrouped is valid", () => {
    expect(SkillCatalog.project([skill("bad", { groups: ["missing"] })], config).issues).toEqual([
      "Unknown group missing for skill bad",
    ])
    expect(SkillCatalog.project([skill("single", { groups: undefined })], config).issues).toEqual([])
  })
  test("tool input is disjoint and preserves the old name shape", () => {
    const decode = Schema.decodeUnknownSync(SkillTool.Input)
    expect(decode({ name: "image" })).toEqual({ name: "image" })
    expect(decode({ group: "media" })).toEqual({ group: "media" })
    for (const input of [{}, { name: "image", group: "media" }, { group: 12 }]) expect(() => decode(input)).toThrow()
  })
  test("descriptor markup is escaped", () => {
    expect(
      SkillCatalog.render(SkillCatalog.project([skill("<evil>", { description: "<tag>&", groups: [] })])),
    ).toContain("&lt;tag&gt;&amp;")
  })
})

test("only group results actually retained in the final model request suppress expansion", () => {
  const catalog = SkillCatalog.project(fixtures, config)
  const full = SkillCatalog.expand(catalog, "media")!
  const part = {
    type: "tool-result" as const,
    name: "skill",
    id: "group",
    result: { type: "text" as const, value: full },
  }
  expect(SkillCatalog.retainedOutputs([new Message({ role: "tool", content: [part] })])).toEqual([full])
  expect(
    SkillCatalog.retainedOutputs([new Message({ role: "user", content: [{ type: "text", text: full }] })]),
  ).toEqual([])
  expect(SkillCatalog.retainedOutputs([])).toEqual([])
  expect(SkillCatalog.expand(catalog, "media", SkillCatalog.retainedOutputs([]))).toBe(full)
})
