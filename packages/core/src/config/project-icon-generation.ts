export * as ConfigProjectIconGeneration from "./project-icon-generation"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigV2.ProjectIconGeneration")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Generate project icons for projects that currently use a letter fallback. Default: false.",
  }),
}) {}
