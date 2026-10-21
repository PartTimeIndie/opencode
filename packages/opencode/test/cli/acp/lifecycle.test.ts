import { describe, expect } from "bun:test"
import type {
  CloseSessionResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  PromptResponse,
  ResumeSessionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import { Duration, Effect } from "effect"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { expectOk, selectConfigOption } from "./acp-test-client"
import { createAcpClient, initialize, newSession, verifierConfig } from "./helpers"

describe("opencode acp lifecycle subprocess", () => {
  cliIt.live(
    "stdin EOF exits cleanly",
    ({ opencode }) =>
      Effect.gen(function* () {
        const acp = yield* opencode.acp()
        acp.close()

        const code = yield* Effect.promise(() => acp.exited).pipe(Effect.timeout(Duration.seconds(5)))
        expect(code).toBe(0)
      }),
    60_000,
  )

  cliIt.live(
    "close capability and close request",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.sessionCapabilities?.close).toEqual({})

        const session = yield* newSession(acp, home)
        expectOk(yield* acp.request<CloseSessionResponse>("session/close", { sessionId: session.sessionId }))
      }),
    60_000,
  )

  cliIt.live(
    "loadSession capability and load request return session config options",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        const initialized = yield* initialize(acp)
        expect(initialized.agentCapabilities?.loadSession).toBe(true)
        const session = yield* newSession(acp, home)
        const loaded = expectOk(
          yield* acp.request<LoadSessionResponse>("session/load", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(loaded.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )

  cliIt.live(
    "list request includes a live ACP-created session",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const listed = expectOk(yield* acp.request<ListSessionsResponse>("session/list", { cwd: home }))

        expect(listed.sessions.some((item) => item.sessionId === session.sessionId)).toBe(true)
      }),
    60_000,
  )

  cliIt.live(
    "reload slash command refreshes available commands",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)

        const response = expectOk(
          yield* acp.request<PromptResponse>("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "/reload" }],
          }),
        )
        expect(response.stopReason).toBe("end_turn")
      }),
    60_000,
  )

  cliIt.live(
    "reload watcher refreshes available commands after command edit",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const commandDir = path.join(home, ".config", "opencode", "command")
        yield* Effect.promise(() => mkdir(commandDir, { recursive: true }))
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)

        yield* Effect.promise(() =>
          Bun.write(
            path.join(commandDir, "watcher-cmd.md"),
            `---
description: Watcher command
---
Watcher command template`,
          ),
        )
        const update = yield* acp.waitForNotification<SessionNotification>(
          "session/update",
          (params) =>
            params.sessionId === session.sessionId &&
            params.update.sessionUpdate === "available_commands_update" &&
            params.update.availableCommands.some((command) => command.name === "watcher-cmd"),
        )

        expect(update.params?.sessionId).toBe(session.sessionId)
      }),
    60_000,
  )

  cliIt.live(
    "resume capability advertisement",
    ({ opencode }) =>
      Effect.gen(function* () {
        const initialized = yield* initialize(yield* createAcpClient({ opencode }))

        expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toEqual({})
      }),
    60_000,
  )

  cliIt.live(
    "resume request returns session config options",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const acp = yield* createAcpClient(
          { opencode },
          { OPENCODE_CONFIG_CONTENT: JSON.stringify(verifierConfig(llm.url)) },
        )
        yield* initialize(acp)
        const session = yield* newSession(acp, home)
        const resumed = expectOk(
          yield* acp.request<ResumeSessionResponse>("session/resume", {
            cwd: home,
            sessionId: session.sessionId,
            mcpServers: [],
          }),
        )

        expect(selectConfigOption(resumed.configOptions, "model")?.category).toBe("model")
      }),
    60_000,
  )
})
