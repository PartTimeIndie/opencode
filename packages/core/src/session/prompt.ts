import * as Schema from "effect/Schema"
import { AgentV2 } from "../agent"
import { ModelV2 } from "../model"
import { NonNegativeInt } from "../schema"

export class Source extends Schema.Class<Source>("Prompt.Source")({
  start: Schema.Finite,
  end: Schema.Finite,
  text: Schema.String,
}) {}

export class FileAttachment extends Schema.Class<FileAttachment>("Prompt.FileAttachment")({
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  unpack: Schema.Boolean.pipe(Schema.optional),
  source: Source.pipe(Schema.optional),
}) {
  static create(input: FileAttachment) {
    return new FileAttachment({
      uri: input.uri,
      mime: input.mime,
      name: input.name,
      description: input.description,
      unpack: input.unpack,
      source: input.source,
    })
  }
}

export class AgentAttachment extends Schema.Class<AgentAttachment>("Prompt.AgentAttachment")({
  name: Schema.String,
  source: Source.pipe(Schema.optional),
}) {}

export const OutputFormatText = Schema.Struct({
  type: Schema.Literal("text"),
}).annotate({ identifier: "Prompt.OutputFormatText" })
export type OutputFormatText = typeof OutputFormatText.Type

export const OutputFormatJsonSchema = Schema.Struct({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Any).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(Schema.optional),
}).annotate({ identifier: "Prompt.OutputFormatJsonSchema" })
export type OutputFormatJsonSchema = typeof OutputFormatJsonSchema.Type

export const OutputFormat = Schema.Union([OutputFormatText, OutputFormatJsonSchema]).annotate({
  discriminator: "type",
  identifier: "Prompt.OutputFormat",
})
export type OutputFormat = typeof OutputFormat.Type

export class Prompt extends Schema.Class<Prompt>("Prompt")({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(Schema.optional),
  agents: Schema.Array(AgentAttachment).pipe(Schema.optional),
  agent: AgentV2.ID.pipe(Schema.optional),
  model: ModelV2.Ref.pipe(Schema.optional),
  system: Schema.String.pipe(Schema.optional),
  format: OutputFormat.pipe(Schema.optional),
  subtask: Schema.Struct({
    command: Schema.String,
    description: Schema.String,
    agent: AgentV2.ID,
    // Omitted model inherits the target project's configured agent/session chain.
    model: ModelV2.Ref.pipe(Schema.optional),
    // "main" keeps the native single-use task_main_write consent mandatory.
    workspace: Schema.Literals(["mirror", "main", "readonly"]).pipe(Schema.optional),
  }).pipe(Schema.optional),
}) {
  static readonly equivalence = Schema.toEquivalence(Prompt)

  static fromUserMessage(input: Pick<Prompt, "text" | "files" | "agents">) {
    return new Prompt({
      text: input.text,
      ...(input.files === undefined ? {} : { files: input.files }),
      ...(input.agents === undefined ? {} : { agents: input.agents }),
    })
  }
}
