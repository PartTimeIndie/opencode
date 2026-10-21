import { Config } from "@/config/config"
import { ConfigOptimization } from "@opencode-ai/core/config/optimization"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { invalidateAgentForInstance, markInstanceForReload } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      const instance = yield* InstanceState.context
      if (Config.requiresAgentRefresh(ctx.payload)) {
        yield* invalidateAgentForInstance(instance)
      } else if (Config.requiresInstanceReload(ctx.payload)) {
        yield* markInstanceForReload(instance, {
          directory: instance.directory,
          worktree: instance.worktree,
          project: instance.project,
        })
      }
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const optimization = Effect.fn("ConfigHttpApi.optimization")(function* () {
      const info = yield* configSvc.get()
      return ConfigOptimization.snapshot(info.optimization)
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("optimization", optimization)
  }),
)
