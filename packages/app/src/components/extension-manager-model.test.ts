import { describe, expect, test } from "bun:test"
import { filterAndSortExtensions, type ExtensionItem } from "./extension-manager-model"

const item = (values: Partial<ExtensionItem> & Pick<ExtensionItem, "id" | "name">): ExtensionItem => ({
  kind: "plugin",
  source: "project",
  scope: "project",
  removable: true,
  ...values,
})

describe("filterAndSortExtensions", () => {
  const items = [
    item({
      id: "navigator",
      name: "Session Navigator",
      description: "Browse recent sessions",
      target: "app",
      targets: ["app"],
      path: "C:/Project/plugins/session-navigator",
    }),
    item({
      id: "cursor",
      name: "Cursor Provider",
      target: "app",
      source: "global",
      scope: "global",
      spec: "cursor-opencode-provider",
      removable: false,
      reason: "Nicht projektlokal",
      availableIn: "Global (auch neue Projekte)",
    }),
    item({ id: "terminal", name: "Terminal Tools", targets: ["cli", "app"], target: "cli" }),
  ]

  test("filters case-insensitively across visible metadata and combines source and removable filters", () => {
    expect(
      filterAndSortExtensions(items, {
        query: "  GLOBAL ",
        source: "global",
        removable: false,
        sortBy: "name",
        direction: "asc",
      }).map((extension) => extension.id),
    ).toEqual(["cursor"])

    expect(
      filterAndSortExtensions(items, {
        query: "session",
        sortBy: "name",
        direction: "asc",
      }).map((extension) => extension.id),
    ).toEqual(["navigator"])

    expect(
      filterAndSortExtensions(items, {
        query: "missing",
        sortBy: "name",
        direction: "asc",
      }),
    ).toEqual([])
  })

  test("sorts by a selected field, compares numeric names naturally, and reverses direction", () => {
    const named = [item({ id: "ten", name: "Plugin 10" }), item({ id: "two", name: "Plugin 2" }), ...items]

    expect(
      filterAndSortExtensions(named.slice(0, 2), {
        query: "plugin",
        sortBy: "name",
        direction: "asc",
      }).map((extension) => extension.id),
    ).toEqual(["two", "ten"])

    expect(
      filterAndSortExtensions(items, {
        query: "",
        sortBy: "target",
        direction: "asc",
      }).map((extension) => extension.id),
    ).toEqual(["cursor", "navigator", "terminal"])

    expect(
      filterAndSortExtensions(items, {
        query: "",
        sortBy: "name",
        direction: "desc",
      }).map((extension) => extension.id),
    ).toEqual(["terminal", "navigator", "cursor"])
  })

  test("sorts and filters through the skill availability callback without changing inputs", () => {
    const skills = [
      item({ id: "local", kind: "skill", name: "local-skill", path: "C:/Project/local" }),
      item({ id: "global", kind: "skill", name: "global-skill", path: "C:/Project/global" }),
    ]
    const availability = (candidate: ExtensionItem) =>
      candidate.id === "global" ? "Global (auch neue Projekte)" : "Projekt (1)"
    const input = [...skills]

    const ordered = filterAndSortExtensions(skills, {
      query: "",
      sortBy: "availability",
      direction: "asc",
      availableIn: availability,
    })
    expect(ordered.map((extension) => extension.id)).toEqual(["global", "local"])
    expect(ordered.map((extension) => extension.name)).toEqual(["global-skill", "local-skill"])
    expect(ordered.every((extension, index) => extension === skills[index])).toBe(false)
    expect(ordered[0]).toBe(skills[1])
    expect(skills.map((extension) => extension.id)).toEqual(["local", "global"])
    expect(input).toEqual(skills)

    expect(
      filterAndSortExtensions(skills, {
        query: "neue projekte",
        sortBy: "name",
        direction: "asc",
        availableIn: availability,
      }).map((extension) => extension.id),
    ).toEqual(["global"])
  })
})
