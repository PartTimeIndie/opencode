import { describe, expect, test } from "bun:test"
import { compile, prepare } from "../src/structured-json-subset"

describe("structured JSON subset", () => {
  test("enforces inclusive numeric bounds used by review confidence", () => {
    const contract = prepare({ type: "number", minimum: 0, maximum: 1 })
    for (const value of [0, 0.5, 1]) expect(contract.validate(value)).toBe(true)
    for (const value of [-0.01, 1.01, "0.5", NaN, Infinity]) expect(contract.validate(value)).toBe(false)
    expect(contract.diagnose(-1)).toEqual({ path: "", expected: "number >= 0" })
    expect(contract.diagnose(2)).toEqual({ path: "", expected: "number <= 1" })
  })

  test("numeric bounds apply only to numbers and reject invalid schema limits", () => {
    const validate = compile({ minimum: 0, maximum: 1 })
    expect(validate("not a number")).toBe(true)
    expect(validate(null)).toBe(true)
    expect(validate(-1)).toBe(false)
    for (const keyword of ["minimum", "maximum"]) {
      for (const value of ["0", null, false, {}, [], Infinity, NaN])
        expect(() => compile({ [keyword]: value })).toThrow()
    }
    const impossible = compile({ type: "number", minimum: 2, maximum: 1 })
    for (const value of [0, 1, 1.5, 2, 3]) expect(impossible(value)).toBe(false)
    expect(() => compile({ exclusiveMinimum: 0 })).toThrow("Unsupported schema keyword")
  })

  test("captures the schema rather than reading mutable constraints later", () => {
    const schema = { type: "object", properties: {}, required: ["name"], additionalProperties: false }
    const validate = compile(schema)
    schema.required.length = 0
    schema.additionalProperties = true
    expect(validate({})).toBe(false)
    expect(validate({ name: "Ada" })).toBe(false)
  })

  test("rejects exponentially expanded reference graphs before validation", () => {
    const definitions: Record<string, unknown> = { leaf: { type: "string" } }
    for (let index = 0; index < 18; index++) {
      const ref = { $ref: `#/$defs/${index === 0 ? "leaf" : `level${index - 1}`}` }
      definitions[`level${index}`] = { allOf: [ref, ref] }
    }
    expect(() => compile({ $ref: "#/$defs/level17", $defs: definitions })).toThrow("complexity")
  })

  test("bounds acyclic reference depth without a JavaScript stack overflow", () => {
    const definitions: Record<string, unknown> = { leaf: { type: "string" } }
    for (let index = 0; index < 200; index++) {
      definitions[`level${index}`] = { $ref: `#/$defs/${index === 0 ? "leaf" : `level${index - 1}`}` }
    }
    expect(() => compile({ $ref: "#/$defs/level199", $defs: definitions })).toThrow("depth")
  })

  test("bounds enum compilation work and runtime validation work independently", () => {
    expect(() => compile({ enum: Array.from({ length: 1000 }, (_, index) => index) })).toThrow("complexity")
    const contract = prepare({ type: "array", items: { allOf: Array.from({ length: 100 }, () => ({ type: "string" })) } })
    expect(contract.diagnose(Array.from({ length: 1000 }, () => "valid"))).toEqual({
      path: "", expected: "validation within the supported complexity",
    })
    expect(contract.diagnose(["valid"])).toBeUndefined()
  })

  test("reports the exact key for a schema-valued additional property", () => {
    expect(prepare({ additionalProperties: { type: "number" } }).diagnose({ extra: "private" }))
      .toEqual({ path: "/extra", expected: "number" })
  })

  test("rejects an unrecognized schema dialect", () => {
    expect(() => compile({ $schema: "https://example.com/unknown", type: "string" })).toThrow()
  })

  test("validates enums with JSON equality rather than object identity or key order", () => {
    const validate = compile({ enum: [{ a: 1, b: 2 }, 0] })
    expect(validate({ b: 2, a: 1 })).toBe(true)
    expect(validate(-0)).toBe(true)
    expect(validate({ a: 1 })).toBe(false)
  })

  test("resolves local definitions and escaped pointer keys without prototype lookup", () => {
    const validate = compile({
      $defs: { "a/b~c": { type: "integer" } },
      type: "object",
      properties: { count: { $ref: "#/$defs/a~1b~0c" } },
      required: ["count"], additionalProperties: false,
    })
    expect(validate({ count: 2 })).toBe(true)
    expect(validate({ count: "2" })).toBe(false)
    expect(() => compile({ $ref: "#/constructor" })).toThrow()
    expect(() => compile({ $ref: "https://example.com/schema" })).toThrow()
  })

  test("rejects recursive references and unsupported rules even in unused definitions", () => {
    expect(() => compile({ $ref: "#" })).toThrow()
    expect(() => compile({ type: "object", $defs: { unused: { not: {} } } })).toThrow()
  })

  test("checks object keys such as __proto__ as ordinary own properties", () => {
    const validate = compile(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}'))
    expect(validate(JSON.parse('{"__proto__":"safe"}'))).toBe(true)
    expect(validate(JSON.parse('{"__proto__":12}'))).toBe(false)
    expect(validate({ constructor: "unexpected" })).toBe(false)
  })

  test("allows nullable types and applies object rules only to objects", () => {
    const validate = compile({ type: ["object", "null"], required: ["answer"] })
    expect(validate(null)).toBe(true)
    expect(validate({})).toBe(false)
    expect(validate({ answer: 1 })).toBe(true)
    expect(validate("answer")).toBe(false)
  })

  test("enforces anyOf and schema-valued additional properties", () => {
    const validate = compile({ type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] } })
    expect(validate({ a: "value", b: null })).toBe(true)
    expect(validate({ a: 1 })).toBe(false)
  })

  test("rejects non-JSON values, sparse arrays, cycles and custom prototypes", () => {
    const validate = compile({})
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [undefined, NaN, Infinity, new Date(), new Map(), { a: undefined }, Array(1), cycle])
      expect(validate(value)).toBe(false)
  })

  test("rejects schemas with cycles instead of overflowing the stack", () => {
    const schema: Record<string, unknown> = { type: "array" }
    schema.items = schema
    expect(() => compile(schema)).toThrow()
  })

  test("keeps annotations inert and does not alter frozen schemas", () => {
    const schema = Object.freeze({ type: "string", description: "answer", default: "not inserted" })
    const validate = compile(schema)
    expect(validate(undefined)).toBe(false)
    expect(validate("answer")).toBe(true)
    expect(schema).toEqual({ type: "string", description: "answer", default: "not inserted" })
  })

  test("reports a bounded schema path and expectation without dumping result values", () => {
    const contract = prepare({ type: "object", properties: { findings: { type: "array", items: { type: "string" } } } })
    expect(contract.diagnose({ findings: "private response text" })).toEqual({ path: "/findings", expected: "array" })
    expect(contract.diagnose({ findings: [123] })).toEqual({ path: "/findings/0", expected: "string" })
    expect(contract.diagnose({ findings: ["valid"] })).toBeUndefined()
  })
})
