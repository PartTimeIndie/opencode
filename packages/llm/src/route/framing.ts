import type { Stream } from "effect"
import * as ProviderShared from "../protocols/shared"
import type { LLMError } from "../schema"

/**
 * Decode a streaming HTTP response body into provider-protocol frames.
 *
 * `Framing` is the byte-stream-shaped seam between transport and protocol:
 *
 * - SSE (`Framing.sse`) — UTF-8 decode the body, run the SSE channel decoder,
 *   drop empty / `[DONE]` events. `Framing.sseWithDone` preserves the explicit
 *   OpenAI-compatible completion marker. Each emitted frame is one `data:`
 *   payload.
 * - AWS event stream — length-prefixed binary frames with CRC checksums.
 *   Each emitted frame is one parsed binary event record.
 *
 * The frame type is opaque to this layer; the protocol's `decode` step turns
 * a frame into a typed chunk.
 */
export interface Framing<Frame> {
  readonly id: string
  readonly frame: (bytes: Stream.Stream<Uint8Array, LLMError>) => Stream.Stream<Frame, LLMError>
}

/** Server-Sent Events framing. Used by every JSON-streaming HTTP provider. */
export const sse: Framing<string> = { id: "sse", frame: ProviderShared.sseFraming }

/** SSE framing that preserves OpenAI-compatible `[DONE]` completion markers. */
export const sseWithDone: Framing<string> = { id: "sse-with-done", frame: ProviderShared.sseFramingWithDone }

export * as Framing from "./framing"
