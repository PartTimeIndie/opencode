import { describe, expect, test } from "bun:test"
import type { CommandV2Info } from "@opencode-ai/sdk/v2/client"
import { normalizeCommandList } from "@/context/global-sync/utils"
import { commandToSlashCommand, searchSlashCommands, slashSearchContext, supportsSlashCommand } from "./slash-search"

describe("slash command search", () => {
  test("finds every topic-named skill through /Unity and /Video regardless of case", () => {
    const names = [
      "unity-pixel-perfect",
      "unity-localization",
      "levelplay-unity-integration",
      "video-transcribe-cut",
      "video-extract-recording",
      "hotel-finder",
    ]
    const catalog = normalizeCommandList(
      names.map((name) => ({ name, template: "", source: "skill" as const })),
    ).map(commandToSlashCommand)
    for (const query of ["/Unity", "/unity", "/UNITY"]) {
      expect(
        searchSlashCommands(catalog, slashSearchContext(query, query.length))
          .map((command) => command.trigger)
          .toSorted(),
      ).toEqual(names.filter((name) => name.includes("unity")).toSorted())
    }
    const query = "/Video"
    expect(
      searchSlashCommands(catalog, slashSearchContext(query, query.length))
        .map((command) => command.trigger)
        .toSorted(),
    ).toEqual(names.filter((name) => name.includes("video")).toSorted())
  })

  test("finds a renamed skill through its legacy alias but selects its canonical topic name once", () => {
    const catalog = normalizeCommandList([
      {
        name: "unity-pixel-perfect",
        aliases: ["2d-pixel-perfect", "pixel setup"],
        template: "",
        source: "skill" as const,
      },
    ]).map(commandToSlashCommand)
    for (const query of ["/2d-pixel-perfect", "/Unity", "/pixel"]) {
      const results = searchSlashCommands(catalog, slashSearchContext(query, query.length))
      expect(results).toHaveLength(1)
      expect(results[0]).toMatchObject({ trigger: "unity-pixel-perfect", id: "custom.unity-pixel-perfect", source: "skill" })
    }
    expect(searchSlashCommands(catalog, slashSearchContext("/", 1))).toHaveLength(1)
  })

  test("topic search includes matches beyond the initial catalog subset", () => {
    const catalog = normalizeCommandList(
      Array.from({ length: 240 }, (_, index) => ({
        name: `${index % 2 ? "unity" : "video"}-workflow-${index}`,
        template: "",
        source: "skill" as const,
      })),
    ).map(commandToSlashCommand)
    for (const query of ["/Unity", "/Video"]) {
      const results = searchSlashCommands(catalog, slashSearchContext(query, query.length))
      expect(results).toHaveLength(120)
      expect(results.some((command) => command.trigger.endsWith(query === "/Unity" ? "-239" : "-238"))).toBe(true)
    }
  })

  test("matches a literal leading-slash skill from the V2 command catalog", () => {
    const catalog = normalizeCommandList([
      {
        name: "on-demand-ui",
        template: "Use the UI skill",
        description: "Open a native UI",
        source: "skill",
      } satisfies CommandV2Info,
    ]).map(commandToSlashCommand)
    const input = "/on-demand-ui"
    const search = slashSearchContext(input, input.length)

    expect(search?.token).toBe("on-demand-ui")
    expect(searchSlashCommands(catalog, search).map((command) => command.trigger)).toEqual(["on-demand-ui"])
  })

  test("keeps the complete slash skill catalog instead of showing only an initial subset", () => {
    const catalog = normalizeCommandList(
      Array.from({ length: 240 }, (_, index) => ({
        name: index === 239 ? "on-demand-ui" : `skill-${index}`,
        template: "",
        description: `Skill ${index}`,
        source: "skill" as const,
      })),
    ).map(commandToSlashCommand)

    const results = searchSlashCommands(catalog, slashSearchContext("/", 1))
    expect(results).toHaveLength(240)
    expect(results.some((command) => command.trigger === "on-demand-ui")).toBe(true)
  })

  test("keeps a slash expression closed after its first space until a new slash starts", () => {
    const value = "/on-demand-ui argument"

    expect(slashSearchContext(value, value.length)).toBeUndefined()
    expect(slashSearchContext(value, "/on-demand".length)).toBeUndefined()

    const next = `${value} /pdf`
    expect(slashSearchContext(next, next.length)?.token).toBe("pdf")
  })

  test("filters skills whose required tools are missing from an explicit agent policy", () => {
    const command = commandToSlashCommand(
      normalizeCommandList([
        {
          name: "on-demand-ui",
          template: "",
          source: "skill",
          requiredTools: ["surface"],
        },
      ])[0]!,
    )

    expect(supportsSlashCommand(command, { tools: { mode: "explicit", entries: {} } })).toBe(false)
    expect(
      supportsSlashCommand(command, {
        tools: {
          mode: "explicit",
          entries: { surface: { visible: true, permission: "allow" } },
        },
      }),
    ).toBe(true)
    expect(supportsSlashCommand(command, { tools: { mode: "inherit", entries: {} } })).toBe(true)
    expect(
      supportsSlashCommand(command, {
        tools: { mode: "inherit", entries: { surface: { visible: false, permission: "allow" } } },
      }),
    ).toBe(false)
    expect(
      supportsSlashCommand(command, {
        tools: { mode: "inherit", entries: { surface: { visible: true, permission: "deny" } } },
      }),
    ).toBe(false)
  })
})
