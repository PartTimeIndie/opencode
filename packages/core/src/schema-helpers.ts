import { Option, Schema, SchemaGetter } from "effect"

/**
 * Optional public JSON field that can hold explicit `undefined` on the type
 * side but encodes it as an omitted key, matching legacy `JSON.stringify`.
 */
export const optionalOmitUndefined = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(schema), {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== undefined)),
    }),
  )
