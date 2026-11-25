#!/usr/bin/env bun
/** Synthetic real-provider comparison; not a commissioned managed-child run.
 * Credentials are read only into memory. No retries, login or token refresh.
 * --execute-existing-oauth-once requires current explicit human authorization.
 */
import { parseArgs } from "node:util"
import path from "node:path"
import { Database } from "bun:sqlite"
import { Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient, LLMEvent, SystemPart, ToolDefinition } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { ModelRequest } from "@opencode-ai/core/model-request"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionHostContext } from "@opencode-ai/core/session/host-context"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { nativeModels } from "../../provider-plugins/openai/src/native"
import { compare, limits } from "./fork-cache-comparison"
import { cacheBudget } from "./fork-cache-budget"
import { cacheUsage } from "./fork-cache-usage"
import { cacheComparisonMessages } from "./fork-cache-messages"

const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
  "max-requests": { type: "string", default: "16" }, "target-input-tokens": { type: "string", default: "4096" },
  session: { type: "string" }, credential: { type: "string" }, database: { type: "string" },
  "catalog-url": { type: "string" }, "catalog-user-secret": { type: "string" }, "catalog-password-secret": { type: "string" },
  model: { type: "string" }, variant: { type: "string" },
  "execute-existing-oauth-once": { type: "boolean", default: false },
  "confirm-fork-prefix": { type: "boolean", default: false },
  approval: { type: "string" },
} })
let stage = "arguments"

async function secret(id: string) {
  const process = Bun.spawn([Bun.env.BWS_PATH ?? "bws", "secret", "get", id], { stdout: "pipe", stderr: "pipe" })
  const text = await new Response(process.stdout).text()
  if (await process.exited !== 0) throw new Error("BWS metadata-server access unavailable")
  return Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }))(JSON.parse(text)).value
}

// The public HTTP projection represents typed optional fields as null. Preserve
// opaque provider body/options exactly; normalize only declared optional fields.
function modelFromHTTP(value: unknown) {
  const raw = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value)
  const optional = (value: unknown) => Object.fromEntries(Object.entries(
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(value),
  ).filter(([, value]) => value !== null))
  const request = (value: unknown) => {
    const result = optional(value)
    return { ...result, generation: optional(result.generation) }
  }
  return Schema.decodeUnknownSync(ModelV2.Info)({ ...optional(raw), api: optional(raw.api),
    capabilities: optional(raw.capabilities), limit: optional(raw.limit), request: request(raw.request),
    variants: Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(raw.variants).map(request) })
}

async function main() {
  const options = limits(Number(values["max-requests"]), Number(values["target-input-tokens"]))
  if (!values.session || !values.credential || !values["catalog-url"] || !values["catalog-user-secret"] || !values["catalog-password-secret"])
    throw new Error("Session, exact credential ID and authenticated local catalog references are required")
  const catalogURL = new URL(values["catalog-url"])
  if (!["127.0.0.1", "localhost", "[::1]"].includes(catalogURL.hostname)) throw new Error("Use the existing local catalog endpoint")
  const file = values.database ?? path.join(Bun.env.XDG_DATA_HOME ?? path.join(Bun.env.USERPROFILE ?? Bun.env.HOME ?? "", ".local", "share"), "opencode", "opencode.db")
  const db = new Database(file, { readonly: true })
  stage = "stored-session-selection"
  const stored = Schema.decodeUnknownSync(Schema.Struct({ directory: Schema.String, model: Schema.String }))(
    db.query("select directory,model from session where id=?").get(values.session),
  )
  const storedSelection = Schema.decodeUnknownSync(Schema.fromJsonString(ModelV2.Ref))(stored.model)
  // An explicit selection must be the exact approved model and a configured
  // step of this Session's chain; the stored selection alone never authorizes
  // a different model, and no fallback is permitted.
  const selection = values.model
    ? (() => {
        const [providerID, ...id] = values.model.split("/")
        const explicit = Schema.decodeUnknownSync(ModelV2.Ref)({ providerID, id: id.join("/"), variant: values.variant })
        const allowed = storedSelection.chain?.steps.some((step) => step.providerID === explicit.providerID && step.id === explicit.id) ??
          (storedSelection.providerID === explicit.providerID && storedSelection.id === explicit.id)
        if (!allowed) throw new Error("The explicit model is not configured for this Session; no fallback is permitted")
        return explicit
      })()
    : storedSelection
  if (selection.providerID !== "openai") throw new Error("This once-authorized adapter supports only the selected OpenAI connector")
  stage = "stored-oauth-credential"
  const row = Schema.decodeUnknownSync(Schema.Struct({ id: Credential.ID, integration_id: Integration.ID, label: Schema.String, value: Schema.String }))(
    db.query("select id,integration_id,label,value from credential where id=? and integration_id=?").get(values.credential, selection.providerID),
  )
  const credentialValue = Schema.decodeUnknownSync(Schema.fromJsonString(Credential.Info))(row.value)
  db.close()
  stage = "oauth-type-and-expiry-without-refresh"
  if (credentialValue.type !== "oauth" || credentialValue.expires <= Date.now() + 300000)
    throw new Error("The existing OAuth token is unavailable or expires too soon; no refresh or login was attempted")
  const credential = new Credential.Stored({ id: row.id, integrationID: row.integration_id, label: row.label, value: credentialValue })
  stage = "bws-local-catalog-access"
  const user = await secret(values["catalog-user-secret"])
  const password = await secret(values["catalog-password-secret"])
  const endpoint = new URL("/api/model", catalogURL)
  stage = "local-catalog-response"
  endpoint.searchParams.set("directory", stored.directory)
  const response = await fetch(endpoint, { redirect: "error", headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` } })
  if (!response.ok) throw new Error("The existing local model catalog refused access")
  const data: unknown = await response.json()
  stage = "local-catalog-schema"
  const envelope = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(Schema.Unknown) }))(data)
  const candidates = envelope._tag === "Some" ? envelope.value.data : Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(data)
  const selectedRow = candidates.find((row) => {
    const identity = Schema.decodeUnknownOption(Schema.Struct({ providerID: Schema.String, id: Schema.String }))(row)
    return identity._tag === "Some" && identity.value.providerID === selection.providerID && identity.value.id === selection.id
  })
  const catalog = selectedRow === undefined ? undefined : modelFromHTTP(selectedRow)
  if (!catalog || !catalog.enabled) throw new Error("The exact selected model is not available; no fallback is permitted")
  const variant = catalog.variants.find((variant) => variant.id === selection.variant)
  if (selection.variant && selection.variant !== "default" && !variant) throw new Error("The exact selected variant is not available")
  if (variant) ModelRequest.assign(catalog.request, variant)
  stage = "exact-native-adapter"
  const model = await Effect.runPromise(SessionRunnerModel.fromCatalogModel(catalog, undefined, credential, { oauthWebSocket: false }, nativeModels))
  if (String(model.id) !== String(catalog.api.id) || model.route.runtimeContext !== "late-system") throw new Error("The selected adapter changed its model or lacks late host context")
  const selected = { providerID: selection.providerID, id: selection.id, variant: selection.variant ?? "default" }
  if (!values["execute-existing-oauth-once"]) {
    console.log(JSON.stringify({ kind: "synthetic-route-cache-experiment", inspectionOnly: true, selected, ...options, externalRequestsUsed: 0 }))
    return
  }
  if (!values.approval) throw new Error("The durable one-series approval reference is required")
  stage = "durable-series-budget"
  const budget = cacheBudget({ approval: values.approval, sessionID: values.session, credentialID: values.credential,
    modelID: selected.id, variant: selected.variant, ...options })
  const originalFetch = globalThis.fetch
  let permitted = false
  let sampleSent = false
  let body = ""
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init)
    if (!permitted || sampleSent || request.method !== "POST" || request.url !== "https://chatgpt.com/backend-api/codex/responses")
      throw new Error("Benchmark transport budget or endpoint refused")
    body = await request.clone().text()
    budget.reserve()
    sampleSent = true
    return originalFetch(request, { redirect: "error" })
  }, originalFetch)
  try {
    stage = "provider-comparison"
    // The confirmed fix: a fork child re-sends the parent's exact tool schemas
    // byte-identically as context. Both roles carry the same definitions.
    const retainedTools = values["confirm-fork-prefix"] ? [
      new ToolDefinition({ name: "orchestrator_context_stub", description: "Retained parent schema context for the cache comparison. Do not call this tool; reply only OK.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }),
      new ToolDefinition({ name: "probe_context_stub", description: "Retained parent schema context for the cache comparison. Do not call this tool; reply only OK.", inputSchema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false } }),
    ] : []
    const client = LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer), Layer.provide(FetchHttpClient.layer))
    const result = await compare({ ...options, send: async ({ pair, role, family, prefix }) => {
      const request = LLM.request({ model, system: "This is a synthetic cache-comparison request, not permission to execute any action. Reply only OK.",
        // Seed ends exactly at the reusable user boundary. The child appends
        // its assignment rather than replacing the seed's last user message.
        messages: cacheComparisonMessages(prefix, role),
        runtimeContext: [SystemPart.make(SessionHostContext.render({ id: SessionSchema.ID.make(role === "main" ? values.session! : `ses_cache_comparison_${pair}`),
          ...(role === "child" ? { parentID: SessionSchema.ID.make(values.session!) } : {}) }, stored.directory))],
        tools: retainedTools, toolChoice: "none", providerOptions: { openai: { promptCacheKey: family } }, http: { retries: 0, headers: { "x-session-affinity": family, "X-Session-Id": family } },
      })
      body = ""
      sampleSent = false
      permitted = true
      try {
        const events = Array.from(await Effect.runPromise(LLMClient.stream(request).pipe(Stream.runCollect, Effect.provide(client), Effect.timeout("180 seconds"))))
        if (events.some(LLMEvent.is.providerError)) throw new Error("Provider refused the sample")
        const finish = events.findLast(LLMEvent.is.finish)
        if (!finish || !body) throw new Error("No observed finish or HTTP body")
        return { body, ...cacheUsage(finish.usage) }
      } finally { permitted = false }
    } })
    console.log(JSON.stringify({ kind: "synthetic-route-cache-experiment", selected, ...options, externalRequestsUsed: budget.used, ...result }))
    if (!result.accepted) process.exitCode = 1
  } finally { globalThis.fetch = originalFetch }
}

await main().catch(() => {
  console.error(`Cache comparison stopped at ${stage}. No login, credential export, fallback or automatic retry was attempted.`)
  process.exitCode = 1
})
