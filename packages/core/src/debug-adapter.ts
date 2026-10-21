export * as DebugAdapter from "./debug-adapter"

import { Buffer } from "buffer"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"

export class Error extends Schema.TaggedErrorClass<Error>()("DebugAdapter.Error", {
  message: Schema.String,
}) {}

export const Mode = Schema.Literals(["launch", "attach"])
export type Mode = typeof Mode.Type

export interface Interface {
  readonly start: (input: {
    readonly adapter: string
    readonly mode: Mode
    readonly arguments: Readonly<Record<string, unknown>>
  }) => Effect.Effect<{ readonly session: string; readonly capabilities: unknown }, Error>
  readonly request: (input: {
    readonly session: string
    readonly command: string
    readonly arguments?: Readonly<Record<string, unknown>>
  }) => Effect.Effect<unknown, Error>
  readonly events: (session: string) => Effect.Effect<readonly unknown[], Error>
  readonly disconnect: (session: string) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DebugAdapter") {}

type Message = Record<string, unknown>
type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: globalThis.Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}
class Client {
  readonly pending = new Map<number, Pending>()
  readonly received: unknown[] = []
  readonly process: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  seq = 1
  closed = false

  constructor(
    command: readonly string[],
    env: Readonly<Record<string, string>> | undefined,
    readonly mode: Mode,
  ) {
    const [executable, ...args] = command
    if (!executable) throw new globalThis.Error("Debug adapter command is empty")
    const proc = spawn(executable, args, {
      env: { ...globalThis.process.env, ...env },
      windowsHide: true,
    })
    this.process = proc
    const processExit = new Promise<void>((resolve, reject) => {
      proc.once("exit", () => resolve())
      proc.once("error", reject)
    })
    this.exited = Promise.all([this.read(), this.drainStderr(), processExit]).then(() => undefined)
    void this.exited.finally(() => this.close(new globalThis.Error("Debug adapter exited")))
  }

  async request(command: string, args: Readonly<Record<string, unknown>> = {}) {
    if (this.closed) throw new globalThis.Error("Debug adapter session is closed")
    const seq = this.seq++
    const message = Buffer.from(JSON.stringify({ seq, type: "request", command, arguments: args }))
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new globalThis.Error(`Debug adapter request timed out: ${command}`))
      }, 15_000)
      this.pending.set(seq, { resolve, reject, timer })
    })
    await new Promise<void>((resolve, reject) =>
      this.process.stdin.write(
        Buffer.concat([Buffer.from(`Content-Length: ${message.length}\r\n\r\n`), message]),
        (error) => (error ? reject(error) : resolve()),
      ),
    )
    return result
  }

  async stop() {
    if (this.closed) return
    await this.request("disconnect", {
      restart: false,
      terminateDebuggee: this.mode === "launch",
      suspendDebuggee: false,
    }).catch(() => undefined)
    this.close(new globalThis.Error("Debug adapter disconnected"))
    await this.exited.catch(() => undefined)
  }

  private async read() {
    let buffered = Buffer.alloc(0)
    for await (const part of this.process.stdout) {
      buffered = Buffer.concat([buffered, Buffer.from(part)])
      while (true) {
        const headerEnd = buffered.indexOf("\r\n\r\n")
        if (headerEnd < 0) break
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(buffered.subarray(0, headerEnd).toString())
        if (!match) throw new globalThis.Error("Debug adapter sent a message without Content-Length")
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        if (buffered.length < bodyStart + length) break
        const message = JSON.parse(buffered.subarray(bodyStart, bodyStart + length).toString()) as unknown
        buffered = buffered.subarray(bodyStart + length)
        this.receive(message)
      }
    }
  }

  private async drainStderr() {
    for await (const _part of this.process.stderr) {}
  }

  private receive(value: unknown) {
    if (!isMessage(value)) return
    if (value.type === "event") {
      this.received.push(value)
      if (this.received.length > 100) this.received.shift()
      return
    }
    if (value.type !== "response" || typeof value.request_seq !== "number") return
    const pending = this.pending.get(value.request_seq)
    if (!pending) return
    this.pending.delete(value.request_seq)
    clearTimeout(pending.timer)
    if (value.success === false) {
      pending.reject(new globalThis.Error(typeof value.message === "string" ? value.message : "Debug adapter request failed"))
      return
    }
    pending.resolve(value.body)
  }

  private close(error: globalThis.Error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.process.stdin.end()
    if (this.process.exitCode === null) this.process.kill()
  }
}

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export const layer = Layer.effect(
  Service,
  Effect.acquireRelease(
    Effect.gen(function* () {
    const config = yield* Config.Service
    const adapters = (yield* config.entries())
      .filter((entry) => entry.type === "document")
      .reduce(
        (result, entry) => ({ ...result, ...(entry.info.dap?.adapters ?? {}) }),
        {} as Record<string, { readonly command: readonly string[]; readonly env?: Readonly<Record<string, string>> }>,
      )
    const sessions = new Map<string, Client>()

    const client = (session: string) => {
      const found = sessions.get(session)
      if (!found) return Effect.fail(new Error({ message: `Unknown debug session: ${session}` }))
      return Effect.succeed(found)
    }
    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => new Error({ message: cause instanceof globalThis.Error ? cause.message : String(cause) }),
      })

    return {
      sessions,
      service: Service.of({
      start: (input) =>
        Effect.gen(function* () {
          const adapter = adapters[input.adapter]
          if (!adapter) return yield* new Error({ message: `Unknown debug adapter: ${input.adapter}` })
          if (adapter.command.length === 0)
            return yield* new Error({ message: `Debug adapter command is empty: ${input.adapter}` })
          const id = crypto.randomUUID()
          const active = new Client(adapter.command, adapter.env, input.mode)
          sessions.set(id, active)
          const capabilities = yield* attempt(() =>
            active.request("initialize", {
              clientID: "opencode",
              clientName: "OpenCode",
              adapterID: input.adapter,
              pathFormat: "path",
              linesStartAt1: true,
              columnsStartAt1: true,
              supportsVariableType: true,
              supportsVariablePaging: true,
              supportsRunInTerminalRequest: false,
            }),
          ).pipe(
            Effect.tapError(() =>
              attempt(() => active.stop()).pipe(
                Effect.tap(() => Effect.sync(() => sessions.delete(id))),
                Effect.ignore,
              ),
            ),
          )
          yield* attempt(() => active.request(input.mode, input.arguments)).pipe(
            Effect.tapError(() =>
              attempt(() => active.stop()).pipe(
                Effect.tap(() => Effect.sync(() => sessions.delete(id))),
                Effect.ignore,
              ),
            ),
          )
          return { session: id, capabilities }
        }),
      request: (input) =>
        Effect.gen(function* () {
          const active = yield* client(input.session)
          return yield* attempt(() => active.request(input.command, input.arguments))
        }),
      events: (session) =>
        Effect.gen(function* () {
          const active = yield* client(session)
          return active.received.splice(0)
        }),
      disconnect: (session) =>
        Effect.gen(function* () {
          const active = sessions.get(session)
          if (!active) return
          sessions.delete(session)
          yield* attempt(() => active.stop())
        }),
      }),
    }
    }),
    (state) => Effect.promise(() => Promise.all([...state.sessions.values()].map((client) => client.stop()))),
  ).pipe(Effect.map((state) => state.service)),
)
