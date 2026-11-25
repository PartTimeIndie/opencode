import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Layer } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"

for (const enabled of [false, true]) test(`standalone routes bind activity and tools, not legacy orchestration (enabled=${enabled})`, async () => {
  if (process.env.OPENCODE_STANDALONE_ROUTES_TEST === "1") return probe()
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-standalone-routes-"))
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", `enabled=${enabled}`], {
    cwd: root,
    env: {
      ...process.env,
      OPENCODE_STANDALONE_ROUTES_TEST: "1",
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: path.join(root, "test.db"),
      OPENCODE_CONFIG_DIR: path.join(root, "config"),
      OPENCODE_CONFIG: "",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ experimental: { session_orchestrator: enabled } }),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DEFER_BACKGROUND_STARTUP: "1",
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => child.kill(), 60_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(timeout)
    await rm(root, { recursive: true, force: true })
  }
}, 65_000)

async function probe() {
  const { Database } = await import("bun:sqlite")
  const { Credential } = await import("@opencode-ai/core/credential")
  const { LocationServiceMap } = await import("@opencode-ai/core/location-layer")
  const { PermissionSaved } = await import("@opencode-ai/core/permission/saved")
  const { createRoutes } = await import("../src/routes")
  // HttpRouter.serve exposes per-request requirements that a layer-only check misses.
  const services = Layer.mergeAll(Credential.defaultLayer, LocationServiceMap.layer, PermissionSaved.defaultLayer)
  const served: Layer.Layer<never, unknown, HttpServer.HttpServer> = HttpRouter.serve(
    createRoutes("fixture-password"),
  ).pipe(Layer.provide(services), Layer.provide(HttpServer.layerServices))
  expect(served).toBeDefined()
  const server = HttpRouter.toWebHandler(
    createRoutes("fixture-password").pipe(Layer.provideMerge(services), Layer.provide(HttpServer.layerServices)),
    {
      disableLogger: true,
    },
  )
  const request = (url: string, method = "GET", body?: unknown, authenticated = true) =>
    server.handler(
      new Request(`http://localhost${url}`, {
        method,
        headers: {
          ...(authenticated ? { authorization: `Basic ${btoa("opencode:fixture-password")}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  try {
    const projects = []
    for (const name of ["first", "second"]) {
      const directory = path.join(process.cwd(), name)
      await mkdir(directory)
      for (const args of [
        ["init", "--quiet"],
        ["remote", "add", "origin", `https://example.test/${name}.git`],
      ]) {
        const git = Bun.spawn(["git", ...args], { cwd: directory, stdout: "ignore", stderr: "pipe" })
        expect(await git.exited, await new Response(git.stderr).text()).toBe(0)
      }
      const query = `?location[directory]=${encodeURIComponent(directory)}`
      const response = await request(`/api/location${query}`)
      expect(response.status, await response.clone().text()).toBe(200)
      const location = await response.json()
      projects.push({ directory, query, id: location.project.id as string })
    }
    expect(projects[0].id).not.toBe(projects[1].id)
    using db = new Database(process.env.OPENCODE_DB!)
    const now = Date.now()
    for (const [index, project] of projects.entries()) {
      db.query(
        "INSERT OR IGNORE INTO project(id,worktree,sandboxes,time_created,time_updated) VALUES(?,?,'[]',?,?)",
      ).run(project.id, project.directory, now, now)
      db.query(
        "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,'test',?,?)",
      ).run(`ses_routes_${index}`, project.id, `routes-${index}`, project.directory, "Route fixture", now, now)
      db.query(
        "INSERT INTO surface_tool(id,scope,scope_key,project_id,directory,mode,surface,time_created,time_updated) VALUES(?,'project',?,?,?,'passive',?,?,?)",
      ).run(
        `sft_routes_${index}`,
        project.id,
        project.id,
        project.directory,
        JSON.stringify({ version: 1, controlID: `routes-${index}`, controls: [], markdown: "Fixture" }),
        now,
        now,
      )
    }
    const activity = await request("/api/session/ses_routes_0/activity")
    expect(activity.status, await activity.clone().text()).toBe(200)
    expect(await activity.json()).toEqual({ data: { type: "idle" } })
    db.query(
      "INSERT INTO session_activity(id,session_id,status,kind,recovery_attempts,opened_seq,closed_seq,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run("act_routes_interrupted", "ses_routes_0", "interrupted", "prompt", 0, 1, 2, now, now)
    const terminalActivity = await request("/api/session/ses_routes_0/activity")
    expect(terminalActivity.status, await terminalActivity.clone().text()).toBe(200)
    expect(await terminalActivity.json()).toEqual({
      data: { type: "idle", activityID: "act_routes_interrupted", activityStatus: "interrupted" },
    })
    // Session linking is supplied by plugins through the generic services route.
    expect((await request("/api/session/ses_routes_0/voice")).status).toBe(404)
    for (const [suffix, method, body] of [
      ["/state", "PATCH", { expectedRevision: 1, values: { changed: true } }],
      ["/visibility", "PATCH", { hidden: true }],
      ["", "DELETE", undefined],
    ] as const) {
      const url = `/api/surface/tool/sft_routes_0${suffix}`
      expect((await request(url + projects[0].query, method, body, false)).status).toBe(401)
      expect((await request(url + projects[1].query, method, body)).status).toBe(404)
      const result = await request(url + projects[0].query, method, body)
      expect(result.status, await result.clone().text()).toBe(method === "DELETE" ? 204 : 200)
      if (suffix === "/state") {
        expect((await result.json()).state).toEqual({ version: 1, revision: 2, values: { changed: true } })
        expect((await request(url + projects[0].query, method, body)).status).toBe(409)
      }
      if (suffix === "/visibility") expect((await result.json()).hidden).toBe(true)
    }
    expect(db.query("SELECT id FROM surface_tool ORDER BY id").all()).toEqual([{ id: "sft_routes_1" }])
    const base = "/api/session/ses_routes_0/orchestrator"
    // Old configuration cannot restore the removed execution/control API.
    for (const [suffix, method] of [["", "GET"], ["", "PUT"], ["/operate", "POST"],
      ["/control", "POST"], ["/retire", "POST"]] as const) {
      const result = await request(base + suffix, method, method === "GET" ? undefined : { expectedRevision: 0 })
      expect(result.status, await result.clone().text()).toBe(404)
    }
    expect(db.query("SELECT * FROM session_orchestrator").all()).toEqual([])
  } finally {
    await server.dispose()
  }
}
