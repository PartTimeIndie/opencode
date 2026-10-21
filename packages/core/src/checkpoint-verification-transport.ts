export * as CheckpointVerificationTransport from "./checkpoint-verification-transport"

import { deserialize, serialize } from "node:v8"

export function encode(value: unknown) {
  return serialize(value)
}

export function decode<T>(value: Uint8Array) {
  return deserialize(value) as T
}
