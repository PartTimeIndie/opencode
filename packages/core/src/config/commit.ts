export * as ConfigCommit from "./commit"

import { Schema } from "effect"
import { ModelRequest } from "../model-request"

export const DEFAULT_COMMIT_MODEL = "cursor/composer"

export const Commit = Schema.Struct({
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Model used to generate AI commit messages in provider/model format. Defaults to cursor/composer.",
  }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional model variant used for AI commit message generation",
  }),
  generation: ModelRequest.Generation.pipe(Schema.optional).annotate({
    description: "Generation options for AI commit message generation, such as temperature or maxTokens",
  }),
  options: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional).annotate({
    description: "Provider-specific model options, such as thinking or reasoning settings",
  }),
}).annotate({
  identifier: "CommitConfig",
  description: "AI commit message generation configuration for the Git Workbench auto-commit action",
})
export type Commit = typeof Commit.Type
