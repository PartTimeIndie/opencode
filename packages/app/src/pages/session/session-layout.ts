import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useSessionRoute } from "@/context/session-route"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"

export const useSessionKey = () => {
  const params = useSessionRoute()
  const server = useServer()
  const scope = createMemo(() => server.scope())
  const workspaceKey = createMemo(() => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir)))
  const sessionKey = createMemo(() => SessionStateKey.from(scope(), SessionRouteKey.fromRoute(params.dir, params.id)))
  return { params, sessionKey, workspaceKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey, workspaceKey } = useSessionKey()
  return {
    params,
    sessionKey,
    workspaceKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
