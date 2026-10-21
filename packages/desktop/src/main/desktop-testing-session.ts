import { Buffer } from "node:buffer"

type Sidecar = {
  url: string
  username: string | null
  password: string | null
}

export type DesktopTestingSessionModel = {
  providerID: string
  id: string
  variant?: string
  chain?: {
    id: string
    name: string
    active?: number
    steps: Array<{ providerID: string; id: string; variant?: string }>
  }
}

export function parseDesktopTestingSessionModel(value: unknown): DesktopTestingSessionModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const model = value as Record<string, unknown>
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return
  if (model.chain === undefined) {
    return {
      providerID: model.providerID,
      id: model.id,
      ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
    }
  }
  if (!model.chain || typeof model.chain !== "object" || Array.isArray(model.chain)) return
  const chain = model.chain as Record<string, unknown>
  if (typeof chain.id !== "string" || typeof chain.name !== "string" || !Array.isArray(chain.steps)) return
  const steps = chain.steps.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const step = value as Record<string, unknown>
    if (typeof step.providerID !== "string" || typeof step.id !== "string") return []
    return [{
      providerID: step.providerID,
      id: step.id,
      ...(typeof step.variant === "string" ? { variant: step.variant } : {}),
    }]
  })
  if (steps.length !== chain.steps.length || steps.length === 0) return
  return {
    providerID: model.providerID,
    id: model.id,
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
    chain: {
      id: chain.id,
      name: chain.name,
      ...(typeof chain.active === "number" ? { active: chain.active } : {}),
      steps,
    },
  }
}

type Input = {
  sidecar: Sidecar
  directory: string
  agent?: string
  model?: DesktopTestingSessionModel
  prompt: string
  waitMs?: number
  openSession?: (sessionID: string) => Promise<unknown>
}

export async function runDesktopTestingSession(input: Input) {
  const headers = sidecarHeaders(input.sidecar, input.directory)

  const created = await requestJson(new URL("/api/session", input.sidecar.url), {
    method: "POST",
    headers,
    body: JSON.stringify({
      agent: input.agent,
      model: input.model,
      location: { directory: input.directory },
    }),
  })
  const sessionID = requireString(requireRecord(requireRecord(created).data).id, "session id")
  const inputID = `msg_desktop_testing_${crypto.randomUUID().replaceAll("-", "")}`
  const promptRequest = {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: inputID,
      agent: input.agent,
      model: input.model,
      prompt: { text: input.prompt },
    }),
  }
  const promptURL = new URL(`/api/session/${encodeURIComponent(sessionID)}/prompt`, input.sidecar.url)
  let admitted: unknown
  try {
    admitted = await requestJson(promptURL, promptRequest)
  } catch (error) {
    if (!(error instanceof SidecarRequestError) || error.status < 500) throw error
    admitted = await requestJson(promptURL, promptRequest)
  }
  const admittedID = requireString(requireRecord(requireRecord(admitted).data).id, "session input id")
  if (admittedID !== inputID) throw new Error("Desktop sidecar admitted a different session input than requested")
  const visibility = input.openSession
    ? await input
        .openSession(sessionID)
        .then(() => ({ visible: true as const }))
        .catch((error) => ({ visible: false as const, visibilityError: errorMessage(error) }))
    : {}
  const accepted = { ok: true as const, accepted: true as const, sessionID, inputID, directory: input.directory, ...visibility }
  const waitMs = input.waitMs ?? 0
  if (waitMs <= 0) return accepted

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const status = await sessionStatus(input.sidecar, headers, sessionID).catch((error) => ({ error: errorMessage(error) }))
    if ("error" in status) return { ...accepted, waitError: status.error }
    if (status.status === "completed") return { ...accepted, completed: true as const, activityID: status.activityID }
    if (status.status === "failed")
      return {
        ...accepted,
        failed: true as const,
        activityID: status.activityID,
        ...(status.lastError ? { error: status.lastError } : {}),
      }
    if (status.status === "interrupted")
      return { ...accepted, interrupted: true as const, activityID: status.activityID }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())))
  }
  return { ...accepted, timedOut: true as const }
}

export async function resumeDesktopTestingSession(input: {
  sidecar: Sidecar
  directory: string
  sessionID: string
}) {
  await requestJson(new URL(`/api/session/${encodeURIComponent(input.sessionID)}/resume`, input.sidecar.url), {
    method: "POST",
    headers: sidecarHeaders(input.sidecar, input.directory),
  })
  return { ok: true as const, accepted: true as const, sessionID: input.sessionID, directory: input.directory }
}

async function sessionStatus(sidecar: Sidecar, headers: Headers, sessionID: string) {
  const body = requireRecord(
    await requestJson(new URL(`/api/session/${encodeURIComponent(sessionID)}/activity`, sidecar.url), { headers }),
  )
  const data = requireRecord(body.data)
  const activityID = typeof data.activityID === "string" ? data.activityID : undefined
  const lastError = typeof data.lastError === "string" ? data.lastError : undefined
  const status = data.activityStatus
  if (status === "completed" || status === "failed" || status === "interrupted") {
    return { status, activityID, lastError }
  }
  return { status: undefined, activityID, lastError }
}

function sidecarHeaders(sidecar: Sidecar, directory: string) {
  const headers = new Headers({
    "content-type": "application/json",
    "x-opencode-directory": directory,
  })
  if (!sidecar.password) return headers
  headers.set(
    "authorization",
    `Basic ${Buffer.from(`${sidecar.username ?? "opencode"}:${sidecar.password}`).toString("base64")}`,
  )
  return headers
}

async function requestJson(url: URL, init: RequestInit) {
  const response = await fetch(url, init)
  const text = await response.text()
  if (!response.ok) throw new SidecarRequestError(response.status, text || `${response.status} ${response.statusText}`)
  return text ? JSON.parse(text) : undefined
}

class SidecarRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function requireRecord(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error("Desktop sidecar returned an invalid response")
}

function requireString(value: unknown, label: string) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Desktop sidecar returned no ${label}`)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
