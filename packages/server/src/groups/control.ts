import { ControlConfig } from "@opencode-ai/core/control-config"
import { ControlLive } from "@opencode-ai/core/control-live"
import { Location } from "@opencode-ai/core/location"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationMiddleware, LocationQuery, locationQueryOpenApi } from "./location"

export const ControlGroup = HttpApiGroup.make("server.control")
  .add(
    HttpApiEndpoint.post("control.config.apply", "/api/control/config/apply", {
      query: LocationQuery,
      payload: ControlConfig.ApplyInput,
      success: Location.response(ControlConfig.ApplyOutput),
      error: [ControlConfig.UnsupportedFormatError, ControlConfig.InvalidPathError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.control.config.apply",
          summary: "Apply a Control Panel config value",
          description: "Write a config-backed Control Panel value to a project-relative JSON/JSONC config file.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("control.live.publish", "/api/control/live/publish", {
      query: LocationQuery,
      payload: ControlLive.PublishInput,
      success: Location.response(ControlLive.PublishOutput),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.control.live.publish",
          summary: "Publish a Control Panel live update",
          description: "Publish a runtime Control Panel update to the location event stream.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "controls", description: "Control Panel config and live tweak routes." }))
  .middleware(LocationMiddleware)
