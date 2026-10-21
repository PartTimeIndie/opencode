import { Config } from "@/config/config"
import { HeadlessAI } from "@/headless-ai"
import { ConfigModelChain } from "@opencode-ai/core/config/model-chain"
import { Slug } from "@opencode-ai/core/util/slug"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const headlessAI = yield* HeadlessAI.Service

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const cfg = yield* config.get()
      const result = yield* headlessAI.text({
        chain: ConfigModelChain.selectedSteps({
          chains: cfg.model_chains,
          chainID: cfg.default_model_chain,
        }),
        maxRetries: 2,
        messages: [{ role: "user", content: `Generate a short 2-3 word name that describes this task:\n${text}` }],
        metadata: { kind: "project-copy-name" },
      })
      const output = result.text.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    return handlers.handle("generateName", (ctx) =>
      generateName(ctx.payload.context).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project copy name generation failed", {
            projectID: ctx.params.projectID,
            cause,
          }).pipe(Effect.as(Slug.create())),
        ),
        Effect.map((name) => ({ name })),
      ),
    )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
