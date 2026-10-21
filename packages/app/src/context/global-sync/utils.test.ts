import { describe, expect, test } from "bun:test"
import type { Agent, CommandV2Info } from "@opencode-ai/sdk/v2/client"
import { pathKey } from "@/utils/path-key"
import { directoryKey, normalizeAgentList, normalizeCommandList } from "./utils"

const agent = (name = "build") =>
  ({
    name,
    mode: "primary",
    permission: {},
    options: {},
  }) as Agent

describe("normalizeAgentList", () => {
  test("keeps array payloads", () => {
    expect(normalizeAgentList([agent("build"), agent("docs")])).toEqual([agent("build"), agent("docs")])
  })

  test("wraps a single agent payload", () => {
    expect(normalizeAgentList(agent("docs"))).toEqual([agent("docs")])
  })

  test("extracts agents from keyed objects", () => {
    expect(
      normalizeAgentList({
        build: agent("build"),
        docs: agent("docs"),
      }),
    ).toEqual([agent("build"), agent("docs")])
  })

  test("drops invalid payloads", () => {
    expect(normalizeAgentList({ name: "AbortError" })).toEqual([])
    expect(normalizeAgentList([{ name: "build" }, agent("docs")])).toEqual([agent("docs")])
  })
})

describe("normalizeCommandList", () => {
  test("unwraps the real V2 command model shape", () => {
    const command = {
      name: "on-demand-ui",
      template: "Use the UI skill",
      description: "Open a native UI",
      source: "skill",
      requiredTools: ["surface"],
      aliases: ["native ui", "question popup"],
      model: { providerID: "openai", id: "gpt-5.6", variant: "max" },
    } satisfies CommandV2Info

    expect(normalizeCommandList([command])).toEqual([
      {
        name: "on-demand-ui",
        template: "Use the UI skill",
        description: "Open a native UI",
        agent: undefined,
        model: "openai/gpt-5.6",
        variant: "max",
        source: "skill",
        requiredTools: ["surface"],
        aliases: ["native ui", "question popup"],
        subtask: undefined,
        hints: [],
      },
    ])
  })
})

describe("directoryKey", () => {
  test("normalizes Windows directory identity case-insensitively", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("c:/repos/sst/opencode")
    expect(String(directoryKey("c:/repos/SST/opencode/"))).toBe("c:/repos/sst/opencode")
    expect(String(directoryKey("\\\\Server\\Share\\Project"))).toBe("//server/share/project")
  })

  test("normalizes forward-slash UNC directory identity case-insensitively", () => {
    expect(String(directoryKey("//Server/Share/Project"))).toBe("//server/share/project")
    expect(String(pathKey("//Server/Share/Project"))).toBe("//Server/Share/Project")
  })

  test("preserves case and backslashes in posix paths", () => {
    expect(String(directoryKey("/Repo-A/Project"))).toBe("/Repo-A/Project")
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("c:/repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("c:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
