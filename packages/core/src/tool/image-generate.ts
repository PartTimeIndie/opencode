export * as ImageGenerateTool from "./image-generate"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { ImageGeneration } from "../image-generation"
import { PermissionV2 } from "../permission"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "image_generate"

export const Input = Schema.Struct({
  prompt: Schema.String.annotate({ description: "Curated visual brief for the image to generate" }),
  size: Schema.Literals(ImageGeneration.sizes).pipe(Schema.optional).annotate({ description: "Requested image size" }),
  style: Schema.String.pipe(Schema.optional).annotate({ description: "Optional visual style guidance" }),
  format: Schema.Literals(ImageGeneration.formats).pipe(Schema.optional).annotate({ description: "Output image format" }),
  model: Schema.String.pipe(Schema.optional).annotate({ description: "Optional Codex model override" }),
  timeoutSeconds: Schema.Number.pipe(Schema.optional).annotate({ description: "Timeout in seconds, from 30 to 900" }),
})

export const Output = Schema.Struct({
  mime: Schema.String,
  data: Schema.String,
  filename: Schema.String,
  bytes: Schema.Number,
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const images = yield* ImageGeneration.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: "Generate one raster image through the local Codex image-generation capability and return it inline.",
          input: Input,
          output: Output,
          validateInput: (input) => {
            if (!input || typeof input !== "object") return
            const timeout = "timeoutSeconds" in input ? input.timeoutSeconds : undefined
            if (timeout !== undefined && (typeof timeout !== "number" || timeout < 30 || timeout > 900))
              return "timeoutSeconds must be between 30 and 900"
          },
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["codex-image-generation"],
                save: ["*"],
                metadata: { prompt: input.prompt, size: input.size, format: input.format },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const result = yield* images.generate(input)
              return {
                mime: result.mime,
                data: Buffer.from(result.data).toString("base64"),
                filename: result.filename,
                bytes: result.data.byteLength,
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
          toModelOutput: ({ output }) => [
            { type: "text", text: `Generated ${output.filename} (${output.bytes} bytes).` },
            { type: "file", data: output.data, mime: output.mime, name: output.filename },
          ],
        }),
      })
      .pipe(Effect.orDie)
  }),
)
