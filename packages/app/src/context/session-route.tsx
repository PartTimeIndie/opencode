import { useParams } from "@solidjs/router"
import { createContext, type Accessor, type ParentProps, useContext } from "solid-js"

export type SessionRouteParams = {
  dir?: string
  id?: string
}

const SessionRouteContext = createContext<Accessor<SessionRouteParams>>()

export function SessionRouteProvider(props: ParentProps<{ params: Accessor<SessionRouteParams> }>) {
  return <SessionRouteContext.Provider value={props.params}>{props.children}</SessionRouteContext.Provider>
}

export function useSessionRoute() {
  const context = useContext(SessionRouteContext)
  const params = useParams<SessionRouteParams>()
  if (!context) return params
  return {
    get dir() {
      return context().dir
    },
    get id() {
      return context().id
    },
  }
}
