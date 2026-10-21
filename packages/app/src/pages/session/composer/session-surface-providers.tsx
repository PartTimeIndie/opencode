import { SDKProvider } from "@/context/sdk"
import { SessionRouteProvider } from "@/context/session-route"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { ParentProps } from "solid-js"

export function SessionSurfaceProviders(props: ParentProps<{ directory: string; sessionID: string }>) {
  return (
    <SessionRouteProvider
      params={() => ({
        dir: base64Encode(props.directory),
        id: props.sessionID || undefined,
      })}
    >
      <SDKProvider directory={props.directory}>
        <DirectoryDataProvider directory={props.directory}>{props.children}</DirectoryDataProvider>
      </SDKProvider>
    </SessionRouteProvider>
  )
}
