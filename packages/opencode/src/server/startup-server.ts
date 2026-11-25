import { createServer } from "node:http"
import { isAllowedCorsOrigin, isAllowedRequestHost, type CorsOptions } from "@opencode-ai/server/cors"

export function createStartupServer(options?: CorsOptions) {
  const server = createServer((request, response) => {
    // The HTTP layer binds before the route graph finishes loading. Without
    // a response, early preflights occupy Chromium's entire connection pool.
    if (server.listenerCount("request") > 1) return
    if (!isAllowedRequestHost(request.headers.host, options) || !isAllowedCorsOrigin(request.headers.origin, options)) {
      response.writeHead(403, { Connection: "close" })
      response.end()
      return
    }
    response.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
    if (request.headers.origin) response.setHeader("Access-Control-Allow-Origin", request.headers.origin)
    if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
      response.writeHead(204, {
        Connection: "close",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": request.headers["access-control-request-headers"] ?? "",
      })
      response.end()
      return
    }
    response.writeHead(503, { Connection: "close", "Retry-After": "1" })
    response.end("Server is starting")
  })
  return server
}
