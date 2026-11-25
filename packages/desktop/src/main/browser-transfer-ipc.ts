import { ipcMain, session, webContents } from "electron"
import { browserTransferGuard } from "./browser-transfer-guard"
import { createBrowserTransferService } from "./browser-transfer-service"

const service = createBrowserTransferService(browserTransferGuard, (host, guestID) => {
  const guest = webContents.fromId(guestID)
  return !!guest && !guest.isDestroyed() && guest.getType() === "webview" &&
    guest.hostWebContents?.id === host && guest.session === session.fromPartition("persist:opencode-session-browser")
})

export function registerBrowserTransferIpc() {
  const observedHosts = new WeakSet<object>()
  const observedGuests = new WeakSet<object>()
  ipcMain.handle("browser-transfer", (event, action: unknown, id: unknown, ticket: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || event.sender.getType() !== "window") {
      throw new Error("Browser transfer requires the owning window")
    }
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid browser guest")
    const host = event.sender
    const guest = webContents.fromId(id)
    if (!guest || guest.isDestroyed() || guest.hostWebContents?.id !== host.id ||
        guest.session !== session.fromPartition("persist:opencode-session-browser")) {
      throw new Error("Browser guest owner does not match the requesting window")
    }
    if (!observedHosts.has(host)) {
      observedHosts.add(host)
      host.once("destroyed", () => service.closeHost(host.id))
    }
    if (!observedGuests.has(guest)) {
      observedGuests.add(guest)
      guest.once("destroyed", () => service.closeGuest(id))
    }
    if (action === "reserve") return service.reserve(host.id, id)
    if (typeof ticket !== "string") throw new Error("Browser transfer ticket is required")
    if (action === "commit") return service.commit(host.id, id, ticket)
    if (action === "release") return service.release(host.id, id, ticket)
    throw new Error("Unknown browser transfer action")
  })
}
