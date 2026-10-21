export * as ConfigVision from "./vision"

import { Schema } from "effect"

/**
 * Default analysis prompt template used when `prompt_template` is not configured.
 * Supports {{user_message}} (the user's message text) and {{image_name}} (the attachment name).
 */
export const DEFAULT_PROMPT_TEMPLATE = `The user attached an image and asked the following question:
"{{user_message}}"

Analyze this image in the context of the user's question. Provide a detailed, factual description covering all relevant visual details (text content, UI elements, layout, colors, data, diagrams, errors, or any other observable content) that would help answer the user's question.`

class ModelRef extends Schema.Class<ModelRef>("ConfigV2.Vision.ModelRef")({
  model: Schema.String.annotate({
    description: "Vision model in provider/model format (e.g. openai/gpt-4o)",
  }),
  variant: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional model variant or thinking amount.",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Vision")({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Enable automatic vision delegation for models without image support. Default: false.",
  }),
  primary: ModelRef.pipe(Schema.optional).annotate({
    description: "Primary vision model for image analysis delegation.",
  }),
  fallbacks: Schema.Array(ModelRef).pipe(Schema.optional).annotate({
    description:
      "Ordered fallback vision models tried when the primary model is rate-limited or unavailable.",
  }),
  prompt_template: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Analysis prompt template. Supports {{user_message}} and {{image_name}} variables.",
  }),
}) {}
