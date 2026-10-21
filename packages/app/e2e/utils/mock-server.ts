import type { Page, Route } from "@playwright/test"

const emptyList = new Set([
  "/skill",
  "/command",
  "/lsp",
  "/formatter",
  "/find/file",
  "/file",
  "/permission",
  "/pty/shells",
  "/vcs/status",
  "/vcs/diff",
])
const emptyObject = new Set(["/global/config", "/config", "/provider/auth", "/mcp", "/pty"])

export interface MockServerConfig {
  port?: string
  provider: unknown
  agents?: unknown[]
  commands?: unknown[]
  directory: string
  project: unknown | unknown[]
  sessions: ({ id: string } & Record<string, unknown>)[]
  sessionList?: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (
    sessionId: string,
    limit: number,
    before?: string,
  ) => { items: unknown[]; cursor?: string } | Promise<{ items: unknown[]; cursor?: string }>
  messageDelay?: number
  questions?: () => unknown[]
  permissions?: () => unknown[]
  surfaceTools?: () => unknown[]
  onMessages?: (input: {
    sessionID: string
    before?: string
    limit: number
    phase: "start" | "end"
  }) => unknown | Promise<unknown>
  sessionStatus?: unknown | (() => unknown | Promise<unknown>)
  eventDelay?: number
  globalEvents?: () => unknown[]
  events?: () => unknown[]
  eventRetry?: number
  globalConfig?: () => unknown
  config?: (directory: string) => unknown
  mcpStatus?: () => unknown
  onGlobalConfigUpdate?: (body: unknown) => unknown | Promise<unknown>
  onConfigUpdate?: (input: { directory: string; body: unknown }) => unknown | Promise<unknown>
  onQuestionReply?: (input: { requestID: string; body: unknown }) => unknown | Promise<unknown>
  onQuestionReject?: (input: { sessionID: string; requestID: string }) => unknown | Promise<unknown>
  onPermissionReply?: (input: { sessionID: string; requestID: string; body: unknown }) => unknown | Promise<unknown>
  onSurfacePin?: (input: { sessionID: string; requestID: string; body: unknown }) => unknown | Promise<unknown>
  onSurfaceToolState?: (input: { toolID: string; body: unknown }) => unknown | Promise<unknown>
  onSurfaceToolVisibility?: (input: { toolID: string; body: unknown }) => unknown | Promise<unknown>
  onSurfaceToolRemove?: (input: { toolID: string }) => unknown | Promise<unknown>
  onSessionActivity?: (input: { sessionID: string }) => unknown | Promise<unknown>
  onSessionHeldInputs?: (input: { sessionID: string }) => unknown | Promise<unknown>
  onAppQuestionAttachment?: (input: {
    directory: string
    body: Buffer
    mime: string
    filename?: string | null
  }) => unknown | Promise<unknown>
  onAppFormAction?: (body: unknown) => unknown | Promise<unknown>
  onAppHostAIRun?: (input: { directory: string; body: unknown }) => unknown | Promise<unknown>
  onGmailRecipientSuggestions?: (query: string) => unknown | Promise<unknown>
  onControlConfigApply?: (input: { directory: string; body: unknown }) => unknown | Promise<unknown>
  onControlLivePublish?: (input: { directory: string; body: unknown }) => unknown | Promise<unknown>
  onSessionCreate?: (body: unknown) => unknown | Promise<unknown>
  onSessionFork?: (input: { sessionID: string; directory: string; body: unknown }) => unknown | Promise<unknown>
  onSessionUpdate?: (input: { sessionID: string; directory: string; body: unknown }) => unknown | Promise<unknown>
  onSessionPrompt?: (input: { sessionID: string; body: unknown }) => unknown | Promise<unknown>
  onSessionWait?: (input: { sessionID: string }) => unknown | Promise<unknown>
  onSessionCommand?: (input: { sessionID: string; body: unknown }) => unknown | Promise<unknown>
  onSessionInterrupt?: (input: { sessionID: string; directory: string }) => unknown | Promise<unknown>
  onSessionAbort?: (input: { sessionID: string; directory: string }) => unknown | Promise<unknown>
  onSessionToolCancel?: (input: { sessionID: string; callID: string }) => unknown | Promise<unknown>
  onMoveSession?: (body: unknown) => unknown | Promise<unknown>
  onMcpStarter?: (body: unknown) => unknown | Promise<unknown>
  onMcpAdd?: (body: unknown) => unknown | Promise<unknown>
  onMcpConnect?: (input: { name: string; directory: string }) => unknown | Promise<unknown>
  onMcpDisconnect?: (input: { name: string; directory: string }) => unknown | Promise<unknown>
  onFileRead?: (input: { directory: string; path: string }) => unknown | Promise<unknown>
  onPerfRecord?: (body: unknown) => unknown | Promise<unknown>
  appState?: (key: string) => Record<string, unknown> | Promise<Record<string, unknown>>
  onAppStateWrite?: (input: { key: string; body: unknown }) => unknown | Promise<unknown>
}

export async function mockOpenCodeServer(page: Page, config: MockServerConfig) {
  let navigationEpoch = 0
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigationEpoch++ })
  const projects = Array.isArray(config.project) ? config.project : [config.project]
  const projectWorktree = (project: unknown) =>
    project && typeof project === "object" && "worktree" in project && typeof project.worktree === "string"
      ? project.worktree
      : undefined
  const staticRoutes: Record<string, unknown> = {
    "/provider": config.provider,
    "/project": projects,
    "/agent": config.agents ?? [{ name: "build", mode: "primary" }],
    "/vcs": { branch: "main", default_branch: "main" },
    "/session": config.sessionList ?? config.sessions,
  }

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = config.port ?? process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    const path = url.pathname
    const resourceType = route.request().resourceType()
    const apiRequest = resourceType === "fetch" || resourceType === "xhr" || resourceType === "eventsource"
    const mockMedia = path === "/app/media" || path.startsWith("/app/attachment/proof/")
    if (url.port !== targetPort || route.request().isNavigationRequest() || (!apiRequest && !mockMedia))
      return route.fallback()

    const scopedDirectory =
      url.searchParams.get("directory") ??
      decodeURIComponent(route.request().headers()["x-opencode-directory"] ?? config.directory)
    if (path === "/app/host/session-policy" && route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      if (body.caller?.id !== "scheduled-jobs-app" || body.caller?.hash !== "scheduled-jobs")
        return json(route, { error: "Plugin identity denied" }, undefined, 403)
      const session = config.sessions.find((item) => item.id === body.sessionID)
      if (body.action === "read") return json(route, { ok: true, mode: "ask" })
      if (!session || session.directory !== scopedDirectory)
        return json(route, { error: "Session scope mismatch" }, undefined, 403)
      const metadata = { ...record(session.metadata), access_control: { mode: body.mode } }
      await config.onSessionUpdate?.({ sessionID: body.sessionID, directory: scopedDirectory, body: { metadata } })
      Object.assign(session, { metadata })
      return json(route, { ok: true, mode: body.mode })
    }
    if (path === "/path")
      return json(route, {
        state: scopedDirectory,
        config: scopedDirectory,
        worktree: scopedDirectory,
        directory: scopedDirectory,
        home: "C:/OpenCode",
      })
    if (path === "/project/current")
      return json(route, projects.find((project) => projectWorktree(project) === scopedDirectory) ?? projects[0])
    if (path === "/global/event" || path === "/event") {
      const epoch = navigationEpoch
      if (config.eventDelay) await new Promise((resolve) => setTimeout(resolve, config.eventDelay))
      // A delayed response owned by the previous document must not consume its
      // successor's event queue after reload or navigation.
      if (epoch !== navigationEpoch) return sse(route, [], config.eventRetry)
      return sse(
        route,
        path === "/global/event" ? (config.globalEvents?.() ?? config.events?.()) : config.events?.(),
        config.eventRetry,
      )
    }
    if (path === "/global/health") return json(route, { healthy: true })
    if (path === "/global/config" && route.request().method() === "GET" && config.globalConfig)
      return json(route, config.globalConfig())
    if (path === "/global/config" && (route.request().method() === "POST" || route.request().method() === "PATCH")) {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onGlobalConfigUpdate?.(body)) ?? {})
    }
    if (path === "/config" && route.request().method() === "GET" && config.config)
      return json(route, config.config(scopedDirectory))
    if (path === "/config" && (route.request().method() === "POST" || route.request().method() === "PATCH")) {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onConfigUpdate?.({ directory: scopedDirectory, body })) ?? {})
    }
    if (path === "/api/surface/request" && route.request().method() === "GET" && config.questions)
      return json(route, { location: { directory: scopedDirectory }, data: config.questions() })
    const v2SurfaceListMatch = path.match(/^\/api\/session\/([^/]+)\/surface$/)
    if (v2SurfaceListMatch && route.request().method() === "GET" && config.questions)
      return json(route, {
        location: { directory: scopedDirectory },
        data: config.questions().filter(
          (request) =>
            typeof request === "object" &&
            request !== null &&
            "sessionID" in request &&
            request.sessionID === v2SurfaceListMatch[1],
        ),
      })
    if (path === "/api/permission/request" && route.request().method() === "GET")
      return json(route, { location: { directory: scopedDirectory }, data: config.permissions?.() ?? [] })
    if (path === "/api/surface/tool" && route.request().method() === "GET")
      return json(route, { location: { directory: scopedDirectory }, data: config.surfaceTools?.() ?? [] })
    if (path === "/command" && config.commands) return json(route, config.commands)
    if (path === "/api/command" && config.commands)
      return json(route, { location: { directory: scopedDirectory }, data: config.commands })
    if (path === "/mcp" && route.request().method() === "GET" && config.mcpStatus)
      return json(route, config.mcpStatus())
    if (path === "/perf/record" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onPerfRecord?.(body)) ?? { accepted: 0 })
    }
    if (path === "/api/control/config/apply" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onControlConfigApply?.({ directory: scopedDirectory, body })) ?? {})
    }
    if (path === "/api/control/live/publish" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onControlLivePublish?.({ directory: scopedDirectory, body })) ?? {})
    }
    if (path === "/app/gmail/recipients" && route.request().method() === "GET") {
      return json(
        route,
        (await config.onGmailRecipientSuggestions?.(url.searchParams.get("q") ?? "")) ?? { ok: true, suggestions: [] },
      )
    }
    if (path === "/app/media" && route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "access-control-allow-origin": "*" },
        body: [
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 336'>",
          "<rect width='240' height='336' rx='16' fill='#1d2939'/>",
          "<rect x='24' y='24' width='192' height='170' rx='12' fill='#f2c94c'/>",
          "<text x='120' y='235' text-anchor='middle' font-size='30' font-family='Arial' fill='white'>CardFreia</text>",
          "<text x='120' y='270' text-anchor='middle' font-size='20' font-family='Arial' fill='#d0d5dd'>Cost 5 / Score 8</text>",
          "</svg>",
        ].join(""),
      })
    }
    if (path === "/app/surface-attachment" && route.request().method() === "POST") {
      return json(
        route,
        (await config.onAppQuestionAttachment?.({
          directory: scopedDirectory,
          body: route.request().postDataBuffer() ?? Buffer.alloc(0),
          mime: route.request().headers()["content-type"] ?? url.searchParams.get("mime") ?? "application/octet-stream",
          filename: url.searchParams.get("filename"),
        })) ?? {
          ok: true,
          file: {
            type: "file",
            mime: route.request().headers()["content-type"] ?? url.searchParams.get("mime") ?? "image/png",
            url: `file:///mock-question-attachments/${url.searchParams.get("filename") ?? "clipboard.png"}`,
            filename: url.searchParams.get("filename") ?? "clipboard.png",
          },
        },
      )
    }
    if (path === "/app/form-action" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      const result = (await config.onAppFormAction?.(body)) ?? { ok: true }
      if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
        return route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify("body" in result ? result.body : null),
        })
      }
      return json(route, result)
    }
    if (path === "/app/host/ai/run" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(
        route,
        (await config.onAppHostAIRun?.({ directory: scopedDirectory, body })) ?? {
          ok: false,
          error: "No mocked AI response",
        },
      )
    }
    const appStateMatch = path.match(/^\/app\/state\/([^/]+)$/)
    if (appStateMatch && route.request().method() === "GET")
      return json(route, (await config.appState?.(decodeURIComponent(appStateMatch[1]))) ?? {})
    if (appStateMatch && route.request().method() === "PUT") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onAppStateWrite?.({ key: decodeURIComponent(appStateMatch[1]), body })) ?? {})
    }
    if (path === "/session/status")
      return json(
        route,
        typeof config.sessionStatus === "function" ? await config.sessionStatus() : (config.sessionStatus ?? {}),
      )
    if (path === "/session" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onSessionCreate?.(body)) ?? config.sessions[0] ?? {})
    }
    if (path === "/api/session") {
      if (route.request().method() === "POST") {
        const bodyText = route.request().postData()
        const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
        return json(route, { data: (await config.onSessionCreate?.(body)) ?? config.sessions[0] ?? {} })
      }
      return json(route, { data: config.sessionList ?? config.sessions, cursor: {} })
    }
    const existsMatch = path.match(/^\/session\/([^/]+)\/exists$/)
    if (existsMatch && route.request().method() === "GET") {
      const session = config.sessions.find((item) => item.id === existsMatch[1])
      return json(route, session ? { exists: true, session } : { exists: false })
    }
    const forkMatch = path.match(/^\/session\/([^/]+)\/fork$/)
    if (forkMatch && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(
        route,
        (await config.onSessionFork?.({ sessionID: forkMatch[1], directory: scopedDirectory, body })) ??
          config.sessions.find((session) => session.id === forkMatch[1]) ??
          {},
      )
    }
    if (path === "/experimental/control-plane/move-session" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onMoveSession?.(body)) ?? {})
    }
    const v2PromptMatch = path.match(/^\/api\/session\/([^/]+)\/prompt$/)
    if (v2PromptMatch && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      const value = record(body)
      return json(
        route,
        (await config.onSessionPrompt?.({ sessionID: v2PromptMatch[1], body })) ?? {
          data: { sessionID: v2PromptMatch[1], messageID: text(value.id, "msg_mock_admitted"), admittedSeq: 1 },
        },
      )
    }
    const v2WaitMatch = path.match(/^\/api\/session\/([^/]+)\/wait$/)
    if (v2WaitMatch && route.request().method() === "POST") {
      return json(route, (await config.onSessionWait?.({ sessionID: v2WaitMatch[1] })) ?? {})
    }
    const v2CommandMatch = path.match(/^\/api\/session\/([^/]+)\/command$/)
    if (v2CommandMatch && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(
        route,
        (await config.onSessionCommand?.({ sessionID: v2CommandMatch[1], body })) ?? {
          data: { sessionID: v2CommandMatch[1], messageID: "msg_mock_command", admittedSeq: 1 },
        },
      )
    }
    if (path === "/mcp/starter") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onMcpStarter?.(body)) ?? {})
    }
    if (path === "/mcp" && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(route, (await config.onMcpAdd?.(body)) ?? {})
    }
    if (path === "/file/content") {
      return json(
        route,
        (await config.onFileRead?.({ directory: scopedDirectory, path: url.searchParams.get("path") ?? "" })) ?? {},
      )
    }
    const mcpConnectMatch = path.match(/^\/mcp\/([^/]+)\/connect$/)
    if (mcpConnectMatch)
      return json(
        route,
        (await config.onMcpConnect?.({ name: mcpConnectMatch[1], directory: scopedDirectory })) ?? true,
      )
    const mcpDisconnectMatch = path.match(/^\/mcp\/([^/]+)\/disconnect$/)
    if (mcpDisconnectMatch)
      return json(
        route,
        (await config.onMcpDisconnect?.({ name: mcpDisconnectMatch[1], directory: scopedDirectory })) ?? true,
      )
    if (emptyObject.has(path)) return json(route, {})
    if (emptyList.has(path)) return json(route, [])
    if (path in staticRoutes) return json(route, staticRoutes[path])

    const sessionMatch = path.match(/^\/session\/([^/]+)$/)
    if (sessionMatch) {
      if (route.request().method() === "PATCH") {
        const bodyText = route.request().postData()
        const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
        return json(
          route,
          (await config.onSessionUpdate?.({ sessionID: sessionMatch[1], directory: scopedDirectory, body })) ??
            config.sessions.find((s) => s.id === sessionMatch[1]) ??
            {},
        )
      }
      const session = config.sessions.find((s) => s.id === sessionMatch[1])
      return json(route, session ?? {})
    }

    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(path)) return json(route, [])

    const abortMatch = path.match(/^\/session\/([^/]+)\/abort$/)
    if (abortMatch) {
      return json(
        route,
        (await config.onSessionAbort?.({ sessionID: abortMatch[1], directory: scopedDirectory })) ?? true,
      )
    }

    const interruptMatch = path.match(/^\/api\/session\/([^/]+)\/interrupt$/)
    if (interruptMatch && route.request().method() === "POST") {
      return json(
        route,
        (await config.onSessionInterrupt?.({ sessionID: interruptMatch[1], directory: scopedDirectory })) ?? {
          data: true,
        },
      )
    }

    const v2ToolCancelMatch = path.match(/^\/api\/session\/([^/]+)\/tool\/([^/]+)\/cancel$/)
    if (v2ToolCancelMatch && route.request().method() === "POST") {
      return json(
        route,
        (await config.onSessionToolCancel?.({
          sessionID: v2ToolCancelMatch[1],
          callID: v2ToolCancelMatch[2],
        })) ?? { data: { cancelled: true } },
      )
    }

    const v2QuestionReplyMatch = path.match(/^\/api\/session\/[^/]+\/surface\/([^/]+)\/reply$/)
    if (v2QuestionReplyMatch && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      const result = await config.onQuestionReply?.({ requestID: v2QuestionReplyMatch[1], body })
      if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
        return route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify("body" in result ? result.body : null),
        })
      }
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }

    const v2QuestionRejectMatch = path.match(/^\/api\/session\/([^/]+)\/surface\/([^/]+)\/dismiss$/)
    if (v2QuestionRejectMatch && route.request().method() === "POST") {
      const result = await config.onQuestionReject?.({ sessionID: v2QuestionRejectMatch[1], requestID: v2QuestionRejectMatch[2] })
      if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
        return route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify("body" in result ? result.body : null),
        })
      }
      if (result && typeof result === "object" && "status" in result) return json(route, result)
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }

    const v2PermissionReplyMatch = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/)
    if (v2PermissionReplyMatch && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      const result = await config.onPermissionReply?.({
        sessionID: v2PermissionReplyMatch[1],
        requestID: v2PermissionReplyMatch[2],
        body,
      })
      if (result && typeof result === "object" && "status" in result && typeof result.status === "number") {
        return route.fulfill({
          status: result.status,
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify("body" in result ? result.body : null),
        })
      }
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }

    const surfacePinMatch = path.match(/^\/api\/session\/([^/]+)\/surface\/([^/]+)\/pin$/)
    if (surfacePinMatch && route.request().method() === "POST") {
      const bodyText = route.request().postData()
      const body: unknown = bodyText ? JSON.parse(bodyText) : undefined
      return json(
        route,
        (await config.onSurfacePin?.({ sessionID: surfacePinMatch[1], requestID: surfacePinMatch[2], body })) ?? {},
      )
    }

    const surfaceToolStateMatch = path.match(/^\/api\/surface\/tool\/([^/]+)\/state$/)
    if (surfaceToolStateMatch && route.request().method() === "PATCH") {
      const bodyText = route.request().postData()
      return json(
        route,
        (await config.onSurfaceToolState?.({
          toolID: surfaceToolStateMatch[1],
          body: bodyText ? JSON.parse(bodyText) : undefined,
        })) ?? {},
      )
    }

    const surfaceToolVisibilityMatch = path.match(/^\/api\/surface\/tool\/([^/]+)\/visibility$/)
    if (surfaceToolVisibilityMatch && route.request().method() === "PATCH") {
      const bodyText = route.request().postData()
      return json(
        route,
        (await config.onSurfaceToolVisibility?.({
          toolID: surfaceToolVisibilityMatch[1],
          body: bodyText ? JSON.parse(bodyText) : undefined,
        })) ?? {},
      )
    }

    const surfaceToolRemoveMatch = path.match(/^\/api\/surface\/tool\/([^/]+)$/)
    if (surfaceToolRemoveMatch && route.request().method() === "DELETE") {
      await config.onSurfaceToolRemove?.({ toolID: surfaceToolRemoveMatch[1] })
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }

    const v2SessionActivityMatch = path.match(/^\/api\/session\/([^/]+)\/activity$/)
    if (v2SessionActivityMatch && route.request().method() === "GET")
      return json(
        route,
        (await config.onSessionActivity?.({ sessionID: v2SessionActivityMatch[1] })) ?? { data: { type: "idle" } },
      )

    const v2HeldInputsMatch = path.match(/^\/api\/session\/([^/]+)\/held-inputs$/)
    if (v2HeldInputsMatch && route.request().method() === "GET")
      return json(route, (await config.onSessionHeldInputs?.({ sessionID: v2HeldInputsMatch[1] })) ?? { data: [] })

    const v2MessagesMatch = path.match(/^\/api\/session\/([^/]+)\/message$/)
    if (v2MessagesMatch) {
      const cursor = url.searchParams.get("cursor") ?? undefined
      const limit = Number(url.searchParams.get("limit") ?? 80)
      await config.onMessages?.({ sessionID: v2MessagesMatch[1], before: cursor, limit, phase: "start" })
      if (config.messageDelay) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const pageData = await config.pageMessages(v2MessagesMatch[1], limit, cursor)
      await config.onMessages?.({ sessionID: v2MessagesMatch[1], before: cursor, limit, phase: "end" })
      return json(route, { data: toV2SessionMessages(pageData.items), cursor: { next: pageData.cursor } })
    }

    const v2SessionMatch = path.match(/^\/api\/session\/([^/]+)$/)
    if (v2SessionMatch) {
      return json(route, { data: config.sessions.find((s) => s.id === v2SessionMatch[1]) ?? {} })
    }

    const messagesMatch = path.match(/^\/session\/([^/]+)\/message$/)
    if (messagesMatch) {
      const before = url.searchParams.get("before") ?? undefined
      const limit = Number(url.searchParams.get("limit") ?? 80)
      await config.onMessages?.({ sessionID: messagesMatch[1], before, limit, phase: "start" })
      if (config.messageDelay) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const pageData = await config.pageMessages(messagesMatch[1], limit, before)
      await config.onMessages?.({ sessionID: messagesMatch[1], before, limit, phase: "end" })
      return json(route, pageData.items, pageData.cursor ? { "x-next-cursor": pageData.cursor } : undefined)
    }

    return json(route, {})
  })
}

function toV2SessionMessages(items: unknown[]): Record<string, unknown>[] {
  return items.flatMap((item): Record<string, unknown>[] => {
    const message = record(item)
    const info = record(message.info)
    const parts = Array.isArray(message.parts) ? message.parts : []
    const id = text(info.id, "msg_mock")
    if (info.role === "user") {
      const userTime = time(info.time)
      const userModel = record(info.model)
      const providerID = text(userModel.providerID, text(info.providerID))
      const modelID = text(userModel.modelID, text(userModel.id, text(info.modelID)))
      return [
        ...(typeof info.agent === "string"
          ? [{ id: `${id}:agent`, type: "agent-switched", time: { created: userTime.created - 2 }, agent: info.agent }]
          : []),
        ...(providerID && modelID
          ? [
              {
                id: `${id}:model`,
                type: "model-switched",
                time: { created: userTime.created - 1 },
                model: {
                  providerID,
                  id: modelID,
                  ...(typeof userModel.variant === "string" ? { variant: userModel.variant } : {}),
                },
              },
            ]
          : []),
        {
          id,
          type: "user",
          time: userTime,
          files: parts
            .map(record)
            .filter((part) => part.type === "file")
            .map((part) => ({ uri: text(part.url), mime: text(part.mime), name: text(part.filename) })),
          text: parts
            .map((part) => text(record(part).text))
            .filter(Boolean)
            .join("\n\n"),
        },
      ]
    }
    if (info.role !== "assistant") return []
    const error = record(info.error)
    const errorData = record(error.data)
    return [
      {
        id,
        type: "assistant",
        time: time(info.time),
        agent: text(info.agent, "build"),
        model: {
          providerID: text(info.providerID, "opencode"),
          id: text(info.modelID, "model"),
          ...(typeof info.variant === "string" ? { variant: info.variant } : {}),
        },
        content: parts.map(toV2AssistantContent),
        cost: number(info.cost),
        tokens: info.tokens,
        finish: info.finish,
        ...(typeof errorData.message === "string"
          ? { error: { type: "unknown", message: errorData.message } }
          : {}),
        ...(typeof errorData.code === "string"
          ? {
              failure: {
                code: errorData.code,
                message: text(errorData.message),
                retryability: "auto-retry",
                remediation: text(errorData.remediation, "retry"),
              },
            }
          : {}),
      },
    ]
  })
}

function toV2AssistantContent(input: unknown) {
  const part = record(input)
  const id = text(part.id, "part_mock")
  if (part.type === "text") return { id, type: "text", text: text(part.text) }
  if (part.type === "reasoning") return { id, type: "reasoning", text: text(part.text) }
  if (part.type === "custom") {
    const partTime = time(part.time)
    return {
      id,
      type: "custom",
      kind: text(part.kind),
      data: part.data,
      title: text(part.title) || undefined,
      fallback: text(part.fallback) || undefined,
      metadata: record(part.metadata),
      time: partTime.created || partTime.completed ? partTime : undefined,
    }
  }
  const state = record(part.state)
  const stateTime = time(state.time)
  const status = text(state.status, "completed")
  const base = {
    id,
    type: "tool",
    name: text(part.tool, "tool"),
    provider: record(part.provider),
    time: { created: stateTime.created, ran: stateTime.created, completed: stateTime.completed },
  }
  if (status === "pending") {
    return {
      ...base,
      state: { status: "pending", input: text(state.raw, JSON.stringify(record(state.input))) },
    }
  }
  if (status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input: record(state.input),
        structured: record(state.structured),
        content: Array.isArray(state.content) ? state.content : [],
      },
    }
  }
  return {
    ...base,
    state: {
      status: "completed",
      input: record(state.input),
      content: [{ type: "text", text: text(state.output) }],
      attachments: Array.isArray(state.attachments) ? state.attachments.map(toV2ToolAttachment) : undefined,
      outputPaths: [],
      structured: record(state.structured),
      result: state.output ?? null,
    },
    provider: { resultMetadata: record(state.metadata) },
    time: { created: stateTime.created, ran: stateTime.created, completed: stateTime.completed ?? stateTime.created },
  }
}

function toV2ToolAttachment(input: unknown) {
  const attachment = record(input)
  return {
    uri: text(attachment.uri, text(attachment.url)),
    mime: text(attachment.mime, "application/octet-stream"),
    name: text(attachment.name, text(attachment.filename)) || undefined,
  }
}

function record(input: unknown) {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function text(input: unknown, fallback = "") {
  return typeof input === "string" ? input : fallback
}

function number(input: unknown, fallback = 0) {
  return typeof input === "number" ? input : fallback
}

function time(input: unknown) {
  const value = record(input)
  return {
    created: number(value.created, number(value.start)),
    ...(typeof value.completed === "number"
      ? { completed: value.completed }
      : typeof value.end === "number"
        ? { completed: value.end }
        : {}),
  }
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[], retry?: number) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `${retry === undefined ? "" : `retry: ${retry}\n\n`}${events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n"}`,
  })
}
