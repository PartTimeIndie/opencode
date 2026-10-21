import { afterEach, describe, expect, test } from "bun:test"
import { jsonSchema, tool, type Tool, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import { LLMRequestPrep } from "@/session/llm/request"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"

const originalFeatures = process.env.OPENCODE_OPTIMIZATION_FEATURES
const originalProfile = process.env.OPENCODE_OPTIMIZATION_PROFILE

afterEach(() => {
  if (originalFeatures === undefined) delete process.env.OPENCODE_OPTIMIZATION_FEATURES
  else process.env.OPENCODE_OPTIMIZATION_FEATURES = originalFeatures
  if (originalProfile === undefined) delete process.env.OPENCODE_OPTIMIZATION_PROFILE
  else process.env.OPENCODE_OPTIMIZATION_PROFILE = originalProfile
})

describe("LLMRequestPrep.resolveTools", () => {
  test("keeps all filtered tools when deferred discovery is disabled", () => {
    delete process.env.OPENCODE_OPTIMIZATION_FEATURES
    process.env.OPENCODE_OPTIMIZATION_PROFILE = "off"

    expect(Object.keys(LLMRequestPrep.resolveTools(baseInput()))).toEqual(["read", "fetch", "task"])
  })

  test("keeps all filtered tools when config disables request optimizations", () => {
    delete process.env.OPENCODE_OPTIMIZATION_FEATURES
    delete process.env.OPENCODE_OPTIMIZATION_PROFILE

    expect(Object.keys(LLMRequestPrep.resolveTools(baseInput({ optimizationProfile: "off" })))).toEqual([
      "read",
      "fetch",
      "task",
    ])
  })

  test("enables safe request optimizations by default", () => {
    delete process.env.OPENCODE_OPTIMIZATION_FEATURES
    delete process.env.OPENCODE_OPTIMIZATION_PROFILE

    const messages = captureConsoleError(() => {
      const resolved = LLMRequestPrep.resolveTools(
        baseInput({ extraTools: { apply_patch: makeTool("apply_patch"), bash: makeTool("bash"), glob: makeTool("glob"), grep: makeTool("grep") } }),
      )

      expect(Object.keys(resolved).toSorted()).toEqual([
        "apply_patch",
        "apply_patch_and_verify",
        "bash",
        "fetch",
        "glob",
        "grep",
        "read",
        "task",
      ])
      expect(resolved.read?.description).toBe("Read a file or directory. Use absolute filePath, and offset/limit for ranges.")
      expect(resolved.fetch?.description).toBe("fetch tool")
      expect(resolved.tool_catalog_search).toBeUndefined()
    })

    expect(messages.join("\n")).toContain("optimization diagnostics")
    expect(messages.join("\n")).toContain("compact_tool_schemas")
    expect(messages.join("\n")).toContain("patch_verify_tool")
    expect(messages.join("\n")).not.toContain("batch_core_tools")
  })

  test("advertises core tools plus catalog tools when deferred discovery is enabled", () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"

    expect(Object.keys(LLMRequestPrep.resolveTools(baseInput())).toSorted()).toEqual([
      "read",
      "task",
      "tool_catalog_run",
      "tool_catalog_search",
    ])
  })

  test("keeps interactive user-facing tools direct when deferred discovery is enabled", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"

    const resolved = LLMRequestPrep.resolveTools(
      baseInput({ extraTools: { surface: makeTool("surface") } }),
    )
    expect(Object.keys(resolved).toSorted()).toEqual([
      "read",
      "surface",
      "task",
      "tool_catalog_run",
      "tool_catalog_search",
    ])

    const search = resolved.tool_catalog_search
    if (!search?.execute) throw new Error("tool_catalog_search was not returned")
    const output = await search.execute({ query: "surface", limit: 10 }, toolOptions())
    expect(String(output)).not.toContain("tool: surface")
  })

  test("keeps the unified agent switch direct unless explicit policy hides it", () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"
    const switches = { switch_agent: makeTool("switch_agent") }

    expect(Object.keys(LLMRequestPrep.resolveTools(baseInput({ extraTools: switches }))).toSorted()).toContain(
      "switch_agent",
    )
    const hidden = LLMRequestPrep.resolveTools(
      baseInput({
        extraTools: switches,
        agentTools: {
          mode: "explicit",
          entries: {},
        },
      }),
    )
    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        extraTools: switches,
        agentTools: { mode: "explicit", entries: { switch_agent: { visible: true, permission: "allow" } } },
      }),
    )

    expect(hidden.switch_agent).toBeUndefined()
    expect(resolved.switch_agent).toBeDefined()
  })

  test("keeps every disabled web tool out of explicit build requests", () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"
    const web = Object.fromEntries(
      [
        "webfetch",
        "websearch",
        "browser_snapshot",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_wait",
      ].map((name) => [name, makeTool(name)]),
    )
    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        extraTools: web,
        agentTools: {
          mode: "explicit",
          entries: { read: { visible: true, permission: "allow" } },
        },
      }),
    )

    expect(Object.keys(resolved)).toContain("read")
    expect(Object.keys(resolved).filter((name) => name.startsWith("browser_") || name.startsWith("web"))).toEqual([])
  })

  test("keeps spawn agent direct when deferred discovery is enabled", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"

    const resolved = LLMRequestPrep.resolveTools(baseInput({ extraTools: { spawn_agent: makeTool("spawn_agent") } }))
    expect(Object.keys(resolved).toSorted()).toEqual([
      "read",
      "spawn_agent",
      "task",
      "tool_catalog_run",
      "tool_catalog_search",
    ])

    const search = resolved.tool_catalog_search
    if (!search?.execute) throw new Error("tool_catalog_search was not returned")
    const output = await search.execute({ query: "spawn", limit: 10 }, toolOptions())
    expect(String(output)).not.toContain("tool: spawn_agent")
  })

  test("does not expose user-disabled tools through catalog search", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"

    const resolved = LLMRequestPrep.resolveTools(
      baseInput({ tools: { fetch: false }, extraTools: { lsp: makeTool("lsp") } }),
    )
    const search = resolved.tool_catalog_search
    if (!search?.execute) throw new Error("tool_catalog_search was not returned")

    const output = await search.execute({ query: "tool", limit: 10 }, toolOptions())
    expect(String(output)).toContain("tool: lsp")
    expect(String(output)).not.toContain("tool: fetch")
  })

  test("matches deferred catalog tools by multi-word query tokens", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"

    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        extraTools: {
          context7_get_library_docs: tool({
            description: "MCP server context7 tool. Fetch documentation",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => "docs",
          }),
          unityMCP_read_console: tool({
            description: "Read Unity Editor console entries",
            inputSchema: jsonSchema({ type: "object", properties: {} }),
            execute: async () => "console",
          }),
        },
      }),
    )
    const search = resolved.tool_catalog_search
    if (!search?.execute) throw new Error("tool_catalog_search was not returned")

    const context7 = await search.execute({ query: "context7 mcp", limit: 10 }, toolOptions())
    expect(String(context7)).toContain("tool: context7_get_library_docs")

    const unity = await search.execute({ query: "unity mcp", limit: 10 }, toolOptions())
    expect(String(unity)).toContain("tool: unityMCP_read_console")
  })

  test("runs deferred tools through the original tool execute function", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "deferred_tool_discovery"
    const calls: unknown[] = []
    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        fetchTool: tool({
          description: "fetch tool",
          inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } }, required: ["value"] }),
          execute: async (input) => {
            calls.push(input)
            return { output: "fetched", title: "fetch", metadata: {} }
          },
        }),
      }),
    )
    const run = resolved.tool_catalog_run
    if (!run?.execute) throw new Error("tool_catalog_run was not returned")

    const output = await run.execute({ tool: "fetch", input: { value: "ok" } }, toolOptions())
    expect(calls).toEqual([{ value: "ok" }])
    expect(output).toEqual({ output: "fetched", title: "fetch", metadata: {} })
  })

  test("compacts only core tool descriptions and input schemas when enabled", () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "compact_tool_schemas"

    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        readTool: tool({
          description: "Long read description that should be replaced",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              filePath: { type: "string", description: "Long file path description" },
              limit: { type: "number", description: "Long limit description" },
            },
          }),
          execute: async () => "read ok",
        }),
      }),
    )

    expect(resolved.read?.description).toBe("Read a file or directory. Use absolute filePath, and offset/limit for ranges.")
    expect(schemaDescription(resolved.read?.inputSchema, "filePath")).toBe("Absolute file or directory path.")
    expect(schemaDescription(resolved.read?.inputSchema, "limit")).toBe("Maximum lines to return.")
    expect(resolved.fetch?.description).toBe("fetch tool")
  })

  test("adds patch-and-verify only when apply_patch and bash are available", () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "patch_verify_tool"

    expect(LLMRequestPrep.resolveTools(baseInput()).apply_patch_and_verify).toBeUndefined()
    expect(
      LLMRequestPrep.resolveTools(
        baseInput({ extraTools: { apply_patch: makeTool("apply_patch"), bash: makeTool("bash") } }),
      ).apply_patch_and_verify,
    ).toBeDefined()
  })

  test("runs patch-and-verify through apply_patch then bash", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "patch_verify_tool"
    const calls: string[] = []
    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        extraTools: {
          apply_patch: tool({
            description: "patch tool",
            inputSchema: jsonSchema({ type: "object", properties: { patchText: { type: "string" } } }),
            execute: async (input) => {
              calls.push(`patch:${isRecord(input) ? input.patchText : ""}`)
              return { output: "patched", title: "patch", metadata: {} }
            },
          }),
          bash: tool({
            description: "bash tool",
            inputSchema: jsonSchema({ type: "object", properties: { command: { type: "string" } } }),
            execute: async (input) => {
              calls.push(`bash:${isRecord(input) ? input.command : ""}`)
              return { output: "tests ok", title: "verify", metadata: { exit: 0 } }
            },
          }),
        },
      }),
    )
    const run = resolved.apply_patch_and_verify
    if (!run?.execute) throw new Error("apply_patch_and_verify was not returned")

    const output = await run.execute(
      { patchText: "*** Begin Patch\n*** End Patch", command: "python -m unittest", description: "Run unit tests" },
      toolOptions(),
    )
    expect(calls).toEqual(["patch:*** Begin Patch\n*** End Patch", "bash:python -m unittest"])
    expect(String(output)).toContain("Patch result:\npatched")
    expect(String(output)).toContain("Verifier result:\ntests ok")
  })

  test("adds batch tools only when their base tools are available", () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "batch_core_tools"

    expect(Object.keys(LLMRequestPrep.resolveTools(baseInput())).toSorted()).toEqual([
      "batch_read",
      "fetch",
      "read",
      "task",
    ])
    expect(
      Object.keys(
        LLMRequestPrep.resolveTools(baseInput({ extraTools: { glob: makeTool("glob"), grep: makeTool("grep") } })),
      ).toSorted(),
    ).toEqual(["batch_glob", "batch_grep", "batch_read", "fetch", "glob", "grep", "read", "task"])
  })

  test("runs batch_read through the original read tool and reports per-request errors", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "batch_core_tools"
    const calls: unknown[] = []
    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        readTool: tool({
          description: "read tool",
          inputSchema: jsonSchema({ type: "object", properties: { filePath: { type: "string" } } }),
          execute: async (input) => {
            calls.push(input)
            if (isRecord(input) && input.filePath === "/bad.ts") throw new Error("missing file")
            return { output: `read ${isRecord(input) ? input.filePath : ""}`, title: "read", metadata: {} }
          },
        }),
      }),
    )
    const run = resolved.batch_read
    if (!run?.execute) throw new Error("batch_read was not returned")

    const output = await run.execute(
      { requests: [{ filePath: "/a.ts" }, { filePath: "/bad.ts" }, { filePath: "/b.ts", offset: 3 }] },
      toolOptions(),
    )

    expect(calls).toEqual([{ filePath: "/a.ts" }, { filePath: "/bad.ts" }, { filePath: "/b.ts", offset: 3 }])
    expect(String(output)).toContain("## request 1: /a.ts\nread /a.ts")
    expect(String(output)).toContain("## request 2: /bad.ts\nERROR: missing file")
    expect(String(output)).toContain("## request 3: /b.ts\nread /b.ts")
  })

  test("does not reuse stale read output when external state changes between identical calls", async () => {
    process.env.OPENCODE_OPTIMIZATION_FEATURES = "tool_materialization_cache"
    let externalFileState = "before"
    const calls: string[] = []
    const resolved = LLMRequestPrep.resolveTools(
      baseInput({
        readTool: tool({
          description: "read tool",
          inputSchema: jsonSchema({ type: "object", properties: { filePath: { type: "string" } } }),
          execute: async (input) => {
            calls.push(`read:${isRecord(input) ? input.filePath : ""}`)
            return { output: externalFileState, title: "read", metadata: {} }
          },
        }),
      }),
    )
    if (!resolved.read?.execute) throw new Error("read tool missing execute")

    const before = await resolved.read.execute({ filePath: "/a.ts" }, toolOptions())
    // Simulates bash, an external editor, or a git action changing the file.
    externalFileState = "after"
    const after = await resolved.read.execute({ filePath: "/a.ts" }, toolOptions())

    expect(calls).toEqual(["read:/a.ts", "read:/a.ts"])
    expect(before).toEqual({ output: "before", title: "read", metadata: {} })
    expect(after).toEqual({ output: "after", title: "read", metadata: {} })
  })
})

describe("LLMRequestPrep.prepare", () => {
  const prepareSystem = (agent: Record<string, unknown>) =>
    Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_system",
          sessionID: "session-system",
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID: "cursor", modelID: "composer-2.5" },
        } as any,
        sessionID: "session-system",
        model: {
          id: "composer-2.5",
          providerID: "cursor",
          api: { id: "composer-2.5", url: "https://cursor.com", npm: "@stablekernel/opencode-cursor" },
          capabilities: { reasoning: false, temperature: false },
          limit: { output: 4096 },
          options: {},
          headers: {},
        } as any,
        agent: { name: "test", mode: "primary", options: {}, permission: [], ...agent } as any,
        system: ["SERVER-SAFETY"],
        messages: [{ role: "user", content: "Hello" }],
        tools: {},
        provider: { id: "cursor", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
        optimization: ConfigOptimization.resolve([], {}),
      }),
    )

  test("applies inherit, append, replace and legacy system prompt semantics independently", async () => {
    const inherited = await prepareSystem({ systemMode: "inherit", prompt: "CUSTOM" })
    const appended = await prepareSystem({ systemMode: "append", prompt: "CUSTOM" })
    const replaced = await prepareSystem({ systemMode: "replace", prompt: "CUSTOM" })
    const legacy = await prepareSystem({ prompt: "CUSTOM" })

    expect(inherited.system.join("\n")).not.toContain("CUSTOM")
    expect(appended.system.join("\n")).toContain("CUSTOM")
    expect(appended.system.join("\n").length).toBeGreaterThan(replaced.system.join("\n").length)
    expect(replaced.system).toEqual(["CUSTOM\nSERVER-SAFETY"])
    expect(legacy.system).toEqual(["CUSTOM\nSERVER-SAFETY"])
  })

  test("marks Cursor subagent requests as ephemeral", async () => {
    const result = await Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_cursor",
          sessionID: "session-child",
          role: "user",
          time: { created: Date.now() },
          agent: "general",
          model: { providerID: "cursor", modelID: "composer-2.5" },
        } as any,
        sessionID: "session-child",
        parentSessionID: "session-parent",
        model: {
          id: "composer-2.5",
          providerID: "cursor",
          api: { id: "composer-2.5", url: "https://cursor.com", npm: "@stablekernel/opencode-cursor" },
          capabilities: { reasoning: false, temperature: false },
          limit: { output: 4096 },
          options: {},
          headers: {},
        } as any,
        agent: { name: "general", mode: "subagent", options: {}, permission: [] } as any,
        system: [],
        messages: [{ role: "user", content: "Hello" }],
        tools: {},
        provider: { id: "cursor", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
        optimization: ConfigOptimization.resolve([], {}),
      }),
    )

    expect(result.params.options.ephemeral).toBe(true)
  })

  test("disables strict tool mode for OpenAI Responses-compatible SDKs", async () => {
    for (const npm of ["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"]) {
      const result = await Effect.runPromise(
        LLMRequestPrep.prepare({
          user: {
            id: `msg_${npm}`,
            sessionID: "session-test",
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "openai", modelID: "gpt-5" },
          } as any,
          sessionID: "session-test",
          model: {
            id: "gpt-5",
            providerID: "openai",
            api: { id: "gpt-5", url: "https://api.openai.com/v1", npm },
            capabilities: { reasoning: true, temperature: false },
            limit: { output: 4096 },
            options: {},
            headers: {},
          } as any,
          agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
          system: [],
          messages: [{ role: "user", content: "Hello" }],
          tools: { demo: makeTool("demo") },
          provider: { id: "openai", options: {} } as any,
          auth: undefined,
          plugin: {
            trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
            list: () => Effect.succeed([]),
            init: () => Effect.void,
          } as any,
          flags: { outputTokenMax: 32_000, client: "test" } as any,
          isWorkflow: false,
          optimization: ConfigOptimization.resolve([], {}),
        }),
      )

      expect((result.tools.demo as any).strict).toBe(false)
    }
  })
})

describe("LLMRequestPrep.summarizeRequestFootprint", () => {
  test("reports system prompt, message, and active tool footprint without invalid tools", () => {
    const summary = LLMRequestPrep.summarizeRequestFootprint({
      system: ["system one", "system two"],
      messages: [{ role: "user", content: "Hello" }],
      tools: { read: makeTool("read"), invalid: makeTool("invalid") },
    })

    expect(summary.activeToolNames).toEqual(["read"])
    expect(summary.messageCount).toBe(1)
    expect(summary.systemPromptChars).toBe("system one\nsystem two".length)
    expect(summary.systemPromptEstimateTokens).toBeGreaterThan(0)
    expect(summary.toolSchemaBytes).toBeGreaterThan(0)
    expect(summary.contextEstimateTokens).toBeGreaterThan(summary.systemPromptEstimateTokens)
  })

  test("does not count attached base64 images as text tokens", () => {
    const summary = LLMRequestPrep.summarizeRequestFootprint({
      system: ["system"],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see attached screenshot" },
            { type: "file", data: `data:image/png;base64,${"A".repeat(1_000_000)}`, mediaType: "image/png" },
          ],
        },
      ],
      tools: {},
    })

    // A ~1MB base64 image must not register as ~250k text tokens and trip auto-compaction.
    expect(summary.contextEstimateTokens).toBeGreaterThanOrEqual(1_600)
    expect(summary.contextEstimateTokens).toBeLessThan(5_000)
  })
})

function baseInput(
  input: {
    tools?: Record<string, boolean>
    fetchTool?: Tool
    readTool?: Tool
    extraTools?: Record<string, Tool>
    agentTools?: { mode: "inherit" | "explicit"; entries: Record<string, { visible?: boolean; permission?: "allow" | "ask" | "deny" }> }
    optimizationProfile?: ConfigOptimization.Profile
  } = {},
) {
  type ResolveInput = Parameters<typeof LLMRequestPrep.resolveTools>[0]
  return {
    tools: {
      read: input.readTool ?? makeTool("read"),
      fetch: input.fetchTool ?? makeTool("fetch"),
      task: makeTool("task"),
      ...(input.extraTools ?? {}),
    },
    agent: { name: "test", mode: "primary", options: {}, permission: [], tools: input.agentTools } as ResolveInput["agent"],
    user: { tools: input.tools } as ResolveInput["user"],
    sessionID: `test-session-${counter++}`,
    optimization: ConfigOptimization.resolve(
      input.optimizationProfile === undefined
        ? []
        : [{ type: "document", info: { optimization: { profile: input.optimizationProfile } } }],
    ),
  } satisfies ResolveInput
}

let counter = 0

function makeTool(name: string) {
  return tool({
    description: `${name} tool`,
    inputSchema: jsonSchema({ type: "object", properties: { value: { type: "string" } } }),
    execute: async () => `${name} ok`,
  })
}

function toolOptions() {
  return {
    toolCallId: "call_test",
    abortSignal: new AbortController().signal,
  } as ToolExecutionOptions
}

function schemaDescription(value: unknown, property: string) {
  if (!isRecord(value) || !isRecord(value.jsonSchema)) return undefined
  if (!isRecord(value.jsonSchema.properties)) return undefined
  const item = value.jsonSchema.properties[property]
  return isRecord(item) ? item.description : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function captureConsoleError(run: () => void) {
  const original = console.error
  const messages: string[] = []
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "))
  }
  try {
    run()
  } finally {
    console.error = original
  }
  return messages
}
