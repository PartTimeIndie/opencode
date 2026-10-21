export * as ConfigDAP from "./dap"

import { Schema } from "effect"

export class Adapter extends Schema.Class<Adapter>("ConfigV2.DAP.Adapter")({
  command: Schema.NonEmptyArray(Schema.String),
  env: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.DAP")({
  adapters: Schema.Record(Schema.String, Adapter),
}) {}
