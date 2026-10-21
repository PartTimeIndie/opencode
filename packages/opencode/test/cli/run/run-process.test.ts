// Subprocess integration tests for `opencode run` (non-interactive mode).
// These exercise the real CLI binary against a TestLLMServer running in the
// same process. See `test/lib/cli-process.ts` for the harness — each test uses
// `opencode.run(message, opts?)` to spawn `bun src/index.ts run ...` with
// `OPENCODE_CONFIG_CONTENT` providing the test provider config inline.
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Duration, Effect } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { cliIt, removeTempDirectory } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"

test("retries delayed Windows temp cleanup locks and preserves terminal errors", async () => {
  let now = 0
  let attempts = 0
  const delays: number[] = []

  await Effect.runPromise(
    removeTempDirectory("fixture", {
      platform: "win32",
      maxDurationMs: 1_000,
      now: () => now,
      remove: async () => {
        attempts += 1
        if (attempts < 4) {
          throw Object.assign(new Error("fixture directory is busy"), {
            code: attempts % 2 === 1 ? "EBUSY" : "EPERM",
          })
        }
      },
      sleep: async (durationMs) => {
        delays.push(durationMs)
        now += durationMs
      },
    }),
  )

  expect(attempts).toBe(4)
  expect(delays).toEqual([50, 100, 200])

  let expiredNow = 0
  let expiredAttempts = 0
  const expired = Effect.runPromise(
    removeTempDirectory("fixture", {
      platform: "win32",
      maxDurationMs: 100,
      now: () => expiredNow,
      remove: async () => {
        expiredAttempts += 1
        throw Object.assign(new Error("fixture directory is still busy"), { code: "EBUSY" })
      },
      sleep: async (durationMs) => {
        expiredNow += durationMs
      },
    }),
  )

  await expect(expired).rejects.toMatchObject({ code: "EBUSY" })
  expect(expiredAttempts).toBe(3)
  expect(expiredNow).toBe(100)
})

describe("opencode run (non-interactive subprocess)", () => {
  cliIt.live(
    "keeps its cached response when a foreign prompt finishes before its delayed verdict",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const database = path.join(home, "foreign-after-completion.db")
        yield* llm.pushMatch(
          (hit) => JSON.stringify(hit.body).includes("Evaluate whether the agent has completed all requested work."),
          reply().text("DONE"),
          reply().text("DONE"),
        )
        yield* llm.push(reply().text("OWN_FINAL_RESPONSE"), reply().text("FOREIGN_FINAL_RESPONSE"))
        const server = yield* opencode.serve({
          env: {
            OPENCODE_DB: database,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              session: { turn_completion: { enabled: true, model: "test/test-model" } },
            }),
          },
        })
        const client = createOpencodeClient({ baseUrl: server.url })
        const foreignFinished = Promise.withResolvers<void>()
        let holding = false
        let foreignStarted = false
        let sessionID: string | undefined
        let release: (() => void) | undefined
        const proxy = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              hostname: "127.0.0.1",
              idleTimeout: 0,
              async fetch(request) {
                const url = new URL(request.url)
                const upstream = new Request(new URL(url.pathname + url.search, server.url), request)
                upstream.headers.set("accept-encoding", "identity")
                const response = await fetch(upstream)
                if (
                  url.pathname.endsWith("/message") &&
                  url.searchParams.get("limit") === "20" &&
                  holding &&
                  !foreignStarted
                ) {
                  foreignStarted = true
                  setTimeout(() => {
                    void (async () => {
                      if (!sessionID) throw new Error("Missing own session")
                      const prompted = await client.v2.session.prompt({
                        sessionID,
                        prompt: { text: "Return FOREIGN_FINAL_RESPONSE." },
                      })
                      if (prompted.error) throw new Error(JSON.stringify(prompted.error))
                      const waited = await client.v2.session.wait({ sessionID })
                      if (waited.error) throw new Error(JSON.stringify(waited.error))
                      release?.()
                      foreignFinished.resolve()
                    })().catch(foreignFinished.reject)
                  }, 100)
                }
                if (url.pathname !== "/global/event" || !response.body) return response
                const decoder = new TextDecoder()
                const encoder = new TextEncoder()
                let buffered = ""
                return new Response(
                  response.body.pipeThrough(
                    new TransformStream<Uint8Array, Uint8Array>({
                      transform(chunk, controller) {
                        buffered += decoder.decode(chunk, { stream: true })
                        const frames = buffered.split("\n\n")
                        buffered = frames.pop() ?? ""
                        for (const frame of frames) {
                          if (holding) continue
                          const data = frame.match(/^data: (.+)$/m)?.[1]
                          const event = data
                            ? (JSON.parse(data) as { payload?: { type?: string; properties?: { sessionID?: string } } })
                            : undefined
                          if (event?.payload?.type === "session.turn.completed") {
                            holding = true
                            sessionID = event.payload.properties?.sessionID
                            release = () => controller.enqueue(encoder.encode(frame + "\n\n"))
                            continue
                          }
                          controller.enqueue(encoder.encode(frame + "\n\n"))
                        }
                      },
                    }),
                  ),
                  { headers: response.headers },
                )
              },
            }),
          ),
          (server) => Effect.sync(() => server.stop(true)),
        )
        const result = yield* opencode.spawn(
          [
            "run",
            "--attach",
            proxy.url.href,
            "--model",
            "test/test-model",
            "--format",
            "json",
            "Return OWN_FINAL_RESPONSE.",
          ],
          { timeoutMs: 40_000 },
        )
        yield* Effect.promise(() => foreignFinished.promise)
        opencode.expectExit(result, 0)
        const db = new Database(database, { readonly: true })
        const answers = db.query("SELECT data FROM session_message WHERE type='assistant' ORDER BY seq").all()
        db.close()
        expect(answers).toHaveLength(2)
        expect(JSON.stringify(answers)).toContain("OWN_FINAL_RESPONSE")
        expect(JSON.stringify(answers)).toContain("FOREIGN_FINAL_RESPONSE")
        expect(foreignStarted).toBe(true)
        expect(result.stdout).toContain("OWN_FINAL_RESPONSE")
        expect(result.stdout).not.toContain("FOREIGN_FINAL_RESPONSE")
      }),
    60_000,
  )

  for (const verdict of ["DONE", "INCOMPLETE"] as const) {
    cliIt.live(
      `waits for delayed ${verdict} completion after the actual activity wait has settled`,
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          const database = path.join(home, "delayed-completion.db")
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("Evaluate whether the agent has completed all requested work."),
            ...Array.from({ length: 3 }, () => reply().text(verdict)),
          )
          yield* llm.push(
            ...Array.from({ length: 3 }, (_, i) =>
              reply().text(verdict === "DONE" ? '{"ok":true}' : JSON.stringify({ step: i })),
            ),
          )
          const server = yield* opencode.serve({
            env: {
              OPENCODE_DB: database,
              OPENCODE_DEFER_BACKGROUND_STARTUP: "1",
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...testProviderConfig(llm.url),
                session: { turn_completion: { enabled: true, model: "test/test-model" } },
              }),
            },
          })
          let idleBeforeVerdict = false
          const proxy = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                // Preserve the long SSE/owner wait; EOF has separate probes.
                idleTimeout: 0,
                async fetch(request) {
                  const url = new URL(request.url)
                  const upstream = new Request(new URL(url.pathname + url.search, server.url), request)
                  upstream.headers.set("accept-encoding", "identity")
                  const response = await fetch(upstream)
                  if (url.pathname.endsWith("/wait")) {
                    const db = new Database(database, { readonly: true })
                    const activity = db
                      .query(
                        "SELECT status, turn_completion_result FROM session_activity ORDER BY time_created DESC LIMIT 1",
                      )
                      .get() as { status: string; turn_completion_result: string | null } | null
                    db.close()
                    idleBeforeVerdict ||= activity?.status === "completed" && activity.turn_completion_result === null
                  }
                  return response
                },
              }),
            ),
            (server) => Effect.sync(() => server.stop(true)),
          )
          const result = yield* opencode.spawn(
            [
              "run",
              "--attach",
              proxy.url.href,
              "--model",
              "test/test-model",
              "--format",
              "json",
              'Return exactly {"ok":true}.',
            ],
            // Allow the CLI's 125s terminal wait plus process startup.
            { timeoutMs: 155_000 },
          )
          const db = new Database(database, { readonly: true })
          const activity = db
            .query(
              "SELECT status, turn_completion_result, turn_completion_state FROM session_activity ORDER BY time_created, id",
            )
            .all()
          db.close()
          expect(idleBeforeVerdict).toBe(true)
          expect(activity).toEqual(
            Array.from({ length: verdict === "DONE" ? 1 : 3 }, () => ({
              status: "completed",
              turn_completion_result: verdict.toLowerCase(),
              turn_completion_state: "done",
            })),
          )
          opencode.expectExit(result, verdict === "DONE" ? 0 : 1)
          expect(result.stdout).toContain(verdict === "DONE" ? '{\\"ok\\":true}' : '{\\"step\\":2}')
          const errors = opencode.parseJsonEvents(result.stdout).filter((event) => event.type === "error")
          expect(errors).toHaveLength(verdict === "DONE" ? 0 : 1)
          if (verdict === "INCOMPLETE") {
            expect(JSON.stringify(errors)).toContain("TurnCompletionIncompleteError")
            expect(JSON.stringify(errors)).not.toContain("VerdictUnavailable")
          }
          expect(result.durationMs).toBeGreaterThan(55_000)
        }),
      175_000,
    )
  }

  for (const verdict of ["DONE", "INCOMPLETE"] as const) {
    cliIt.live(
      `uses the final ${verdict} turn verdict for its process exit status`,
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          const database = path.join(home, "completion-verdict.db")
          yield* llm.pushMatch(
            (hit) => JSON.stringify(hit.body).includes("Evaluate whether the agent has completed all requested work."),
            ...Array.from({ length: 3 }, () => reply().text(verdict)),
          )
          yield* llm.pushMatch(
            (hit) => !JSON.stringify(hit.body).includes("Evaluate whether the agent has completed all requested work."),
            ...Array.from({ length: 3 }, () => reply().text('{"ok":true}')),
          )
          const result = yield* opencode.run('Return exactly {"ok":true}.', {
            format: "json",
            timeoutMs: 40_000,
            env: {
              OPENCODE_DB: database,
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...testProviderConfig(llm.url),
                session: { turn_completion: { enabled: true, model: "test/test-model" } },
              }),
            },
          })
          const db = new Database(database, { readonly: true })
          const activities = db
            .query(
              "SELECT status, turn_completion_result, turn_completion_state FROM session_activity ORDER BY time_created, id",
            )
            .all()
          db.close()
          expect(activities).toHaveLength(verdict === "DONE" ? 1 : 3)
          expect(activities).toEqual(
            Array.from({ length: verdict === "DONE" ? 1 : 3 }, () => ({
              status: "completed",
              turn_completion_result: verdict.toLowerCase(),
              turn_completion_state: "done",
            })),
          )
          expect(result.stdout).toContain('{\\"ok\\":true}')
          opencode.expectExit(result, verdict === "DONE" ? 0 : 1)
          const errors = opencode.parseJsonEvents(result.stdout).filter((event) => event.type === "error")
          expect(errors).toHaveLength(verdict === "DONE" ? 0 : 1)
          if (verdict === "INCOMPLETE") expect(JSON.stringify(errors)).toContain("Turn remained incomplete")
        }),
      60_000,
    )
  }

  // Happy path: prompt completes, output reaches stdout, process exits 0.
  // If this fails, all the others likely will too — debug here first.
  cliIt.concurrent(
    "exits 0 and writes the response to stdout on a successful prompt",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("hello from the test llm")
        const result = yield* opencode.run("say hi")
        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("hello from the test llm")
      }),
    60_000,
  )

  cliIt.concurrent(
    "does not abort a valid response at the old fixed 15 second deadline",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.hold("slow response completed", new Promise((resolve) => setTimeout(resolve, 16_000)))
        const result = yield* opencode.run("wait for the slow response", { timeoutMs: 30_000 })
        opencode.expectExit(result, 0)
        expect(result.durationMs).toBeGreaterThan(15_000)
        expect(result.stdout).toContain("slow response completed")
      }),
    45_000,
  )

  cliIt.live(
    "settles the active session when a Windows terminal sends Ctrl-C",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const database = path.join(home, "sigint.db")
        yield* llm.push(reply().text("partial response before interrupt").hang())
        const process = yield* opencode.runPty("hold until interrupted", {
          format: "json",
          env: { OPENCODE_DB: database },
          extraArgs: ["--title", "SIGINT regression"],
        })

        const sessionID = yield* Effect.promise(async () => {
          const deadline = Date.now() + 30_000
          let childExit: { exitCode: number } | undefined
          const childExitPromise = process.exited.then((result) => {
            childExit = result
            return result
          })
          let delay = 50
          while (Date.now() < deadline) {
            if (childExit) {
              throw new Error(
                `run exited before admission with code ${childExit.exitCode}\n${process.output().slice(-2_000)}`,
              )
            }
            if (!(await Bun.file(database).exists())) {
              await Promise.race([Bun.sleep(delay), childExitPromise])
              delay = Math.min(delay * 2, 250)
              continue
            }
            const db = new Database(database, { readonly: true })
            const table = db
              .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_activity'")
              .get()
            const row = table
              ? (db
                  .query(
                    "SELECT a.session_id FROM session_activity a WHERE a.status = 'running' AND EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = a.session_id AND m.type = 'assistant' AND json_extract(m.data, '$.time.completed') IS NULL) ORDER BY a.time_created DESC LIMIT 1",
                  )
                  .get() as { session_id: string } | null)
              : null
            db.close()
            if (row) return row.session_id
            await Promise.race([Bun.sleep(delay), childExitPromise])
            delay = Math.min(delay * 2, 250)
          }
          throw new Error(`run did not enter a running activity within 30s\n${process.output().slice(-2_000)}`)
        })

        process.write("\x03")
        const exit = yield* Effect.promise(() => process.exited).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(15),
            orElse: () => Effect.fail(new Error(`run did not exit after Ctrl-C\n${process.output().slice(-2_000)}`)),
          }),
        )

        const db = new Database(database, { readonly: true })
        const latest = db
          .query("SELECT status, reason FROM session_activity WHERE session_id = ? ORDER BY time_created DESC LIMIT 1")
          .get(sessionID) as { status: string; reason: string | null } | null
        const live = db
          .query(
            "SELECT COUNT(*) AS count FROM session_activity WHERE session_id = ? AND status IN ('running', 'recovering')",
          )
          .get(sessionID) as { count: number }
        const stale = db
          .query("SELECT COUNT(*) AS count FROM session_activity WHERE session_id = ? AND reason = 'stale-lease'")
          .get(sessionID) as { count: number }
        const liveAssistants = db
          .query(
            "SELECT COUNT(*) AS count FROM session_message WHERE session_id = ? AND type = 'assistant' AND json_extract(data, '$.time.completed') IS NULL",
          )
          .get(sessionID) as { count: number }
        db.close()

        expect(latest).toEqual({ status: "interrupted", reason: "user-stop" })
        expect(live.count).toBe(0)
        expect(stale.count).toBe(0)
        expect(liveAssistants.count).toBe(0)
        expect(exit.exitCode).not.toBe(0)
        expect(process.output()).not.toContain('"type":"error"')
      }),
    60_000,
  )

  // Regression for #27371: an unknown model used to hang the process forever
  // waiting on a session.status === idle event that never arrived. The fix
  // makes the SDK call surface an error promptly so the process exits nonzero.
  // We assert nonzero exit AND wall-clock under the harness timeout — a hang
  // would expire the timeout and produce a different (signal-killed) failure.
  cliIt.concurrent(
    "exits nonzero promptly when the model is unknown (regression for #27371)",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.run("say hi", {
          model: "test/nonexistent-model",
          timeoutMs: 30_000,
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.durationMs).toBeLessThan(15_000)
      }),
    30_000,
  )

  // A prompt can be durably accepted before the provider rejects the request.
  // The terminal activity failure must make the CLI fail so
  // CI and review scripts cannot treat a missing model response as success.
  cliIt.concurrent(
    "exits nonzero when the LLM fails after prompt admission",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.pushMatch(
          (hit) => {
            const body = JSON.stringify(hit.body)
            return body.includes("trigger midstream error") && !body.includes("Generate a title for this conversation")
          },
          ...Array.from({ length: 4 }, () =>
            reply().text("partial provider response").pendingTool("bash", { command: "echo incomplete" }).toolCalls(),
          ),
        )
        const result = yield* opencode.run("trigger midstream error", { timeoutMs: 30_000 })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain("Invalid JSON input")
      }),
    60_000,
  )

  cliIt.concurrent(
    "returns a final answer when a bounded reviewer exhausts its tool steps",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("bash", { command: "echo first" }),
          reply().tool("bash", { command: "echo second" }),
        )
        const result = yield* opencode.run("review this bounded change", {
          agent: "bounded-reviewer",
          extraArgs: ["--dangerously-skip-permissions"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: {
                "bounded-reviewer": {
                  mode: "subagent",
                  model: "test/test-model",
                  steps: 2,
                  options: { maxOutputTokens: 4_096 },
                  permission: { "*": "allow" },
                },
              },
            }),
          },
        })

        opencode.expectExit(result, 0, "bounded reviewer")
        expect(result.stderr + result.stdout).not.toContain("StepLimitExceededError")
        expect(result.stdout).toContain("ok")
        expect(yield* llm.calls).toBe(4)
        expect((yield* llm.inputs).filter((input) => input.max_tokens === 4_096)).toHaveLength(3)
      }),
    60_000,
  )

  // --format json puts one JSON object per line on stdout for each emitted
  // event. Consumers (CI scripts, tooling) parse this stream. Asserts the
  // shape so a future event-emit change has to update this expectation.
  cliIt.concurrent(
    "--format json emits parseable line-delimited JSON to stdout",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("structured output")
        const result = yield* opencode.run("say hi", { format: "json" })
        opencode.expectExit(result, 0)

        const events = opencode.parseJsonEvents(result.stdout)
        expect(events.length).toBeGreaterThan(0)
        for (const evt of events) {
          expect(typeof evt.type).toBe("string")
          expect(typeof evt.sessionID).toBe("string")
        }
        // At least one `text` event should appear with the LLM's response.
        const text = events.find((e) => e.type === "text")
        expect(text).toBeDefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "waits for a new assistant response when continuing a session",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const env = { OPENCODE_DB: `${home}/continuation.db` }
        yield* llm.push(reply().tool("bash", { command: "echo historical-tool" }), reply().text("first answer"))
        const first = yield* opencode.run("first prompt", {
          format: "json",
          env,
          extraArgs: ["--dangerously-skip-permissions"],
        })
        opencode.expectExit(first, 0)
        const sessionID = opencode
          .parseJsonEvents(first.stdout)
          .find((event) => typeof event.sessionID === "string")?.sessionID
        expect(typeof sessionID).toBe("string")
        if (typeof sessionID !== "string") return yield* Effect.die("First run did not emit a Session ID")

        const firstToolIDs = opencode
          .parseJsonEvents(first.stdout)
          .filter((event) => event.type === "tool_use")
          .map((event) => (event.part as { id?: unknown } | undefined)?.id)
          .filter((id): id is string => typeof id === "string")
        expect(firstToolIDs).toHaveLength(1)

        yield* llm.push(reply().tool("bash", { command: "echo current-tool" }), reply().text("second answer"))
        const second = yield* opencode.run("second prompt", {
          format: "json",
          env,
          extraArgs: ["--session", sessionID, "--dangerously-skip-permissions"],
        })
        opencode.expectExit(second, 0)
        expect(second.stdout).toContain("second answer")
        expect(second.stdout).not.toContain("first answer")
        const resumedToolIDs = opencode
          .parseJsonEvents(second.stdout)
          .filter((event) => event.type === "tool_use")
          .map((event) => (event.part as { id?: unknown } | undefined)?.id)
          .filter((id): id is string => typeof id === "string")
        expect(resumedToolIDs).toHaveLength(1)
        const resumedToolInputs = opencode
          .parseJsonEvents(second.stdout)
          .filter((event) => event.type === "tool_use")
          .map((event) => (event.part as { state?: { input?: unknown } } | undefined)?.state?.input)
        expect(JSON.stringify(resumedToolInputs)).toContain("current-tool")
        expect(JSON.stringify(resumedToolInputs)).not.toContain("historical-tool")
      }),
    60_000,
  )

  cliIt.live(
    "waits for an attached prompt and emits its final response",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: {
                "attached-reviewer": {
                  mode: "subagent",
                  model: "test/test-model",
                  permission: { "*": "deny" },
                  prompt: "ATTACHED READ-ONLY REVIEWER SENTINEL",
                },
              },
            }),
          },
        })
        yield* llm.hold("attached response completed", new Promise((resolve) => setTimeout(resolve, 1_500)))
        const result = yield* opencode.spawn(
          [
            "run",
            "--attach",
            server.url,
            "--dir",
            home,
            "--model",
            "test/test-model",
            "--agent",
            "attached-reviewer",
            "--format",
            "json",
            "review this change",
          ],
          { timeoutMs: 30_000 },
        )

        opencode.expectExit(result, 0)
        expect(result.durationMs).toBeGreaterThan(1_000)
        expect(result.stdout).toContain("attached response completed")
        expect(JSON.stringify(yield* llm.inputs)).toContain("ATTACHED READ-ONLY REVIEWER SENTINEL")
      }),
    45_000,
  )

  for (const verdict of [undefined, "DONE", "INCOMPLETE"] as const) {
    cliIt.live(
      verdict
        ? `reports missing ${verdict} completion evidence after event-stream EOF`
        : "survives event-stream EOF after progress and recovers the final marked report",
      ({ llm, opencode, home }) =>
        Effect.gen(function* () {
          const database = path.join(home, "eof-verdict.db")
          const server = yield* opencode.serve({
            env: {
              OPENCODE_DB: database,
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...testProviderConfig(llm.url),
                ...(verdict ? { session: { turn_completion: { enabled: true, model: "test/test-model" } } } : {}),
              }),
            },
          })
          const terminal = Promise.withResolvers<void>()
          const final = "CRIKI_FINAL_SIGNAL_BODY_BEGIN\nVerified final report\nCRIKI_FINAL_SIGNAL_BODY_END"
          if (verdict)
            yield* llm.pushMatch(
              (hit) =>
                JSON.stringify(hit.body).includes("Evaluate whether the agent has completed all requested work."),
              ...Array.from({ length: 3 }, () => reply().text(verdict)),
            )
          yield* llm.push(reply().text("working on the task").tool("bash", { command: "echo progress" }))
          yield* llm.hold(final, terminal.promise)
          yield* llm.push(reply().text(final), reply().text(final))
          let disconnected = false
          const proxy = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                async fetch(request) {
                  const url = new URL(request.url)
                  const upstream = new Request(new URL(url.pathname + url.search, server.url), request)
                  upstream.headers.set("accept-encoding", "identity")
                  const response = await fetch(upstream)
                  if (url.pathname !== "/global/event" || !response.body) return response
                  const decoder = new TextDecoder()
                  let received = ""
                  return new Response(
                    response.body.pipeThrough(
                      new TransformStream<Uint8Array, Uint8Array>({
                        transform(chunk, controller) {
                          received += decoder.decode(chunk, { stream: true })
                          controller.enqueue(chunk)
                          if (!received.includes("session.next.text.ended")) return
                          disconnected = true
                          controller.terminate()
                          setTimeout(() => terminal.resolve(), 250)
                        },
                      }),
                    ),
                    { headers: response.headers },
                  )
                },
              }),
            ),
            (proxy) =>
              Effect.sync(() => {
                terminal.resolve()
                proxy.stop(true)
              }),
          )
          const result = yield* opencode.spawn(
            [
              "run",
              "--attach",
              proxy.url.href,
              "--dir",
              home,
              "--model",
              "test/test-model",
              "--format",
              "json",
              "--dangerously-skip-permissions",
              "finish the task after progress",
            ],
            { timeoutMs: 30_000 },
          )
          opencode.expectExit(result, verdict ? 1 : 0)
          expect(disconnected).toBe(true)
          const text = opencode.parseJsonEvents(result.stdout).filter((event) => event.type === "text")
          expect(JSON.stringify(text)).toContain("working on the task")
          expect(JSON.stringify(text)).toContain("CRIKI_FINAL_SIGNAL_BODY_END")
          expect(result.stdout.match(/Verified final report/g)).toHaveLength(1)
          if (verdict) {
            const db = new Database(database, { readonly: true })
            const activity = db
              .query(
                "SELECT turn_completion_state, turn_completion_result FROM session_activity ORDER BY time_created DESC, id DESC LIMIT 1",
              )
              .get()
            db.close()
            expect(activity).toEqual({ turn_completion_state: "done", turn_completion_result: verdict.toLowerCase() })
            expect(result.stdout).toContain("Turn completion verdict unavailable")
            expect(opencode.parseJsonEvents(result.stdout).filter((event) => event.type === "error")).toHaveLength(1)
          }
        }),
      60_000,
    )
  }

  cliIt.live(
    "uses remote agent model routing for attached runs and preserves explicit overrides",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const database = path.join(home, "attach-model-routing.db")
        const provider = testProviderConfig(llm.url).provider.test
        const config = {
          ...testProviderConfig(llm.url),
          model: "test/default-model",
          provider: {
            test: {
              ...provider,
              models: Object.fromEntries(
                ["default-model", "remote-agent-model", "override-model"].map((id) => [
                  id,
                  {
                    ...provider.models["test-model"],
                    id,
                    name: id,
                    variants: { minimal: {}, low: {}, high: {} },
                  },
                ]),
              ),
            },
          },
          model_chains: [
            {
              id: "default",
              name: "Default",
              steps: [
                { providerID: "missing", modelID: "unavailable" },
                { providerID: "test", modelID: "remote-agent-model", variant: "high" },
                { providerID: "test", modelID: "default-model", variant: "minimal" },
              ],
            },
          ],
          default_model_chain: "default",
          agent: {
            build: {
              mode: "primary",
              model: "test/default-model",
              variant: "minimal",
              permission: { "*": "deny" },
              prompt: "ATTACHED DEFAULT AGENT SENTINEL",
            },
            title: {
              mode: "primary",
              model: "test/default-model",
              permission: { "*": "deny" },
            },
            "remote-model-reviewer": {
              mode: "subagent",
              model: "test/remote-agent-model",
              variant: "high",
              permission: { "*": "deny" },
              prompt: "REMOTE AGENT MODEL SENTINEL",
            },
          },
        }
        const server = yield* opencode.serve({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            OPENCODE_DB: database,
          },
        })

        yield* llm.text("attached default response")
        const defaultResult = yield* opencode.spawn(
          [
            "run",
            "--attach",
            server.url,
            "--dir",
            home,
            "--title",
            "Attached default model",
            "--model",
            "test/default-model",
            "--format",
            "json",
            "--",
            "USE ATTACHED DEFAULT MODEL",
          ],
          { timeoutMs: 30_000 },
        )
        opencode.expectExit(defaultResult, 0)

        yield* llm.text("attached remote agent response")
        const agentResult = yield* opencode.spawn(
          [
            "run",
            "--attach",
            server.url,
            "--dir",
            home,
            "--title",
            "Attached remote agent model",
            "--agent",
            "remote-model-reviewer",
            "--format",
            "json",
            "--",
            "USE REMOTE AGENT MODEL",
          ],
          { timeoutMs: 30_000 },
        )
        opencode.expectExit(agentResult, 0)

        yield* llm.text("attached override response")
        const overrideResult = yield* opencode.spawn(
          [
            "run",
            "--attach",
            server.url,
            "--dir",
            home,
            "--title",
            "Attached override model",
            "--agent",
            "remote-model-reviewer",
            "--model",
            "test/override-model",
            "--variant",
            "low",
            "--format",
            "json",
            "--",
            "USE ATTACHED MODEL OVERRIDE",
          ],
          { timeoutMs: 30_000 },
        )
        opencode.expectExit(overrideResult, 0)

        const inputs = yield* llm.inputs
        expect(
          inputs.find(
            (input) =>
              JSON.stringify(input).includes("ATTACHED DEFAULT AGENT SENTINEL") &&
              JSON.stringify(input).includes("USE ATTACHED DEFAULT MODEL"),
          )?.model,
        ).toBe("default-model")
        expect(
          inputs.find(
            (input) =>
              JSON.stringify(input).includes("REMOTE AGENT MODEL SENTINEL") &&
              JSON.stringify(input).includes("USE REMOTE AGENT MODEL"),
          )?.model,
        ).toBe("remote-agent-model")
        expect(
          inputs.find(
            (input) =>
              JSON.stringify(input).includes("REMOTE AGENT MODEL SENTINEL") &&
              JSON.stringify(input).includes("USE ATTACHED MODEL OVERRIDE"),
          )?.model,
        ).toBe("override-model")

        const db = new Database(database, { readonly: true })
        const rows = db.query("SELECT title, agent, model FROM session").all() as Array<{
          title: string
          agent: string
          model: string
        }>
        db.close()
        expect(JSON.parse(rows.find((row) => row.title === "Attached default model")?.model ?? "null")).toEqual({
          id: "default-model",
          providerID: "test",
        })
        expect(JSON.parse(rows.find((row) => row.title === "Attached remote agent model")?.model ?? "null")).toEqual({
          id: "remote-agent-model",
          providerID: "test",
          variant: "high",
          chain: {
            id: "default",
            name: "Default",
            active: 1,
            steps: [
              { id: "unavailable", providerID: "missing" },
              { id: "remote-agent-model", providerID: "test", variant: "high" },
              { id: "default-model", providerID: "test", variant: "minimal" },
            ],
          },
        })
        expect(JSON.parse(rows.find((row) => row.title === "Attached override model")?.model ?? "null")).toEqual({
          id: "override-model",
          providerID: "test",
          variant: "low",
        })
      }),
    90_000,
  )

  cliIt.live(
    "does not treat an attached tool prelude as the final response",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)) },
        })
        yield* llm.push(reply().text("checking with a tool").tool("bash", { command: "echo attached-tool" }))
        yield* llm.hold(
          "attached response finished after the tool",
          new Promise((resolve) => setTimeout(resolve, 1_500)),
        )

        const result = yield* opencode.spawn(
          [
            "run",
            "--attach",
            server.url,
            "--dir",
            home,
            "--model",
            "test/test-model",
            "--dangerously-skip-permissions",
            "--format",
            "json",
            "review the complete response",
          ],
          { timeoutMs: 30_000 },
        )

        opencode.expectExit(result, 0)
        expect(result.durationMs).toBeGreaterThan(1_400)
        expect(result.stdout).toContain("attached response finished after the tool")
      }),
    45_000,
  )

  cliIt.live(
    "attaches to a running server by bare numeric port",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const server = yield* opencode.serve({
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(testProviderConfig(llm.url)) },
        })
        yield* llm.hold("bare numeric port attached response", new Promise((resolve) => setTimeout(resolve, 1_000)))

        const result = yield* opencode.spawn(
          [
            "run",
            "--attach",
            String(server.port),
            "--dir",
            home,
            "--model",
            "test/test-model",
            "--format",
            "json",
            "say hi over a bare numeric port",
          ],
          { timeoutMs: 30_000 },
        )

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("bare numeric port attached response")
      }),
    45_000,
  )

  cliIt.live(
    "fails before session creation when attached config fetch fails",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const marker = "attached-config-exploded"
        const requests: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch(req) {
            requests.push(`${req.method} ${new URL(req.url).pathname}`)
            if (req.method === "GET" && new URL(req.url).pathname === "/config") {
              return new Response(JSON.stringify({ message: marker }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
              })
            }
            return new Response("server default must not be used", { status: 500 })
          },
        })
        try {
          const result = yield* opencode.spawn(
            [
              "run",
              "--attach",
              `http://127.0.0.1:${server.port}`,
              "--dir",
              home,
              "--format",
              "json",
              "do not admit this prompt",
            ],
            { timeoutMs: 30_000 },
          )
          const output = result.stdout + result.stderr
          expect(result.exitCode).not.toBe(0)
          expect(output).toContain(marker)
          expect(requests).toEqual(["GET /config"])
        } finally {
          server.stop()
        }
      }),
    45_000,
  )

  cliIt.live(
    "surfaces the real HTTP error when V2 session creation fails on attach",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const marker = "create-session-exploded"
        const server = Bun.serve({
          port: 0,
          fetch(req) {
            if (req.method === "GET" && new URL(req.url).pathname === "/config") {
              return Response.json({})
            }
            if (req.method === "POST" && new URL(req.url).pathname === "/api/session") {
              return new Response(JSON.stringify({ message: marker }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
              })
            }
            return new Response("not found", { status: 404 })
          },
        })
        try {
          const result = yield* opencode.spawn(
            [
              "run",
              "--attach",
              `http://127.0.0.1:${server.port}`,
              "--dir",
              home,
              "--format",
              "json",
              "create a session against a broken server",
            ],
            { timeoutMs: 30_000 },
          )
          const output = result.stdout + result.stderr
          expect(result.exitCode).not.toBe(0)
          expect(output).toContain(marker)
          expect(output).not.toContain("Session not found")
        } finally {
          server.stop()
        }
      }),
    45_000,
  )

  cliIt.concurrent(
    "persists an explicit title for a V2-created session",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const database = `${home}/title.db`
        yield* llm.text("titled response")
        const result = yield* opencode.run("use the requested title", {
          env: { OPENCODE_DB: database },
          extraArgs: ["--title", "Direct reviewer title"],
        })
        opencode.expectExit(result, 0)

        const db = new Database(database, { readonly: true })
        const row = db.query("SELECT title FROM session ORDER BY time_created DESC LIMIT 1").get() as {
          title: string
        } | null
        db.close()
        expect(row?.title).toBe("Direct reviewer title")
      }),
    60_000,
  )

  cliIt.concurrent(
    "runs an explicitly selected read-only subagent without falling back",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("direct reviewer completed")
        const result = yield* opencode.run("review this change", {
          agent: "direct-reviewer",
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: {
                "direct-reviewer": {
                  mode: "subagent",
                  model: "test/test-model",
                  permission: { "*": "deny" },
                  prompt: "DIRECT READ-ONLY REVIEWER SENTINEL",
                },
              },
            }),
          },
        })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain("direct reviewer completed")
        expect(JSON.stringify(yield* llm.inputs)).toContain("DIRECT READ-ONLY REVIEWER SENTINEL")
      }),
    60_000,
  )

  cliIt.concurrent(
    "uses the configured agent model unless an explicit model overrides it",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const provider = testProviderConfig(llm.url).provider.test
        const config = {
          ...testProviderConfig(llm.url),
          model: "test/default-model",
          provider: {
            test: {
              ...provider,
              models: Object.fromEntries(
                ["default-model", "agent-model", "override-model"].map((id) => [
                  id,
                  {
                    ...provider.models["test-model"],
                    id,
                    name: id,
                    variants: { high: {} },
                  },
                ]),
              ),
            },
          },
          model_chains: [
            {
              id: "default",
              name: "Default",
              steps: [
                { providerID: "missing", modelID: "unavailable" },
                { providerID: "test", modelID: "agent-model", variant: "high" },
                { providerID: "test", modelID: "default-model" },
              ],
            },
          ],
          default_model_chain: "default",
          command: {
            review: {
              template: "USE AGENT CONFIGURED MODEL THROUGH COMMAND",
              agent: "model-reviewer",
            },
            "review-explicit": {
              template: "USE EXPLICIT MODEL THROUGH COMMAND",
              agent: "model-reviewer",
            },
          },
          agent: {
            "model-reviewer": {
              mode: "subagent",
              model: "test/agent-model",
              variant: "high",
              permission: { "*": "deny" },
              prompt: "AGENT MODEL SELECTION SENTINEL",
            },
          },
        }

        yield* llm.text("agent model response")
        const agentResult = yield* opencode.spawn(
          ["run", "--agent", "model-reviewer", "--format", "json", "--", "USE AGENT CONFIGURED MODEL"],
          {
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_DB: path.join(home, "agent-model.db"),
            },
          },
        )
        opencode.expectExit(agentResult, 0)

        yield* llm.text("agent command response")
        const commandResult = yield* opencode.spawn(
          ["run", "--agent", "model-reviewer", "--command", "review", "--format", "json"],
          {
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_DB: path.join(home, "agent-command.db"),
            },
          },
        )
        opencode.expectExit(commandResult, 0)

        yield* llm.text("explicit command model response")
        const explicitCommandResult = yield* opencode.spawn(
          [
            "run",
            "--agent",
            "model-reviewer",
            "--model",
            "test/override-model",
            "--variant",
            "high",
            "--command",
            "review-explicit",
            "--format",
            "json",
            "--",
            "USE EXPLICIT MODEL THROUGH COMMAND",
          ],
          {
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_DB: path.join(home, "explicit-command.db"),
            },
          },
        )
        opencode.expectExit(explicitCommandResult, 0)

        yield* llm.text("override model response")
        const overrideResult = yield* opencode.spawn(
          [
            "run",
            "--agent",
            "model-reviewer",
            "--model",
            "test/override-model",
            "--format",
            "json",
            "--",
            "USE EXPLICIT MODEL OVERRIDE",
          ],
          {
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_DB: path.join(home, "override-model.db"),
            },
          },
        )
        opencode.expectExit(overrideResult, 0)

        const unavailableDatabase = path.join(home, "unavailable-chain.db")
        const unavailableResult = yield* opencode.spawn(
          ["run", "--agent", "model-reviewer", "--format", "json", "CHAIN MUST BE UNAVAILABLE"],
          {
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify({
                ...config,
                provider: {
                  test: {
                    ...provider,
                    models: { "override-model": config.provider.test.models["override-model"] },
                  },
                },
              }),
              OPENCODE_DB: unavailableDatabase,
            },
          },
        )
        expect(unavailableResult.exitCode).not.toBe(0)
        expect(unavailableResult.stdout + unavailableResult.stderr).toContain("chain-unavailable")

        const inputs = yield* llm.inputs
        expect(
          inputs.find(
            (input) =>
              JSON.stringify(input).includes("AGENT MODEL SELECTION SENTINEL") &&
              JSON.stringify(input).includes("USE AGENT CONFIGURED MODEL"),
          )?.model,
        ).toBe("agent-model")
        expect(
          inputs.find(
            (input) =>
              JSON.stringify(input).includes("AGENT MODEL SELECTION SENTINEL") &&
              JSON.stringify(input).includes("USE EXPLICIT MODEL OVERRIDE"),
          )?.model,
        ).toBe("override-model")
        expect(
          inputs.find((input) => JSON.stringify(input).includes("USE EXPLICIT MODEL THROUGH COMMAND"))?.model,
        ).toBe("override-model")

        const agentDb = new Database(path.join(home, "agent-model.db"), { readonly: true })
        const agentRow = agentDb.query("SELECT agent, model FROM session ORDER BY time_created DESC LIMIT 1").get() as {
          agent: string
          model: string
        } | null
        agentDb.close()
        expect(agentRow?.agent).toBe("model-reviewer")
        expect(JSON.parse(agentRow?.model ?? "null")).toEqual({
          id: "agent-model",
          providerID: "test",
          variant: "high",
          chain: {
            id: "default",
            name: "Default",
            active: 1,
            steps: [
              { id: "unavailable", providerID: "missing" },
              { id: "agent-model", providerID: "test", variant: "high" },
              { id: "default-model", providerID: "test" },
            ],
          },
        })
        const commandDb = new Database(path.join(home, "agent-command.db"), { readonly: true })
        const commandRow = commandDb.query("SELECT model FROM session ORDER BY time_created DESC LIMIT 1").get() as {
          model: string
        } | null
        commandDb.close()
        expect(JSON.parse(commandRow?.model ?? "null")).toMatchObject({
          id: "agent-model",
          providerID: "test",
          variant: "high",
        })
        const explicitCommandDb = new Database(path.join(home, "explicit-command.db"), { readonly: true })
        const explicitCommandSession = explicitCommandDb
          .query("SELECT id, model FROM session ORDER BY time_created DESC LIMIT 1")
          .get() as { id: string; model: string } | null
        const explicitCommandInput = explicitCommandSession
          ? (explicitCommandDb
              .query(
                "SELECT prompt FROM session_input WHERE session_id = ? AND json_extract(prompt, '$.text') LIKE '%USE EXPLICIT MODEL THROUGH COMMAND%' LIMIT 1",
              )
              .get(explicitCommandSession.id) as { prompt: string } | null)
          : null
        explicitCommandDb.close()
        expect(JSON.parse(explicitCommandSession?.model ?? "null")).toMatchObject({
          id: "override-model",
          providerID: "test",
          variant: "high",
        })
        expect(JSON.parse(explicitCommandInput?.prompt ?? "null")).toMatchObject({
          model: {
            id: "override-model",
            providerID: "test",
            variant: "high",
          },
        })
        const unavailableDb = new Database(unavailableDatabase, { readonly: true })
        const unavailableSessions = unavailableDb.query("SELECT COUNT(*) AS count FROM session").get() as {
          count: number
        }
        unavailableDb.close()
        expect(unavailableSessions.count).toBe(0)
      }),
    60_000,
  )

  cliIt.concurrent(
    "resolves a local agent from the --dir workspace instance",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const directory = path.join(home, "target-workspace")
        const database = path.join(home, "target-workspace.db")
        const provider = testProviderConfig(llm.url).provider.test
        const config = {
          ...testProviderConfig(llm.url),
          model_chains: [
            {
              id: "workspace",
              name: "Workspace",
              steps: [{ providerID: "test", modelID: "target-agent-model", variant: "high" }],
            },
          ],
          default_model_chain: "workspace",
          provider: {
            test: {
              ...provider,
              models: Object.fromEntries(
                ["root-agent-model", "target-agent-model"].map((id) => [
                  id,
                  {
                    ...provider.models["test-model"],
                    id,
                    name: id,
                    variants: { high: {} },
                  },
                ]),
              ),
            },
          },
        }
        yield* Effect.promise(async () => {
          const initialized = Bun.spawnSync(["git", "init", "--quiet", home])
          if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
          await mkdir(directory, { recursive: true })
          await Bun.write(
            path.join(home, "opencode.json"),
            JSON.stringify({
              agent: {
                "workspace-reviewer": {
                  mode: "subagent",
                  model: "test/root-agent-model",
                  variant: "low",
                  permission: { "*": "deny" },
                  prompt: "ROOT WORKSPACE AGENT SENTINEL",
                },
              },
            }),
          )
          await Bun.write(
            path.join(directory, "opencode.json"),
            JSON.stringify({
              agent: {
                "workspace-reviewer": {
                  mode: "subagent",
                  model: "test/target-agent-model",
                  variant: "high",
                  permission: { "*": "deny" },
                  prompt: "TARGET WORKSPACE AGENT SENTINEL",
                },
              },
            }),
          )
        })

        yield* llm.text("target workspace response")
        const result = yield* opencode.spawn(
          [
            "run",
            "--dir",
            directory,
            "--agent",
            "workspace-reviewer",
            "--format",
            "json",
            "--",
            "USE TARGET WORKSPACE AGENT",
          ],
          {
            env: {
              OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
              OPENCODE_DB: database,
              OPENCODE_DISABLE_PROJECT_CONFIG: "0",
            },
          },
        )
        opencode.expectExit(result, 0)

        const input = (yield* llm.inputs).find(
          (item) =>
            JSON.stringify(item).includes("TARGET WORKSPACE AGENT SENTINEL") &&
            JSON.stringify(item).includes("USE TARGET WORKSPACE AGENT"),
        )
        expect(input?.model).toBe("target-agent-model")
        expect(JSON.stringify(input)).toContain("TARGET WORKSPACE AGENT SENTINEL")
        expect(JSON.stringify(input)).not.toContain("ROOT WORKSPACE AGENT SENTINEL")

        const db = new Database(database, { readonly: true })
        const row = db
          .query("SELECT directory, agent, model FROM session ORDER BY time_created DESC LIMIT 1")
          .get() as { directory: string; agent: string; model: string } | null
        db.close()
        expect(row?.directory).toBe(directory.replaceAll("\\", "/"))
        expect(row?.agent).toBe("workspace-reviewer")
        expect(JSON.parse(row?.model ?? "null")).toEqual({
          id: "target-agent-model",
          providerID: "test",
          variant: "high",
          chain: {
            id: "workspace",
            name: "Workspace",
            active: 0,
            steps: [{ id: "target-agent-model", providerID: "test", variant: "high" }],
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "keeps reviewer flags before the separator and treats a leading-dash prompt as message text",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const directory = path.join(home, "review workspace with spaces")
        const database = path.join(home, "reviewer-argv.db")
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))
        yield* llm.text("reviewer argv completed")
        const result = yield* opencode.run("--review this complete change", {
          agent: "direct-reviewer",
          variant: "high",
          directory,
          format: "json",
          env: {
            OPENCODE_DB: database,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: {
                "direct-reviewer": {
                  mode: "subagent",
                  model: "test/test-model",
                  permission: { "*": "deny" },
                  prompt: "DIRECT REVIEWER ARGV SENTINEL",
                },
              },
            }),
          },
        })

        opencode.expectExit(result, 0)
        expect(JSON.stringify(yield* llm.inputs)).toContain("--review this complete change")
        const db = new Database(database, { readonly: true })
        const row = db
          .query("SELECT directory, agent, model FROM session ORDER BY time_created DESC LIMIT 1")
          .get() as { directory: string; agent: string; model: string } | null
        db.close()
        expect(row?.directory).toBe(directory.replaceAll("\\", "/"))
        expect(row?.agent).toBe("direct-reviewer")
        expect(JSON.parse(row?.model ?? "null")).toEqual({ id: "test-model", providerID: "test", variant: "high" })
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails an unknown explicit agent and disposes its instance",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("must remain unused")
        const result = yield* opencode.run("review this change", { agent: "missing-reviewer", printLogs: true })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain('agent "missing-reviewer" not found')
        expect(result.stderr + result.stdout).toContain("disposing instance")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails an interactive subagent and disposes its instance",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("must remain unused")
        const result = yield* opencode.run("review this change", {
          agent: "interactive-reviewer",
          printLogs: true,
          extraArgs: ["--interactive"],
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              agent: {
                "interactive-reviewer": {
                  mode: "subagent",
                  model: "test/test-model",
                  permission: { "*": "deny" },
                  prompt: "INTERACTIVE SUBAGENT MUST NOT RUN",
                },
              },
            }),
          },
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr + result.stdout).toContain(
          'agent "interactive-reviewer" is a subagent and cannot be used in interactive mode',
        )
        expect(result.stderr + result.stdout).toContain("disposing instance")
        expect(yield* llm.calls).toBe(0)
      }),
    60_000,
  )
})
