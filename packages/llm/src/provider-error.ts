import { Schema } from "effect"
import { LLMError, ProviderErrorEvent } from "./schema"

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) ||
  termsAppearInOrder(message, ["input token count", "exceeds the maximum"]) ||
  termsAppearInOrder(message, ["input length", "exceeds", "context length"]) ||
  /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

// Provider errors can echo very large requests. Ordered literal scans preserve the
// permissive wording without the catastrophic backtracking of chained `.*` patterns.
function termsAppearInOrder(message: string, terms: string[]) {
  const normalized = message.toLowerCase()
  return terms.reduce((offset, term) => {
    if (offset < 0) return -1
    const index = normalized.indexOf(term, offset)
    return index < 0 ? -1 : index + term.length
  }, 0) >= 0
}

export const isContextOverflowFailure = (failure: unknown) =>
  failure instanceof LLMError
    ? failure.reason._tag === "InvalidRequest" && failure.reason.classification === "context-overflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"
