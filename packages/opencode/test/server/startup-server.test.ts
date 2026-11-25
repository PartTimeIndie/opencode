import { expect, test } from "bun:test"
import { once } from "node:events"
import { createStartupServer } from "../../src/server/startup-server"

test("early preflights finish before routes attach and later requests reach the handler", async () => {
  const server = createStartupServer({ cors: ["https://trusted.example"] })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing TCP address")
  const url = `http://127.0.0.1:${address.port}/global/health`
  try {
    const early = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(url, {
          method: "OPTIONS",
          headers: {
            Origin: "oc://renderer",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,x-opencode-directory",
          },
          signal: AbortSignal.timeout(1000),
        }),
      ),
    )
    for (const response of early) {
      expect(response.status).toBe(204)
      expect(response.headers.get("connection")).toBe("close")
      expect(response.headers.get("access-control-allow-origin")).toBe("oc://renderer")
      expect(response.headers.get("access-control-allow-headers")).toBe("authorization,x-opencode-directory")
      expect(response.headers.get("access-control-allow-methods")).toContain("GET")
      await response.text()
    }
    const starting = await fetch(url, { headers: { Origin: "oc://renderer" }, signal: AbortSignal.timeout(1000) })
    expect(starting.status).toBe(503)
    expect(starting.headers.get("retry-after")).toBe("1")
    expect(starting.headers.get("access-control-allow-origin")).toBe("oc://renderer")
    expect(await starting.text()).toBe("Server is starting")
    const denied = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "https://untrusted.invalid", "Access-Control-Request-Method": "POST" },
      signal: AbortSignal.timeout(1000),
    })
    expect(denied.status).toBe(403)
    expect(denied.headers.get("access-control-allow-origin")).toBeNull()
    await denied.text()
    const configured = await fetch(url, {
      method: "OPTIONS",
      headers: { Origin: "https://trusted.example", "Access-Control-Request-Method": "POST" },
      signal: AbortSignal.timeout(1000),
    })
    expect(configured.status).toBe(204)
    expect(configured.headers.get("access-control-allow-origin")).toBe("https://trusted.example")
    await configured.text()
    const rebound = await fetch(url, {
      headers: { Host: "untrusted.invalid", Origin: "oc://renderer" },
      signal: AbortSignal.timeout(1000),
    })
    expect(rebound.status).toBe(403)
    expect(rebound.headers.get("access-control-allow-origin")).toBeNull()
    await rebound.text()
    server.on("request", (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ healthy: true }))
    })
    const ready = await fetch(url, { signal: AbortSignal.timeout(1000) })
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({ healthy: true })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
  }
})
