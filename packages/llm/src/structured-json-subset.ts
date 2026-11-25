// A deliberately bounded JSON Schema subset. Unknown semantics fail before HTTP;
// provider projections and best-effort schema conversion are not validators.
export * as StructuredJsonSubset from "./structured-json-subset"

export function compile(schema: unknown): (value: unknown) => boolean {
  return prepare(schema).validate
}

export function prepare<T>(schema: T) {
  if (!jsonValue(schema)) throw new Error("Schema must contain only JSON values")
  const snapshot = structuredClone(schema)
  freeze(snapshot)
  const check = compileNode(snapshot, { root: snapshot, active: new Set(), remaining: 10_000 })
  const diagnose = (value: unknown): Issue | undefined => {
    if (!jsonValue(value)) return { path: "", expected: "JSON value within the supported depth" }
    const issues: Issue[] = []
    const budget = { remaining: 100_000 }
    check(value, "", (issue) => issues.push(issue), budget)
    if (budget.remaining < 0) return { path: "", expected: "validation within the supported complexity" }
    return issues[0]
  }
  return { schema: snapshot, validate: (value: unknown) => diagnose(value) === undefined, diagnose }
}

export type Issue = { readonly path: string; readonly expected: string }
type Budget = { remaining: number }
type Check = (value: unknown, path: string, report: ((issue: Issue) => void) | undefined, budget: Budget) => boolean
type Compilation = { root: unknown; active: Set<unknown>; remaining: number }
const keywords = new Set([
  "type", "title", "description", "$comment", "default", "examples", "$schema",
  "$defs", "definitions", "$ref", "enum", "const", "anyOf", "allOf", "oneOf",
  "properties", "required", "additionalProperties", "items", "minimum", "maximum",
])
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
const dialects = new Set([
  "http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft-07/schema#",
  "https://json-schema.org/draft/2020-12/schema",
])

function compileNode(schema: unknown, context: Compilation): Check {
  if (--context.remaining < 0) throw new Error("Schema exceeds the supported compilation complexity")
  if (context.active.size > 128) throw new Error("Schema exceeds the supported reference depth")
  if (typeof schema === "boolean") return test(() => schema, "permitted value")
  if (!record(schema)) throw new Error("Schema must be an object or boolean")
  if (context.active.has(schema)) throw new Error("Recursive schema references are unsupported")
  // Count expanded references, not just distinct nodes: a tiny shared graph can
  // otherwise compile cheaply but require exponentially many validation calls.
  context.active.add(schema)
  const unknown = Object.keys(schema).find((key) => !keywords.has(key))
  if (unknown) throw new Error(`Unsupported schema keyword: ${unknown}`)
  if (schema.$schema !== undefined && (typeof schema.$schema !== "string" || !dialects.has(schema.$schema)))
    throw new Error("Unsupported schema dialect")
  for (const key of ["title", "description", "$comment"]) {
    if (schema[key] !== undefined && typeof schema[key] !== "string") throw new Error(`Invalid ${key}`)
  }
  if (schema.examples !== undefined && !Array.isArray(schema.examples)) throw new Error("Invalid examples")
  const checks: Check[] = []
  if (schema.$ref !== undefined) {
    if (Object.keys(schema).some((key) => !["$ref", "$defs", "definitions", "$schema", "title", "description", "$comment"].includes(key)))
      throw new Error("Validation siblings of $ref are unsupported")
    checks.push(compileNode(resolveRef(context.root, schema.$ref), context))
  }
  for (const key of ["$defs", "definitions"]) {
    if (schema[key] === undefined) continue
    if (!record(schema[key])) throw new Error(`Invalid ${key}`)
    // Validate unused definitions too: no hidden unsupported constraints.
    for (const definition of Object.values(schema[key])) compileNode(definition, context)
  }
  if (schema.type !== undefined) {
    const list = typeof schema.type === "string" ? [schema.type] : schema.type
    if (!Array.isArray(list) || list.length === 0 || list.some((type) => typeof type !== "string" || !types.has(type))
      || new Set(list).size !== list.length) throw new Error("Unsupported schema type")
    checks.push(test((value) => list.some((type) => matchesType(value, type)), list.join(" or ")))
  }
  for (const key of ["minimum", "maximum"] as const) {
    const limit = schema[key]
    if (limit === undefined) continue
    if (typeof limit !== "number" || !Number.isFinite(limit)) throw new Error(`Invalid ${key}`)
    checks.push(test((value) => typeof value !== "number"
      || (key === "minimum" ? value >= limit : value <= limit), `number ${key === "minimum" ? ">=" : "<="} ${limit}`))
  }
  if (schema.enum !== undefined) {
    const values = schema.enum
    if (!Array.isArray(values) || values.length === 0
      || values.some((value, index) => values.slice(0, index).some((other) => {
        const equal = sameJson(value, other, context)
        if (context.remaining < 0) throw new Error("Schema exceeds the supported compilation complexity")
        return equal
      })))
      throw new Error("Invalid enum")
    if (context.remaining < 0) throw new Error("Schema exceeds the supported compilation complexity")
    checks.push(test((value, budget) => values.some((item) => sameJson(value, item, budget)), "one allowed enum value"))
  }
  if (Object.hasOwn(schema, "const")) {
    const constant = schema.const
    checks.push(test((value, budget) => sameJson(value, constant, budget), "the specified constant"))
  }
  for (const key of ["anyOf", "allOf", "oneOf"]) {
    const branches = schema[key]
    if (branches === undefined) continue
    if (!Array.isArray(branches) || branches.length === 0) throw new Error(`Invalid ${key}`)
    const alternatives = branches.map((branch) => compileNode(branch, context))
    checks.push(key === "allOf"
      ? (value, path, report, budget) => alternatives.every((check) => check(value, path, report, budget))
      : test((value, budget) => key === "anyOf" ? alternatives.some((check) => check(value, "", undefined, budget))
        : alternatives.filter((check) => check(value, "", undefined, budget)).length === 1, `matching ${key} alternative`))
  }
  if (schema.properties !== undefined && !record(schema.properties)) throw new Error("Invalid properties")
  const properties = new Map(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, compileNode(value, context)]))
  const required = schema.required === undefined ? [] : schema.required
  if (!Array.isArray(required) || required.some((item) => typeof item !== "string")
    || new Set(required).size !== required.length) throw new Error("Invalid required")
  const additional = compileNode(schema.additionalProperties === undefined ? true : schema.additionalProperties, context)
  checks.push((value, path, report, budget) => {
    if (!record(value)) return true
    const missing = required.find((key) => !Object.hasOwn(value, key))
    if (missing !== undefined) {
      report?.({ path: pointer(path, missing), expected: "required property" })
      return false
    }
    return Object.entries(value).every(([key, item]) => {
      const property = properties.get(key)
      return (property ?? additional)(item, pointer(path, key), report, budget)
    })
  })
  if (schema.items !== undefined) {
    const items = compileNode(schema.items, context)
    checks.push((value, path, report, budget) => !Array.isArray(value)
      || value.every((item, index) => items(item, pointer(path, String(index)), report, budget)))
  }
  context.active.delete(schema)
  const check: Check = (value, path, report, budget) => --budget.remaining >= 0
    && checks.every((check) => check(value, path, report, budget))
  return check
}

function test(predicate: (value: unknown, budget: Budget) => boolean, expected: string): Check {
  return (value, path, report, budget) => {
    if (--budget.remaining >= 0 && predicate(value, budget)) return true
    report?.({ path, expected })
    return false
  }
}

function pointer(path: string, key: string) {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`.slice(0, 256)
}

function resolveRef(root: unknown, ref: unknown): unknown {
  if (ref === "#") return root
  if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("Only local JSON pointer references are supported")
  return ref.slice(2).split("/").reduce<unknown>((node, token) => {
    if (/~(?:[^01]|$)/.test(token) || token.includes("%")) throw new Error("Unsupported reference encoding")
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!record(node) || !Object.hasOwn(node, key)) throw new Error("Unresolved schema reference")
    return node[key]
  }, root)
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "null") return value === null
  if (type === "object") return record(value)
  if (type === "array") return Array.isArray(value)
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  return typeof value === type
}

function sameJson(left: unknown, right: unknown, budget: Budget): boolean {
  if (--budget.remaining < 0) return false
  if (left === right) return true
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length
    && left.every((item, index) => sameJson(item, right[index], budget))
  return record(left) && record(right) && Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => Object.hasOwn(right, key) && sameJson(value, right[key], budget))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return
  Object.values(value).forEach(freeze)
  Object.freeze(value)
}

function jsonValue(value: unknown, active = new Set<unknown>(), depth = 0, budget = { remaining: 100_000 }): boolean {
  if (--budget.remaining < 0) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (depth > 128 || (!Array.isArray(value) && !record(value)) || active.has(value)) return false
  active.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(value)
  const valid = (Array.isArray(value) ? keys.length === value.length + 1 : true)
    && keys.every((key) => {
      if (Array.isArray(value) && key === "length") return true
      if (typeof key !== "string") return false
      if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false
      const descriptor = descriptors[key]
      return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
        && jsonValue(descriptor.value, active, depth + 1, budget)
    })
  active.delete(value)
  return valid
}
