import { ConfigProvider, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { parse } from "./assertions"
import { runtime, type Runtime } from "./runtime"
import type { ActiveScenario, BackendApp, CallResult, CaptureMode, SeededContext } from "./types"

type CallOptions = {
  auth?: {
    password?: string
    username?: string
  }
}

export function call(scenario: ActiveScenario, ctx: SeededContext<unknown>, options: CallOptions = {}) {
  return Effect.promise(async () =>
    capture(await app(await runtime(), options).request(toRequest(scenario, ctx)), scenario.capture),
  )
}

export function callAuthProbe(scenario: ActiveScenario, credentials: "missing" | "valid" = "missing") {
  return Effect.promise(async () => {
    const controller = new AbortController()
    return Promise.race([
      Promise.resolve(
        app(await runtime(), { auth: { password: "secret" } }).request(
          toAuthProbeRequest(scenario, credentials, controller.signal),
        ),
      ).then(captureAuthProbe),
      Bun.sleep(1_000).then(() => {
        controller.abort("auth probe timed out")
        return {
          status: 0,
          contentType: "",
          text: "auth probe timed out",
          body: undefined,
          timedOut: true,
        }
      }),
    ])
  })
}

export function requireValidAuthProbe(result: CallResult) {
  if (result.timedOut) throw new Error("auth probe with valid credentials timed out")
  if (result.status !== 200) throw new Error(`auth health probe expected 200, got ${result.status}`)
}

async function captureAuthProbe(response: Response): Promise<CallResult> {
  await response.body?.cancel().catch(() => undefined)
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: "",
    body: undefined,
    timedOut: false,
  }
}

type CachedApp = BackendApp & { readonly dispose: () => Promise<void> }

const appCache: Partial<Record<string, CachedApp>> = {}

export async function disposeApps() {
  const apps = Object.values(appCache)
  for (const key of Object.keys(appCache)) delete appCache[key]
  await Promise.all(apps.flatMap((app) => (app === undefined ? [] : [app.dispose()])))
}

function app(modules: Runtime, options: CallOptions) {
  const username = options.auth?.username
  const password = options.auth?.password
  const cacheKey = `${username ?? ""}:${password ?? ""}`
  if (appCache[cacheKey]) return appCache[cacheKey]

  const web = HttpRouter.toWebHandler(
    modules.HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: username }),
        ),
      ),
    ),
    { disableLogger: true, memoMap: modules.memoMap },
  )
  return (appCache[cacheKey] = {
    dispose: web.dispose,
    request(input: string | URL | Request, init?: RequestInit) {
      return web.handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        modules.HttpApiApp.context,
      )
    },
  })
}

function toRequest(scenario: ActiveScenario, ctx: SeededContext<unknown>) {
  const spec = scenario.request(ctx, ctx.state)
  return new Request(new URL(spec.path, "http://localhost"), {
    method: scenario.method,
    headers: spec.body === undefined ? spec.headers : { "content-type": "application/json", ...spec.headers },
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
  })
}

export function toAuthProbeRequest(
  scenario: Pick<ActiveScenario, "authProbe" | "method" | "path">,
  credentials: "missing" | "valid",
  signal: AbortSignal,
) {
  const spec =
    credentials === "valid"
      ? { path: "/global/health" }
      : (scenario.authProbe ?? {
          path: authProbePath(scenario.path),
          body: scenario.method === "GET" ? undefined : {},
        })
  const headers = {
    ...(spec.body === undefined ? {} : { "content-type": "application/json" }),
    ...spec.headers,
    ...(credentials === "valid" ? { authorization: basic("opencode", "secret") } : {}),
  }
  return new Request(new URL(spec.path, "http://localhost"), {
    method: credentials === "valid" ? "GET" : scenario.method,
    headers,
    body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
    signal,
  })
}

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function authProbePath(path: string) {
  return path
    .replace(/\{([^}]+)\}/g, (_match, key: string) => authProbeValue(path, key))
    .replace(/:([^/]+)/g, (_match, key: string) => authProbeValue(path, key))
    .replace(/\/\*$/, "/package.json")
}

function authProbeValue(path: string, key: string) {
  if (key === "sessionID") return "ses_auth_probe"
  if (key === "messageID") return "msg_auth_probe"
  if (key === "partID") return "prt_auth_probe"
  if (key === "permissionID") return "per_auth_probe"
  if (key === "ptyID") return "pty_auth_probe"
  if (key === "credentialID") return "cred_auth_probe"
  if (key === "attemptID") return "con_auth_probe"
  if (key === "requestID") return path.includes("/surface/") ? "que_auth_probe" : "per_auth_probe"
  if (key === "id") return path.includes("/workspace/") ? "wrk_auth_probe" : "psv_auth_probe"
  return `auth_${key}`
}

async function capture(response: Response, mode: CaptureMode): Promise<CallResult> {
  const text = mode === "stream" ? await captureStream(response) : await response.text()
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    body: parse(text),
    timedOut: false,
  }
}

async function captureStream(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const read = reader.read().then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  )
  const winner = await Promise.race([read, Bun.sleep(1_000).then(() => ({ timeout: true }))])
  if ("timeout" in winner) {
    await reader.cancel("timed out waiting for stream chunk").catch(() => undefined)
    throw new Error("timed out waiting for stream chunk")
  }
  if ("error" in winner) throw winner.error
  await reader.cancel().catch(() => undefined)
  if (winner.result.done) return ""
  return new TextDecoder().decode(winner.result.value)
}
