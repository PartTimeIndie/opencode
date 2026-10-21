import { describe, expect } from "bun:test"
import { Tool } from "@opencode-ai/core/tool/tool"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Config } from "@opencode-ai/core/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const MARKER = "opencode.scheduled-job-result/v1"

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.sync(() => ({ output: input.output, outputPaths: [] as string[] })),
})
const registryLayer = ToolRegistry.layer.pipe(Layer.provide(ApplicationTools.layer), Layer.provide(outputStore))
const cacheConfig = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            optimization: new ConfigOptimization.Info({ profile: "speed" }),
          }),
        }),
      ]),
  }),
)
const it = testEffect(registryLayer)
const cached = testEffect(registryLayer.pipe(Layer.provide(cacheConfig)))

const make = () =>
  Tool.make({
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
  })

const contractTool = () => Tool.withContractMarker(Tool.withAlwaysVisible(make()), MARKER)

const sessionID = SessionV2.ID.make("ses_contract_marker")
const agent = AgentV2.ID.make("build")
const identity = {
  agent,
  assistantMessageID: SessionMessage.ID.make("msg_contract_marker"),
}
const context = (lastUserText?: string) => ({ sessionID, agent, ...(lastUserText === undefined ? {} : { lastUserText }) })

const names = (service: ToolRegistry.Interface, materializationContext?: { lastUserText?: string }) =>
  service
    .materialize(undefined, undefined, { ...identity, sessionID, ...materializationContext })
    .pipe(Effect.map((materialized) => materialized.definitions.map((tool) => tool.name)))

describe("ToolRegistry contract-scoped tools", () => {
  it.effect("hides contract-scoped protocol tools on ordinary turns while keeping plain always-visible tools", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        read: Tool.withAlwaysVisible(make()),
        scheduled_job_result: contractTool(),
      })

      expect(yield* names(service)).toEqual(["read"])
      expect(yield* names(service, { lastUserText: "Hallo, wie geht es dir?" })).toEqual(["read"])

      const contextWithoutText = yield* service.materialize(undefined, undefined, { ...identity, sessionID })
      expect(contextWithoutText.definitions.map((tool) => tool.name)).toEqual(["read"])
    }),
  )

  it.effect("advertises contract-scoped tools only while the current prompt carries the marker", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        read: make(),
        scheduled_job_result: contractTool(),
      })

      const scheduledTurn = yield* names(service, {
        lastUserText: `${MARKER}\nImmediately before your terminal response, call scheduled_job_result exactly once.\n\nDo the work.`,
      })
      expect(scheduledTurn).toEqual(["read", "scheduled_job_result"])

      // The completion policy searches the whole user message, so the marker
      // may legitimately appear anywhere in the current prompt.
      const markerLater = yield* names(service, {
        lastUserText: `Arbeitsauftrag mit Vertrag\n\n${MARKER}`,
      })
      expect(markerLater).toEqual(["read", "scheduled_job_result"])
    }),
  )

  it.effect("settles stray contract-tool calls as unknown but accepts them during scheduled turns", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ scheduled_job_result: contractTool() })
      const call = {
        ...identity,
        sessionID,
        call: {
          type: "tool-call" as const,
          id: "call_contract",
          name: "scheduled_job_result",
          input: { text: MARKER },
        },
      }

      const stray = yield* service
        .materialize(undefined, undefined, context("Normaler Chat"))
        .pipe(Effect.flatMap((materialized) => materialized.settle(call)))
      expect(stray.result.type).toBe("error")
      expect(stray.result.type === "error" && stray.result.value).toBe("Unknown tool: scheduled_job_result")

      const scheduled = yield* service
        .materialize(undefined, undefined, context(MARKER))
        .pipe(Effect.flatMap((materialized) => materialized.settle(call)))
      expect(scheduled.result.type).not.toBe("error")
    }),
  )

  it.effect("keeps the marker gate active for explicit agent policies", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ scheduled_job_result: contractTool() })
      const policy = {
        mode: "explicit" as const,
        entries: { scheduled_job_result: { visible: true, permission: "allow" as const } },
      }

      const restricted = yield* service.materialize([], policy)
      expect(restricted.definitions.map((tool) => tool.name)).toEqual([])

      const withMarker = yield* service.materialize([], policy, {
        ...identity,
        sessionID,
        lastUserText: `${MARKER}\nRun the scheduled job.`,
      })
      expect(withMarker.definitions.map((tool) => tool.name)).toEqual(["scheduled_job_result"])
    }),
  )

  it.effect("keeps contract visibility decisions out of the materialization cache", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ scheduled_job_result: contractTool() })

      expect(yield* names(service, { lastUserText: MARKER })).toEqual(["scheduled_job_result"])
      expect(yield* names(service, { lastUserText: "Kaffee holen" })).toEqual([])
      expect(yield* names(service, { lastUserText: MARKER })).toEqual(["scheduled_job_result"])
      expect(yield* names(service)).toEqual([])
    }),
  )

  cached.effect("keeps cached materializations independent per marker state", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ scheduled_job_result: contractTool() })

      expect(yield* names(service, { lastUserText: `vorher ${MARKER} nachher` })).toEqual(["scheduled_job_result"])
      expect(yield* names(service, { lastUserText: "ohne Marker" })).toEqual([])
      expect(yield* names(service, { lastUserText: `vorher ${MARKER} nachher` })).toEqual(["scheduled_job_result"])
    }),
  )

  it.effect("hides contract-scoped tools from the turn-less tool catalog", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: make(), scheduled_job_result: contractTool() })
      const entries = yield* service.catalog()
      expect(entries.map((entry) => entry.id)).toEqual(["read"])
    }),
  )

  it.effect("keeps the contract marker decoration isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const shared = make()
      yield* service.register({
        unmarked: Tool.withAlwaysVisible(shared),
        marked: Tool.withContractMarker(Tool.withAlwaysVisible(shared), MARKER),
      })

      expect(yield* names(service)).toEqual(["unmarked"])
      expect(yield* names(service, { lastUserText: `x ${MARKER} x` })).toEqual(["unmarked", "marked"])
    }),
  )
})
