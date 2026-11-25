import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CapabilityLease } from "@opencode-ai/core/capability/lease"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffectShared(Layer.mergeAll(httpApiLayer, LocationServiceMap.layer))
const browserIDs = ["browser_click", "browser_navigate", "browser_snapshot", "browser_type", "browser_wait"]

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("tool configuration HTTP catalog", () => {
  it.instance(
    "lists inactive Browser tools and schemas in both Settings endpoints without granting access",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const { BrowserTool } = yield* Effect.promise(() => import("@opencode-ai/core/tool/browser"))
        const locations = yield* LocationServiceMap
        const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(tmp.directory) }))
        const context = { sessionID: SessionV2.ID.make("ses_http_catalog"), agent: AgentV2.ID.make("plan") }
        let actions = 0
        const bridge = BrowserTool.bridgeLayer({
          action: async () => {
            actions++
            throw new Error("Configuration discovery must never call the Browser bridge")
          },
        })
        yield* Effect.gen(function* () {
          yield* Layer.build(BrowserTool.layer.pipe(Layer.provide(bridge)))
          const registry = yield* ToolRegistry.Service
          const leases = yield* CapabilityLease.Service
          const response = yield* requestInDirectory(ExperimentalPaths.tool, tmp.directory)
          expect(response.status).toBe(200)
          const catalog = (yield* response.json) as Array<{ id: string; parameters: unknown; visible: boolean }>
          expect(
            catalog
              .filter((item) => item.id.startsWith("browser_"))
              .map((item) => item.id)
              .sort(),
          ).toEqual(browserIDs)
          for (const id of browserIDs) {
            expect(catalog.find((item) => item.id === id)).toMatchObject({
              parameters: { type: "object" },
              visible: true,
            })
          }
          const idsResponse = yield* requestInDirectory(ExperimentalPaths.toolIDs, tmp.directory)
          expect(idsResponse.status).toBe(200)
          const ids = (yield* idsResponse.json) as string[]
          expect(ids.filter((id) => id.startsWith("browser_")).sort()).toEqual(browserIDs)
          expect(yield* leases.snapshot(context.sessionID, context.agent)).toEqual({})
          const runtime = yield* registry.materialize(
            undefined,
            {
              mode: "explicit",
              entries: Object.fromEntries(browserIDs.map((id) => [id, { visible: true, permission: "allow" }])),
            },
            context,
          )
          expect(runtime.definitions.some((item) => item.name.startsWith("browser_"))).toBe(false)
          expect(actions).toBe(0)
        }).pipe(Effect.provide(location))
      }),
    { config: { formatter: false, lsp: false } },
    30_000,
  )
})
