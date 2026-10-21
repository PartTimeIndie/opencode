import { parseDesktopTestingModel, parseDesktopTestingSessionModelFlag } from "./desktop-testing-model"
import { rendererUncaughtConsoleProblem } from "./desktop-testing-diagnose"

type TokenFile = {
  url: string
  token: string
  pid?: number
  cdpUrl?: string
  cdpPort?: string
}

type Parsed = {
  command: string
  args: string[]
  flags: Record<string, string | true>
}

const parsed = parse(Bun.argv.slice(2))
if (!parsed.command) usage()

const tokenFile = await readTokenFile()
const response = await run(parsed, tokenFile)
console.log(JSON.stringify(response, null, 2))

async function run(input: Parsed, tokenFile: TokenFile) {
  if (input.command === "status") return request(tokenFile, "GET", "/status")
  if (input.command === "prepare-recovery") return request(tokenFile, "POST", "/shutdown/prepare-recovery", {})
  if (input.command === "screenshot") {
    return request(tokenFile, "POST", "/screenshot", { includeBase64: input.flags["include-base64"] === true })
  }
  if (input.command === "screen-state") {
    return request(tokenFile, "POST", "/screen-state", { includeBase64: input.flags["include-base64"] === true })
  }
  if (input.command === "diagnose-screen-state")
    return diagnoseScreenState(tokenFile, input.flags["include-base64"] === true)
  if (input.command === "action") {
    const type = input.args[0]
    if (!type) throw new Error("action requires an action type")
    return request(tokenFile, "POST", "/action", { action: actionFromFlags(type, input.flags) })
  }
  if (input.command === "cli") {
    const model = stringFlag(input.flags.model)
    return request(tokenFile, "POST", "/cli/run", {
      agent: stringFlag(input.flags.agent),
      directory: stringFlag(input.flags.directory) ?? stringFlag(input.flags.dir) ?? process.cwd(),
      model: model ? parseDesktopTestingSessionModelFlag(model, stringFlag(input.flags.variant)) : undefined,
      prompt: stringFlag(input.flags.prompt),
      visible: input.flags.visible === true,
      waitMs: numberFlag(input.flags["wait-ms"]),
    })
  }
  usage()
}

async function request(tokenFile: TokenFile, method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${tokenFile.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokenFile.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => {
    throw new Error(bridgeConnectionError(tokenFile, error))
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : response.statusText)
  return data
}

async function diagnoseScreenState(tokenFile: TokenFile, includeBase64: boolean) {
  const status = await measure("status", () => request(tokenFile, "GET", "/status"))
  const screenshot = await measure("screenshot", () => request(tokenFile, "POST", "/screenshot", { includeBase64 }))
  const screenState = await measure("screen-state", () =>
    request(tokenFile, "POST", "/screen-state", { includeBase64 }),
  )
  const issues = [status, screenshot, screenState].flatMap((probe) => {
    const problem = desktopProbeProblem(probe.data)
    return problem ? [`${probe.name}: ${problem}`] : []
  })
  return {
    classification:
      screenState.ok && issues.length === 0 ? "healthy" : status.ok || screenshot.ok ? "warning" : "error",
    issues,
    bridgeUrl: tokenFile.url,
    pid: tokenFile.pid,
    processRunning: tokenFile.pid === undefined ? undefined : processRunning(tokenFile.pid),
    status,
    screenshot,
    screenState,
  }
}

function desktopProbeProblem(data: unknown): string | undefined {
  if (!isRecord(data)) return
  if (typeof data.error === "string" && data.error) return data.error
  if (data.ok === false) return "Probe reported failure"
  if (isRecord(data.state) && typeof data.state.error === "string" && data.state.error) return data.state.error
  if (isRecord(data.state)) {
    const uncaught = rendererUncaughtConsoleProblem({ console: data.state.console, now: Date.now() })
    if (uncaught) return uncaught
  }
  if (isRecord(data.renderer) && typeof data.renderer.error === "string" && data.renderer.error)
    return data.renderer.error
  if (isRecord(data.sidecar) && data.sidecar.healthy === false) return "Sidecar is unhealthy"
  if (data.probablyBlank === true) return "Capture is probably blank"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function measure(name: string, run: () => Promise<unknown>) {
  const startedAt = Date.now()
  try {
    const data = await run()
    return { name, ok: true, durationMs: Date.now() - startedAt, data }
  } catch (error) {
    return {
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function readTokenFile(): Promise<TokenFile> {
  const path =
    stringFlag(parsed.flags["token-file"]) ?? process.env.OPENCODE_DESKTOP_TESTING_TOKEN_FILE ?? defaultTokenFile()
  const data = (await Bun.file(path).json()) as Partial<TokenFile>
  if (!data.url || !data.token) throw new Error(`Desktop testing token file is invalid: ${path}`)
  return { url: data.url, token: data.token, pid: data.pid, cdpUrl: data.cdpUrl, cdpPort: data.cdpPort }
}

function actionFromFlags(type: string, flags: Record<string, string | true>) {
  if (type === "app.command") return { type, command: required(flags.command, "--command") }
  if (type === "app.menu") return { type, action: required(flags.action, "--action") }
  if (type === "session.list") return { type, directory: stringFlag(flags.directory) ?? stringFlag(flags.dir) }
  if (type === "session.open")
    return {
      type,
      sessionID: required(flags.session, "--session"),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
    }
  if (type === "session.resume")
    return {
      type,
      sessionID: required(flags.session, "--session"),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
    }
  if (type === "session.cancelTool")
    return {
      type,
      sessionID: required(flags.session, "--session"),
      callID: required(flags.call, "--call"),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
    }
  if (type === "session.interrupt")
    return {
      type,
      sessionID: required(flags.session, "--session"),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
    }
  if (type === "question.list") return { type, directory: stringFlag(flags.directory) ?? stringFlag(flags.dir) }
  if (type === "question.reply") {
    return {
      type,
      sessionID: required(flags.session, "--session"),
      requestID: required(flags.request, "--request"),
      answers: parseAnswers(required(flags.answers, "--answers")),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
    }
  }
  if (type === "question.reject") {
    return {
      type,
      sessionID: required(flags.session, "--session"),
      requestID: required(flags.request, "--request"),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
    }
  }
  if (type === "session.prompt") {
    const model = stringFlag(flags.model)
    return {
      type,
      sessionID: required(flags.session, "--session"),
      directory: stringFlag(flags.directory) ?? stringFlag(flags.dir),
      text: required(flags.text, "--text"),
      agent: required(flags.agent, "--agent"),
      // Omitting --model lets the app resolve the configured default chain or
      // the session's stored model instead of forcing agents to guess one.
      ...(model ? { model: parseDesktopTestingModel(model) } : {}),
      variant: stringFlag(flags.variant),
    }
  }
  if (type === "browser.open" || type === "browser.navigate") return { type, url: required(flags.url, "--url") }
  if (type === "browser.close") return { type, tabId: stringFlag(flags.tab) ?? stringFlag(flags.tabId) }
  if (type === "browser.status") return { type }
  if (type === "plugin.dock.open" || type === "plugin.dock.close" || type === "plugin.toolbar.invoke") {
    return { type, pluginID: required(flags.plugin, "--plugin"), itemID: required(flags.item, "--item") }
  }
  if (type === "plugin.settings.get") return { type, pluginID: required(flags.plugin, "--plugin") }
  if (type === "plugin.settings.set") {
    return {
      type,
      pluginID: required(flags.plugin, "--plugin"),
      key: required(flags.key, "--key"),
      value: parseValue(required(flags.value, "--value")),
    }
  }
  if (type === "plugin.automation.run") {
    const actionInput = stringFlag(flags.input)
    const encodedInput = stringFlag(flags["input-base64"])
    if (actionInput && encodedInput) throw new Error("Use either --input or --input-base64, not both")
    return {
      type,
      pluginID: required(flags.plugin, "--plugin"),
      actionID: required(flags.action, "--action"),
      input: encodedInput
        ? parseValue(Buffer.from(encodedInput, "base64").toString("utf8"))
        : actionInput
          ? parseValue(actionInput)
          : undefined,
    }
  }
  if (type === "screen.capture" || type === "app.status") return { type }
  if (type.startsWith("window.")) return { type }
  if (type === "plugin.list") return { type }
  return { type, ...Object.fromEntries(Object.entries(flags).filter(([, value]) => value !== true)) }
}

function parse(input: string[]): Parsed {
  const [command = "", ...rest] = input
  const args: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]
    if (!item?.startsWith("--")) {
      if (item) args.push(item)
      continue
    }
    const key = item.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith("--")) {
      flags[key] = true
      continue
    }
    flags[key] = next
    index++
  }
  return { command, args, flags }
}

function defaultTokenFile() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA
    if (!appData) throw new Error("APPDATA is not set")
    return `${appData}\\ai.opencode.desktop\\desktop-testing.json`
  }
  const home = process.env.HOME
  if (!home) throw new Error("HOME is not set")
  return `${home}/.config/ai.opencode.desktop/desktop-testing.json`
}

function required(value: string | true | undefined, flag: string) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`${flag} is required`)
}

function stringFlag(value: string | true | undefined) {
  return typeof value === "string" ? value : undefined
}

function numberFlag(value: string | true | undefined) {
  if (typeof value !== "string") return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`)
  return parsed
}

function parseValue(value: string) {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseAnswers(value: string) {
  const parsed = parseValue(value)
  if (Array.isArray(parsed)) return parsed
  const single = value.match(/^\[\[([^\[\]]+)\]\]$/)
  if (single) return [[single[1]!]]
  throw new Error('--answers must be a JSON array such as [["Spaeter"]]')
}

function bridgeConnectionError(tokenFile: TokenFile, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const pid = tokenFile.pid
  const processState =
    pid === undefined
      ? "token file has no recorded pid"
      : processRunning(pid)
        ? `recorded pid ${pid} is still running`
        : `recorded pid ${pid} is not running`
  return `Unable to connect to desktop testing bridge at ${tokenFile.url}; ${processState}. The token file may be stale or Browser automation may be disabled in Desktop settings. Original error: ${message}`
}

function processRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  bun run script/desktop-testing.ts status",
      "  bun run script/desktop-testing.ts screenshot",
      "  bun run script/desktop-testing.ts screen-state",
      "  bun run script/desktop-testing.ts diagnose-screen-state",
      "  bun run script/desktop-testing.ts action app.command --command settings.open",
      "  bun run script/desktop-testing.ts action question.list [--dir PATH]",
      "  bun run script/desktop-testing.ts action session.resume --session ID [--dir PATH]",
      "  bun run script/desktop-testing.ts action session.cancelTool --session ID --call CALL_ID [--dir PATH]",
      "  bun run script/desktop-testing.ts action question.reply --session ID --request ID --answers '[[\"Later\"]]' [--dir PATH]",
      "  bun run script/desktop-testing.ts action browser.open --url https://example.com",
      "  bun run script/desktop-testing.ts action browser.status",
      "  bun run script/desktop-testing.ts action plugin.automation.run --plugin example --action smoke (--input '{}' | --input-base64 BASE64)",
      "  bun run script/desktop-testing.ts cli --agent build --prompt 'hello' --wait-ms 5000 [--dir PATH]",
    ].join("\n"),
  )
}
