/** Identifies an attachment continuation for transport billing/routing only, never authorization. */
export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"

const streamError = Symbol.for("@opencode-ai/plugin/ResponseStreamError")

/** Public transport failure recognized across independently bundled plugin packages. */
export class ResponseStreamError extends Error {
  override readonly name = "ProviderResponseStreamError"
  readonly [streamError] = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }

  static override [Symbol.hasInstance](value: unknown): value is ResponseStreamError {
    return value instanceof Error && value.name === "ProviderResponseStreamError" &&
      streamError in value && value[streamError] === true && typeof value.message === "string"
  }
}
