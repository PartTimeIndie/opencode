import { app, utilityProcess } from "electron"
import { mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { createServer } from "node:net"
import { join, resolve, isAbsolute } from "node:path"

const deadlineAt = Date.now() + 90_000
void main().catch(error => { console.error(error); app.exit(1) })

async function main() {
  const root = process.env.OPENCODE_PLUGIN_SMOKE_WORKSPACE
  if (!root || !isAbsolute(root)) throw new Error("The launcher must provide an absolute smoke workspace")
  let child
  let exited = false
  let exit

  try {
    const callerDirectory = join(root, ".opencode", "plugins", "service-caller")
    await mkdir(callerDirectory, { recursive: true })
    await writeFile(join(root, ".opencode", "app.jsonc"), JSON.stringify({ plugin: ["./plugins/service-caller"] }))
    await writeFile(join(callerDirectory, "package.json"), JSON.stringify({ name: "service-caller", version: "1.0.0", type: "module",
      exports: { "./app": "./index.js" }, opencode: { api: { app: 2 }, app: { capabilities: ["services:neutral-service:echo"] } } }))
    await writeFile(join(callerDirectory, "index.js"), "export default { id: 'service-caller', app() {} }")
    const serverPlugin = join(root, "neutral-service.mjs")
    await writeFile(serverPlugin, `export default { id: "neutral-service", async server(api) {
      const schema = { "~standard": { version: 1, vendor: "smoke", validate: value => ({ value }) } };
      api.services.register({ id: "echo", version: 1, input: schema, output: schema,
        execute(value, context) { return { value, owner: context.pluginID, caller: context.callerPluginID, directory: context.directory, bun: typeof Bun }; } });
      return {};
    } }`)
    await writeFile(join(root, "opencode.json"), JSON.stringify({ plugin: [pathToFileURL(serverPlugin).href] }))
    if (globalThis.Bun !== undefined) throw new Error("Electron utility-process smoke must not expose global Bun")
    await phase(app.whenReady(), "Electron app readiness", 10_000)
    console.log("plugin services sidecar smoke: Electron ready")

    const probe = createServer()
    await phase(new Promise((done, reject) => {
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", done)
    }), "port reservation", 5_000)
    const address = probe.address()
    if (!address || typeof address === "string") throw new Error("Could not reserve a Plugin Services smoke port")
    await phase(new Promise((done, reject) => probe.close((error) => error ? reject(error) : done())), "port release", 5_000)

    const env = Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, String(value)]]),
    )
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === "path") delete env[key]
    }
    delete env.OPENCODE_CONFIG_CONTENT
    delete env.OPENCODE_CONFIG_DIR
    delete env.OPENCODE_PURE
    Object.assign(env, {
      PATH: root,
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      OPENCODE_CONFIG: join(root, "opencode.json"),
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENCODE_PROVIDER_PLUGIN_DIR: join(root, "plugin-packages", "provider"),
      OPENCODE_TUI_PLUGIN_DIR: join(root, "plugin-packages", "tui"),
      OPENCODE_DISABLE_CHANNEL_DB: "1",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    })

    child = utilityProcess.fork(resolve("out/main/sidecar.js"), [], {
      cwd: root,
      env,
      serviceName: "opencode plugin services smoke",
      stdio: "pipe",
    })
    const output = { stdout: "", stderr: "" }
    child.stdout?.on("data", (chunk) => output.stdout += chunk.toString("utf8"))
    child.stderr?.on("data", (chunk) => output.stderr += chunk.toString("utf8"))

    let readyResolve
    let readyReject
    let stoppedResolve
    const ready = new Promise((done, reject) => {
      readyResolve = done
      readyReject = reject
    })
    const stopped = new Promise((done) => stoppedResolve = done)
    exit = new Promise((done) => child.once("exit", (code) => {
      exited = true
      done(code)
    }))
    child.on("message", (message) => {
      if (message.type === "ready") readyResolve()
      if (message.type === "stopped") stoppedResolve()
      if (message.type === "error") {
        const error = new Error(message.error.message)
        if (message.error.stack) error.stack = message.error.stack
        readyReject(error)
      }
    })
    child.postMessage({
      type: "start",
      hostname: "127.0.0.1",
      port: address.port,
      password: "plugin-services-smoke",
      userDataPath: root,
    })

    await phase(Promise.race([
      ready,
      exit.then((code) => { throw new Error(`Sidecar exited before ready with code ${code}: ${output.stderr}`) }),
    ]), "utility-process readiness", 60_000)
    console.log("plugin services sidecar smoke: utility process ready")
    const base = `http://127.0.0.1:${address.port}`
    const headers = { authorization: `Basic ${Buffer.from("opencode:plugin-services-smoke").toString("base64")}`, "content-type": "application/json" }
    for (const endpoint of ["/provider", "/api/provider"]) {
      const providers = await phase(fetch(`${base}${endpoint}?directory=${encodeURIComponent(root)}`, { headers, signal: AbortSignal.timeout(10_000) }), `Detached ${endpoint}`, 10_000)
      if (!providers.ok) throw new Error(`Detached provider registry ${endpoint} returned HTTP ${providers.status}: ${await providers.text()}`)
      await providers.json()
    }
    const manifest = await phase(fetch(`${base}/app/plugins?directory=${encodeURIComponent(root)}`, { headers }).then(response => response.json()), "Plugin manifest", 10_000)
    const caller = manifest.plugins.find(plugin => plugin.id === "service-caller")
    if (!caller) throw new Error("Neutral app plugin did not load")
    const requestDeadline = Date.now() + 10_000
    let response
    let body
    for (;;) {
      response = await phase(fetch(`${base}/plugins/neutral-service/services/echo?directory=${encodeURIComponent(root)}`, {
        method: "POST", headers,
        body: JSON.stringify({ caller: { id: caller.id, version: caller.version, hash: caller.hash }, version: 1, input: "node-service-probe" }),
        signal: AbortSignal.timeout(10_000),
      }), "Plugin Services request", 10_000)
      body = await response.json()
      if (response.status !== 503 || Date.now() >= requestDeadline) break
      await delay(250)
    }
    if (response.status !== 200) throw new Error(`Plugin Services smoke returned HTTP ${response.status}: ${JSON.stringify(body)}`)
    if (
      body?.ok !== true
      || body.data?.value !== "node-service-probe"
      || body.data?.owner !== "neutral-service"
      || body.data?.caller !== "service-caller"
      || body.data?.bun !== "undefined"
    ) throw new Error(`Plugin Services smoke returned an invalid inventory payload: ${JSON.stringify(body)}`)
    if (JSON.stringify(body).includes("Bun is not defined")) throw new Error("Plugin Services smoke reached a Bun-only global")

    child.postMessage({ type: "stop" })
    await phase(Promise.race([stopped, exit]), "utility-process stop", 5_000)
    console.log(`verified built Electron utility-process Plugin Services endpoint on port ${address.port}`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    if (child && !exited) child.kill()
    if (exit && !exited) await Promise.race([exit, delay(5_000)])
    // The launcher removes the workspace after Electron exits and releases its handles.
    app.exit(process.exitCode ?? 0)
  }
}

function phase(promise, label, maximumMs) {
  const timeoutMs = Math.max(1, Math.min(maximumMs, deadlineAt - Date.now()))
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => { throw new Error(`${label} timed out after ${timeoutMs}ms`) }),
  ])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
