import os from "os"
import { Flag } from "../flag/flag"
import { InstallationVersion } from "../installation/version"

export function providerHeaders(input: {
  readonly provider: string
  readonly sessionID: string
  readonly requestID?: string
  readonly projectID?: string
}): Record<string, string> {
  return {
    "x-session-affinity": input.sessionID,
    "X-Session-Id": input.sessionID,
    "User-Agent": `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`,
    // Hosted OpenCode requests retain the attribution used by the V1 runner.
    // Read the actual host client flag; desktop, CLI and headless hosts set it.
    ...(input.provider.startsWith("opencode")
      ? {
          "x-opencode-client": Flag.OPENCODE_CLIENT,
          "x-opencode-session": input.sessionID,
          ...(input.requestID ? { "x-opencode-request": input.requestID } : {}),
          ...(input.projectID ? { "x-opencode-project": input.projectID } : {}),
        }
      : {}),
  }
}
