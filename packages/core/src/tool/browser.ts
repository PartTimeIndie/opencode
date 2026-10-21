export * as BrowserTool from "./browser"

import path from "node:path"
import { readFile } from "node:fs/promises"
import { ToolFailure } from "@opencode-ai/llm"
import { Context, Effect, Layer, Schema } from "effect"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const MAX_TIMEOUT_MS = 30_000
export const MAX_TEXT_CHARS = 20_000
export const MAX_ELEMENTS = 150
const MAX_INPUT_CHARS = 100_000
const MAX_SELECTOR_CHARS = 2_000

type Action = Readonly<Record<string, unknown>> & { readonly type: string }

export interface Bridge {
  readonly action: (action: Action) => Promise<unknown>
  readonly available: boolean
}

export class BridgeService extends Context.Service<BridgeService, Bridge>()("@opencode/BrowserTool/Bridge") {}

export const bridgeLayer = (bridge: Omit<Bridge, "available"> & { readonly available?: boolean }) =>
  Layer.succeed(BridgeService, { ...bridge, available: bridge.available ?? true })
export const defaultBridgeLayer = Layer.succeed(BridgeService, {
  action: callDesktopBridge,
  available: isDesktopAvailable(),
})

export function isDesktopAvailable(env: Readonly<Record<string, string | undefined>> = process.env) {
  return env.OPENCODE_CLIENT === "desktop" && Boolean(env.OPENCODE_DESKTOP_BRIDGE_FILE)
}

const Timeout = PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)).pipe(Schema.optional)
const Selector = Schema.String.check(Schema.isMaxLength(MAX_SELECTOR_CHARS)).pipe(Schema.optional)
const Ref = Schema.String.check(Schema.isPattern(/^e\d+$/)).pipe(Schema.optional)

export const SnapshotInput = Schema.Struct({
  screenshot: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Include a compressed JPEG screenshot attachment. Defaults to false.",
  }),
  maxTextChars: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TEXT_CHARS)).pipe(Schema.optional),
  maxElements: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_ELEMENTS)).pipe(Schema.optional),
})

const Evidence = Schema.Struct({
  console: Schema.Array(Schema.String),
  network: Schema.Array(Schema.String),
})

const Element = Schema.Struct({
  ref: Schema.String,
  tag: Schema.String,
  role: Schema.String,
  name: Schema.String,
  type: Schema.String,
  value: Schema.String,
  disabled: Schema.Boolean,
})

export const SnapshotOutput = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  text: Schema.String,
  accessibility: Schema.String,
  elements: Schema.Array(Element),
  evidence: Evidence,
  screenshotBase64: Schema.String.pipe(Schema.optional),
})

export const ClickInput = Schema.Struct({
  ref: Ref,
  selector: Selector,
  button: Schema.Literals(["left", "right", "middle"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("left" as const)),
  ),
  timeout: Timeout,
})

export const TypeInput = Schema.Struct({
  ref: Ref,
  selector: Selector,
  text: Schema.String.check(Schema.isMaxLength(MAX_INPUT_CHARS)),
  clear: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  pressEnter: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout,
})

export const NavigateInput = Schema.Struct({
  url: Schema.String,
  newTab: Schema.Boolean.pipe(Schema.optional),
  timeout: Timeout,
})

export const WaitInput = Schema.Struct({
  ref: Ref,
  selector: Selector,
  text: Schema.String.check(Schema.isMaxLength(MAX_SELECTOR_CHARS)).pipe(Schema.optional),
  state: Schema.Literals(["visible", "hidden", "attached", "detached"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("visible" as const)),
  ),
  milliseconds: PositiveInt.check(Schema.isLessThanOrEqualTo(5_000)).pipe(Schema.optional),
  timeout: Timeout,
})

export const PageOutput = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
})

export const WaitOutput = Schema.Struct({
  url: Schema.String,
  waited: Schema.String,
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const bridge = yield* BridgeService
    if (!bridge.available) return

    const authorize = (
      permissionAction: "browser_read" | "browser_write",
      input: Action,
      origin: string,
      context: Tool.Context,
    ) =>
      permission.assert({
        action: permissionAction,
        resources: [origin],
        save: [origin],
        metadata: permissionMetadata(input),
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })

    const invoke = <A, I>(
      schema: Schema.Codec<A, I>,
      permissionAction: "browser_read" | "browser_write",
      action: Action,
      context: Tool.Context,
    ) =>
      bridgeCall(bridge, { type: "browser.status" }).pipe(
        Effect.flatMap((status) => currentOrigin(status)),
        Effect.flatMap((origin) =>
          authorize(permissionAction, action, origin, context).pipe(
            Effect.andThen(bridgeCall(bridge, { ...action, expectedOrigin: origin })),
          ),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(toToolFailure),
      )

    yield* tools
      .register({
        browser_snapshot: Tool.withCapabilities(Tool.withPermission(
          Tool.make({
            description:
              "Inspect the active integrated Browser Dock page. Returns bounded visible text, an accessibility snapshot, stable element refs, and recent console/network failures. Optionally attaches a compressed screenshot.",
            input: SnapshotInput,
            output: SnapshotOutput,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: formatSnapshot(output),
              },
              ...(output.screenshotBase64
                ? [{ type: "file" as const, data: output.screenshotBase64, mime: "image/jpeg", name: "browser.jpg" }]
                : []),
            ],
            execute: (input, context) =>
              invoke(
                SnapshotOutput,
                "browser_read",
                {
                  type: "browser.snapshot",
                  screenshot: input.screenshot ?? false,
                  maxTextChars: input.maxTextChars ?? MAX_TEXT_CHARS,
                  maxElements: input.maxElements ?? MAX_ELEMENTS,
                },
                context,
              ),
          }),
          "browser_read",
        ), ["browser_read"]),
        browser_click: Tool.withCapabilities(Tool.withPermission(
          Tool.make({
            description:
              "Click an element in the active integrated Browser Dock page by a browser_snapshot ref or a bounded CSS selector.",
            input: ClickInput,
            output: PageOutput,
            toModelOutput: ({ output }) => [
              { type: "text", text: `Clicked element on ${output.url} (${output.title}).` },
            ],
            validateInput: validateTarget,
            execute: (input, context) =>
              invoke(
                PageOutput,
                "browser_write",
                { type: "browser.click", ...input, timeout: input.timeout ?? 10_000 },
                context,
              ),
          }),
          "browser_write",
        ), ["browser_write"]),
        browser_type: Tool.withCapabilities(Tool.withPermission(
          Tool.make({
            description:
              "Fill or type text into an element in the active integrated Browser Dock page by a browser_snapshot ref or CSS selector.",
            input: TypeInput,
            output: PageOutput,
            toModelOutput: ({ output }) => [{ type: "text", text: `Entered text on ${output.url} (${output.title}).` }],
            validateInput: validateTarget,
            execute: (input, context) =>
              invoke(
                PageOutput,
                "browser_write",
                { type: "browser.type", ...input, timeout: input.timeout ?? 10_000 },
                context,
              ),
          }),
          "browser_write",
        ), ["browser_write"]),
        browser_navigate: Tool.withCapabilities(Tool.withPermission(
          Tool.make({
            description:
              "Navigate the active integrated Browser Dock tab to an HTTP(S) URL, or open the URL in a new Browser Dock sub-tab.",
            input: NavigateInput,
            output: PageOutput,
            toModelOutput: ({ output }) => [
              { type: "text", text: `Browser Dock navigated to ${output.url} (${output.title}).` },
            ],
            validateInput: (input) =>
              isRecord(input) && typeof input.url === "string" && isHttpUrl(input.url)
                ? undefined
                : "url must use http:// or https://",
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* authorize(
                  "browser_write",
                  { type: input.newTab ? "browser.open" : "browser.navigate", url: input.url },
                  originOf(input.url),
                  context,
                ).pipe(Effect.mapError((error) => new ToolFailure({ message: describe(error) })))
                yield* bridgeCall(bridge, {
                  type: input.newTab ? "browser.open" : "browser.navigate",
                  url: input.url,
                  expectedOrigin: originOf(input.url),
                })
                return yield* bridgeCall(bridge, {
                  type: "browser.wait",
                  state: "visible",
                  timeout: input.timeout ?? 15_000,
                  expectedOrigin: originOf(input.url),
                }).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(PageOutput)),
                  Effect.mapError(toToolFailure),
                )
              }),
          }),
          "browser_write",
        ), ["browser_write"]),
        browser_wait: Tool.withCapabilities(Tool.withPermission(
          Tool.make({
            description: "Wait for a Browser Dock page element, text, navigation readiness, or a short bounded delay.",
            input: WaitInput,
            output: WaitOutput,
            toModelOutput: ({ output }) => [
              { type: "text", text: `Browser wait completed (${output.waited}) on ${output.url}.` },
            ],
            validateInput: (input) => {
              if (!isRecord(input)) return
              if (input.ref && input.selector) return "provide either ref or selector, not both"
              const conditions = [input.ref, input.selector, input.text, input.milliseconds].filter(
                (item) => item !== undefined,
              )
              if (conditions.length <= 1) return undefined
              return "provide only one wait condition"
            },
            execute: (input, context) =>
              invoke(
                WaitOutput,
                "browser_read",
                { type: "browser.wait", ...input, timeout: input.timeout ?? 15_000 },
                context,
              ),
          }),
          "browser_read",
        ), ["browser_read"]),
      })
      .pipe(Effect.orDie)
  }),
)

function validateTarget(input: unknown) {
  if (!isRecord(input)) return
  if (input.ref && input.selector) return "provide either ref or selector, not both"
  if (!input.ref && !input.selector) return "provide ref or selector"
}

function permissionMetadata(action: Action) {
  return {
    type: action.type,
    ...(typeof action.url === "string" ? { url: action.url } : {}),
    ...(typeof action.ref === "string" ? { ref: action.ref } : {}),
    ...(typeof action.selector === "string" ? { selector: action.selector } : {}),
    ...(typeof action.text === "string" ? { textLength: action.text.length } : {}),
    ...(typeof action.screenshot === "boolean" ? { screenshot: action.screenshot } : {}),
  }
}

function currentOrigin(status: unknown) {
  return Effect.try({ try: () => currentOriginValue(status), catch: toToolFailure })
}

function currentOriginValue(status: unknown) {
  if (!isRecord(status) || !isRecord(status.browser))
    throw new Error("No active Browser Dock webview is available. Call browser_navigate with an HTTP(S) URL first.")
  const url =
    typeof status.browser.actualURL === "string"
      ? status.browser.actualURL
      : typeof status.browser.url === "string"
        ? status.browser.url
        : undefined
  if (!url || !isHttpUrl(url))
    throw new Error("No active Browser Dock webview is available. Call browser_navigate with an HTTP(S) URL first.")
  return originOf(url)
}

function bridgeCall(bridge: Bridge, action: Action): Effect.Effect<unknown, ToolFailure> {
  return Effect.tryPromise({
    try: () => bridge.action(action),
    catch: (error) => new ToolFailure({ message: describeBridgeError(error) }),
  })
}

function toToolFailure(error: unknown) {
  return error instanceof ToolFailure ? error : new ToolFailure({ message: describeBridgeError(error) })
}

function describeBridgeError(error: unknown) {
  if (error instanceof ToolFailure) return error.message
  if (error instanceof Error && error.message !== "An error occurred in Effect.tryPromise") return error.message
  if (error instanceof Error && error.cause instanceof Error) return error.cause.message
  return describe(error)
}

function originOf(input: string) {
  return new URL(input).origin
}

function isHttpUrl(input: string) {
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  return url.protocol === "http:" || url.protocol === "https:"
}

function formatSnapshot(output: typeof SnapshotOutput.Encoded) {
  const elements = output.elements
    .map(
      (element) =>
        `[${element.ref}] <${element.tag}> role=${element.role || "-"} name=${JSON.stringify(element.name)}${element.disabled ? " disabled" : ""}`,
    )
    .join("\n")
  const console = output.evidence.console.length ? output.evidence.console.join("\n") : "none"
  const network = output.evidence.network.length ? output.evidence.network.join("\n") : "none"
  return [
    `URL: ${output.url}`,
    `Title: ${output.title}`,
    `Visible text:\n${output.text || "(empty)"}`,
    `Accessibility:\n${output.accessibility || "(empty)"}`,
    `Interactive elements:\n${elements || "none"}`,
    `Console evidence:\n${console}`,
    `Network evidence:\n${network}`,
  ].join("\n\n")
}

async function callDesktopBridge(action: Action) {
  const info = await readBridgeInfo()
  const response = await fetch(new URL("/action", info.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-desktop-token": info.token,
    },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(MAX_TIMEOUT_MS + 5_000),
  })
  const body = (await response.json()) as unknown
  if (!response.ok) throw new Error(`Desktop Browser bridge failed (${response.status}): ${describe(body)}`)
  return body
}

async function readBridgeInfo() {
  const file =
    process.env.OPENCODE_DESKTOP_BRIDGE_FILE ??
    (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, "desktop-testing.json") : undefined)
  if (!file) throw new Error("Integrated Browser tools require OpenCode Desktop")
  const input = JSON.parse(await readFile(file, "utf8")) as unknown
  if (!isRecord(input) || typeof input.url !== "string" || typeof input.token !== "string")
    throw new Error("OpenCode Desktop Browser bridge metadata is invalid")
  const url = new URL(input.url)
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost"))
    throw new Error("OpenCode Desktop Browser bridge must use loopback HTTP")
  return { url, token: input.token }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function describe(input: unknown) {
  if (input instanceof Error) return input.message
  if (typeof input === "string") return input
  return JSON.stringify(input)
}
