import type { ConfigUpdate, OpencodeClient } from "@opencode-ai/sdk/v2/client"

export function updateGlobalConfig(client: OpencodeClient, config: ConfigUpdate) {
  return client.global.config.update({ configUpdate: config })
}
