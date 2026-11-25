import { describe, expect, test } from "bun:test"
const { default: plugin } = (await import(
  new URL("../../../../.opencode/plugin-sources/local-desktop-deploy-app/index.js", import.meta.url).href
)) as { default: { app: (api: object) => void } }

describe("desktop deploy external handoff", () => {
  test.each(["connection failure", "command failure"])(
    "shows %s before handoff and ignores stale cached running state",
    async (failure) => {
      const alerts: string[] = []
      let calls = 0
      let run: (ctx: { directory: string }) => Promise<void> = async () => undefined
      const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          confirm: () => {
            throw new Error("must not confirm after failed status")
          },
          alert: (message: string) => alerts.push(message),
        },
      })
      try {
        plugin.app({
          toolbar: {
            register: (value: { run: typeof run }) => {
              run = value.run
            },
          },
          kv: { get: () => ({ status: "running" }), set: () => undefined },
          host: {
            command: {
              run: async () => {
                calls += 1
                if (failure === "connection failure") throw new Error("Failed to fetch local server")
                return { exitCode: 1, output: "bun was not found" }
              },
            },
          },
        })
        await expect(run({ directory: "E:/GitRepros/opencode" })).rejects.toThrow(
          failure === "connection failure" ? "Failed to fetch local server" : "bun was not found",
        )
        expect(calls).toBe(1)
        expect(alerts).toHaveLength(1)
        expect(alerts[0]).toContain("Build and Deploy ist fehlgeschlagen")
      } finally {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
        else Reflect.deleteProperty(globalThis, "window")
      }
    },
  )

  test("starts one approved automatic handoff instead of preparing inside the app", async () => {
    const commands: string[] = []
    const confirmations: string[] = []
    let run: (ctx: { directory: string }) => Promise<void> = async () => {
      throw new Error("toolbar not registered")
    }
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        confirm: (message: string) => {
          confirmations.push(message)
          return true
        },
        alert: () => undefined,
      },
    })
    try {
      plugin.app({
        toolbar: {
          register: (value: { run: typeof run }) => {
            run = value.run
          },
        },
        ui: { loading: { with: async (_options: unknown, action: () => Promise<unknown>) => action() } },
        kv: { get: () => undefined, set: () => undefined },
        host: {
          command: {
            run: async (input: { arguments: string[] }) => {
              const script = Buffer.from(input.arguments.at(-1)!, "base64").toString("utf16le")
              commands.push(script)
              if (script.includes('"status"')) return { exitCode: 0, output: "{}" }
              return { exitCode: 0, output: "AUTOMATIC : detached worker for auto-1" }
            },
          },
        },
      })
      await run({ directory: "C:/GitRepros/opencode" })
      expect(commands).toHaveLength(2)
      expect(commands[1]).toContain('"automatic"')
      expect(commands[1]).not.toContain('"--detach"')
      expect(commands[1]).toContain('"--approved-close"')
      expect(commands[1]).toContain('"--force-close-approved"')
      expect(commands[1]).toContain('"--restart"')
      expect(commands.some((script) => script.includes('"prepare"'))).toBe(false)
      expect(confirmations.some((text) => text.includes("Force-Close") && text.includes("CMD"))).toBe(true)
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test.each(["", "AUTOMATIC : detached console started"])(
    "rejects exit code zero without a claimed worker: %s",
    async (output) => {
      const alerts: string[] = []
      const statuses: Array<{ status: string }> = []
      let run: (ctx: { directory: string }) => Promise<void> = async () => undefined
      const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { confirm: () => true, alert: (message: string) => alerts.push(message) },
      })
      try {
        plugin.app({
          toolbar: { register: (value: { run: typeof run }) => { run = value.run } },
          ui: { loading: { with: async (_options: unknown, action: () => Promise<unknown>) => action() } },
          kv: { get: () => statuses.at(-1), set: (_key: string, value: { status: string }) => statuses.push(value) },
          host: {
            command: {
              run: async (input: { arguments: string[] }) => {
                const script = Buffer.from(input.arguments.at(-1)!, "base64").toString("utf16le")
                return { exitCode: 0, output: script.includes('"status"') ? "{}" : output }
              },
            },
          },
        })
        await expect(run({ directory: "E:/GitRepros/opencode" })).rejects.toThrow("did not acknowledge handoff")
        expect(alerts).toHaveLength(1)
        expect(statuses.at(-1)?.status).toBe("failed")
        expect(statuses.some((status) => status.status === "restarting")).toBe(false)
      } finally {
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
        else Reflect.deleteProperty(globalThis, "window")
      }
    },
  )

  test("aborts before any shutdown when the handoff is declined", async () => {
    const commands: string[] = []
    let run: (ctx: { directory: string }) => Promise<void> = async () => {
      throw new Error("toolbar not registered")
    }
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        confirm: () => false,
        alert: () => undefined,
      },
    })
    try {
      plugin.app({
        toolbar: {
          register: (value: { run: typeof run }) => {
            run = value.run
          },
        },
        ui: { loading: { with: async (_options: unknown, action: () => Promise<unknown>) => action() } },
        kv: { get: () => undefined, set: () => undefined },
        host: {
          command: {
            run: async (input: { arguments: string[] }) => {
              const script = Buffer.from(input.arguments.at(-1)!, "base64").toString("utf16le")
              commands.push(script)
              return { exitCode: 0, output: "{}" }
            },
          },
        },
      })
      await run({ directory: "C:/GitRepros/opencode" })
      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain('"status"')
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("deploys a prepared build with its pinned launch instead of rebuilding", async () => {
    const commands: string[] = []
    const ready = {
      status: "ready",
      finishedAt: Date.now(),
      buildID: "20260907T153638Z-29064bf1",
      sourceFingerprint: "source-sha",
      artifactSha256: "artifact-sha",
      stagePath: "C:\\Programs\\OpenCode.deploy-build",
      prodMarker: "C:\\repo\\packages\\desktop\\out\\.build-channel",
      logPath: "C:\\OpenCodeDeploy\\build.log",
      updatedAt: new Date().toISOString(),
    }
    let run: (ctx: { directory: string }) => Promise<void> = async () => {
      throw new Error("toolbar not registered")
    }
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { confirm: () => true, alert: () => undefined },
    })
    try {
      plugin.app({
        toolbar: {
          register: (value: { run: typeof run }) => {
            run = value.run
          },
        },
        ui: { loading: { with: async (_options: unknown, action: () => Promise<unknown>) => action() } },
        kv: { get: () => undefined, set: () => undefined },
        host: {
          command: {
            run: async (input: { arguments: string[] }) => {
              const script = Buffer.from(input.arguments.at(-1)!, "base64").toString("utf16le")
              commands.push(script)
              if (script.includes('"status"')) return { exitCode: 0, output: JSON.stringify(ready) }
              return { exitCode: 0, output: `STARTED : detached deploy worker for ${ready.buildID}` }
            },
          },
        },
      })
      await run({ directory: "C:/GitRepros/opencode" })
      expect(commands).toHaveLength(2)
      expect(commands[1]).toContain('"launch"')
      expect(commands[1]).toContain(`"${ready.buildID}"`)
      expect(commands[1]).not.toContain('"automatic"')
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test.each([
    "fingerprinting-source",
    "building",
    "packaging",
    "staging",
    "launching-worker",
    "deploying",
  ] as const)("opens the visible cancellation console while %s is in flight", async (status) => {
    const commands: string[] = []
    const alerts: string[] = []
    let run: (ctx: { directory: string }) => Promise<void> = async () => {
      throw new Error("toolbar not registered")
    }
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        confirm: () => { throw new Error("must not approve a second deploy") },
        alert: (message: string) => alerts.push(message),
      },
    })
    try {
      plugin.app({
        toolbar: {
          register: (value: { run: typeof run }) => {
            run = value.run
          },
        },
        ui: { loading: { with: async (_options: unknown, action: () => Promise<unknown>) => action() } },
        kv: { get: () => undefined, set: () => undefined },
        host: {
          command: {
            run: async (input: { arguments: string[] }) => {
              const script = Buffer.from(input.arguments.at(-1)!, "base64").toString("utf16le")
              commands.push(script)
              return {
                exitCode: 0,
                output: commands.length === 1
                  ? JSON.stringify({ status, runID: "auto-1", updatedAt: new Date().toISOString() })
                  : "CANCELLATION_CONSOLE : started",
              }
            },
          },
        },
      })
      await run({ directory: "C:/GitRepros/opencode" })
      expect(commands).toHaveLength(2)
      expect(commands[1]).toContain("build-and-deploy.cmd")
      expect(commands[1]).not.toContain("--cancel-conflict-only")
      expect(alerts).toHaveLength(0)
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})
