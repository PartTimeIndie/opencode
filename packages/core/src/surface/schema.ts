export * as SurfaceSchema from "./schema"

import { Schema } from "effect"
import { optionalOmitUndefined } from "../schema-helpers"
import type { SessionFailureCard } from "../session/failure-card"

/**
 * Unified surface contract (U1): plugins and hosts describe data, one renderer
 * renders it. Arbitrary plugin HTML/JS is not expressible.
 */
export const Kind = Schema.Literals(["blocking-question", "interactive-control", "passive-info", "error-card"])
export type Kind = typeof Kind.Type

export const HostComponent = Schema.Literals([
  "text",
  "markdown",
  "image",
  "media",
  "code",
  "diff",
  "table",
  "accordion",
  "tabs",
  "object_tree",
  "error_card",
])
export type HostComponent = typeof HostComponent.Type

export const Widget = Schema.Struct({
  type: HostComponent,
  props: Schema.Record(Schema.String, Schema.Unknown).pipe(optionalOmitUndefined),
})
export type Widget = typeof Widget.Type

export const Surface = Schema.Struct({
  id: Schema.String,
  kind: Kind,
  title: Schema.String.pipe(optionalOmitUndefined),
  body: Schema.Array(Widget),
  blocking: Schema.Boolean.pipe(optionalOmitUndefined),
})
export type Surface = typeof Surface.Type

export function errorCard(id: string, card: SessionFailureCard.Card): Surface {
  return {
    id,
    kind: "error-card",
    blocking: false,
    body: [{ type: "error_card", props: { ...card } }],
  }
}
