import path from "node:path"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { speechSpeedProfile, SPEECH_SPEED_TARGETS } from "./speech-speed-profile"

// Use existing authenticated config/Settings APIs, never restart the app or
// write browser storage directly. Connection credentials stay in memory.
const token = await Bun.file(path.join(process.env.APPDATA!, "ai.opencode.desktop", "desktop-testing.json")).json()
const targets = (await (await fetch(`${token.cdpUrl}/json`)).json()) as Array<{
  url: string
  webSocketDebuggerUrl: string
}>
const target = targets.find((item) => item.url.startsWith("oc://renderer"))
if (!target) throw new Error("OpenCode renderer is unavailable")
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true })
  socket.addEventListener("error", () => reject(new Error("Desktop CDP connection failed")), { once: true })
})
const connection = await new Promise<{ url: string; username: string; password: string }>((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.close()
    reject(new Error("Desktop connection lookup timed out"))
  }, 10_000)
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== 1) return
    clearTimeout(timer)
    socket.close()
    if (message.result?.exceptionDetails || !message.result?.result?.value)
      return reject(new Error("Desktop initialization lookup failed"))
    resolve(message.result.result.value)
  })
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: "window.api.awaitInitialization()",
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  )
})
const configPath = path.join(process.env.USERPROFILE!, ".config", "opencode", "opencode.json")
const config = Schema.decodeUnknownSync(ConfigV1.Info)(await Bun.file(configPath).json())
const patch = speechSpeedProfile(config.model_chains ?? [], Bun.argv[2] ?? "a7be2be3-556e-49ad-a82e-19018fd97e3e")
Schema.decodeUnknownSync(ConfigV1.UpdateInfo)(patch)
const response = await fetch(`${connection.url}/global/config`, {
  method: "PATCH",
  headers: {
    authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(patch),
  signal: AbortSignal.timeout(30_000),
})
if (!response.ok) throw new Error(`Speech config update failed (${response.status})`)
// Direct targets avoid the installed renderer's one-shot chain hydration:
// a server config reload does not necessarily refresh its in-memory chains.
for (const [key, value] of Object.entries(SPEECH_SPEED_TARGETS)) {
  const settings = await fetch(`${token.url}/action`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
    body: JSON.stringify({ action: { type: "plugin.settings.set", pluginID: "speech-to-text-app", key, value } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!settings.ok) throw new Error(`Speech setting update failed (${settings.status})`)
}
console.log(JSON.stringify({ configStatus: response.status, targets: SPEECH_SPEED_TARGETS }))
