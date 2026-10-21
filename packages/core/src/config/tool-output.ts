export * as ConfigToolOutput from "./tool-output"

import { Schema } from "effect"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ToolOutput")({
  unlimited: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Keep complete tool output in the local workflow instead of applying host preview thresholds.",
  }),
  max_lines: PositiveInt.pipe(Schema.optional),
  max_bytes: PositiveInt.pipe(Schema.optional),
}) {}
