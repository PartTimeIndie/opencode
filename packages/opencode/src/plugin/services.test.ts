import { describe, expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"
import { createPluginServiceRegistry } from "./services"

const owner = { pluginID: "notes", projectID: "project-a", directory: path.resolve("service-project") }
const caller = { ...owner, pluginID: "notes-ui", sessionID: "session-a", signal: new AbortController().signal }
const request = { pluginID: "notes", serviceID: "format", version: 1, input: { text: "hello" } }
const definition = {
  id: "format",
  version: 1,
  input: z.object({ text: z.string() }),
  output: z.string(),
  execute: (input: { text: string }) => input.text.toUpperCase(),
}

describe("plugin service registry", () => {
  test("accepts scoped npm plugin identities while keeping service IDs segment-safe", async () => {
    const registry = createPluginServiceRegistry({
      authorize: ({ caller, target }) =>
        caller.capabilities?.includes(`services:${target.pluginID}:${target.serviceID}`) ?? false,
    })
    const pluginID = "@dietrichgebert/ponytail"
    const binding = registry.bind({ ...owner, pluginID })
    binding.services.register(definition)
    expect(
      await registry.invoke({ ...request, pluginID }, { ...caller, capabilities: [`services:${pluginID}:format`] }),
    ).toBe("HELLO")
    await expect(
      registry.invoke(
        { ...request, pluginID, input: { text: "hello", capabilities: [`services:${pluginID}:format`] } },
        caller,
      ),
    ).rejects.toMatchObject({ code: "forbidden" })
    await expect(
      registry.invoke({ ...request, pluginID }, { ...caller, capabilities: [`services:${pluginID}:other`] }),
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(() => binding.services.register({ ...definition, id: "@scope/service" })).toThrow("IDs must use")
    expect(() => registry.bind({ ...owner, pluginID: "@scope/../plugin" })).toThrow("IDs must use")
    expect(() => registry.bind({ ...owner, pluginID: "scope/plugin" })).toThrow("IDs must use")
    await binding.dispose()
  })

  test("independent services use standard schemas and host-owned identity", async () => {
    const registry = createPluginServiceRegistry({
      authorize: ({ caller, target }) => caller.pluginID === `${target.pluginID}-ui`,
    })
    const notes = registry.bind(owner)
    const numbers = registry.bind({ ...owner, pluginID: "numbers" })
    notes.services.register({
      ...definition,
      output: z.object({ text: z.string(), owner: z.string(), caller: z.string(), session: z.string() }),
      execute: (input, context) => ({
        text: input.text,
        owner: context.pluginID,
        caller: context.callerPluginID,
        session: context.sessionID!,
      }),
    })
    numbers.services.register({
      id: "double",
      version: 2,
      input: z.number(),
      output: z.number(),
      execute: (value) => value * 2,
    })
    expect(
      await registry.invoke({ ...request, input: { text: "hi", pluginID: "attacker", sessionID: "foreign" } }, caller),
    ).toEqual({ text: "hi", owner: "notes", caller: "notes-ui", session: "session-a" })
    expect(
      await registry.invoke(
        { pluginID: "numbers", serviceID: "double", version: 2, input: 3 },
        { ...caller, pluginID: "numbers-ui" },
      ),
    ).toBe(6)
    await Promise.all([notes.dispose(), numbers.dispose()])
  })

  test("capability denial prevents validation and execution", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => false })
    const binding = registry.bind(owner)
    let executed = false
    binding.services.register({
      ...definition,
      execute: () => {
        executed = true
        return "unsafe"
      },
    })
    await expect(registry.invoke({ ...request, input: false }, caller)).rejects.toMatchObject({ code: "forbidden" })
    expect(executed).toBe(false)
    await binding.dispose()
  })

  test("isolates owners, projects and directories", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    binding.services.register(definition)
    await expect(registry.invoke(request, { ...caller, projectID: "project-b" })).rejects.toMatchObject({
      code: "unavailable",
    })
    await expect(
      registry.invoke(request, { ...caller, directory: path.resolve("other-project") }),
    ).rejects.toMatchObject({ code: "unavailable" })
    await expect(registry.invoke({ ...request, pluginID: "other" }, caller)).rejects.toMatchObject({
      code: "unavailable",
    })
    expect(await registry.invoke(request, { ...caller, directory: path.join(owner.directory, ".") })).toBe("HELLO")
    await binding.dispose()
  })

  test("rejects duplicate bindings, duplicate services, invalid IDs and versions", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    binding.services.register(definition)
    expect(() => registry.bind(owner)).toThrow("already bound")
    expect(() => binding.services.register(definition)).toThrow("already registered")
    expect(() => binding.services.register({ ...definition, id: "../bad" })).toThrow("IDs must use")
    expect(() => binding.services.register({ ...definition, id: "bad-version", version: 0 })).toThrow(
      "positive integer",
    )
    await expect(registry.invoke({ ...request, version: 2 }, caller)).rejects.toMatchObject({ code: "version" })
    await expect(registry.invoke({ ...request, serviceID: "missing" }, caller)).rejects.toMatchObject({
      code: "unavailable",
    })
    await binding.dispose()
  })

  test("validates transformed inputs and rejects invalid output", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    binding.services.register({ ...definition, input: z.string().transform((text) => ({ text })) })
    expect(await registry.invoke({ ...request, input: "transformed" }, caller)).toBe("TRANSFORMED")
    await expect(registry.invoke(request, caller)).rejects.toMatchObject({ code: "input" })
    binding.services.register({ ...definition, id: "invalid-output", output: z.string().min(100) })
    await expect(registry.invoke({ ...request, serviceID: "invalid-output" }, caller)).rejects.toMatchObject({
      code: "output",
    })
    await binding.dispose()
  })

  test("request abort cancels a non-cooperative handler and reaches its signal", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    const started = Promise.withResolvers<AbortSignal>()
    binding.services.register({
      ...definition,
      execute: (_, context) => {
        started.resolve(context.signal)
        return new Promise<string>(() => {})
      },
    })
    const controller = new AbortController()
    const invocation = registry.invoke(request, { ...caller, signal: controller.signal })
    const observed = await started.promise
    controller.abort(new DOMException("cancelled", "AbortError"))
    await expect(invocation).rejects.toMatchObject({ name: "AbortError" })
    expect(observed.aborted).toBe(true)
    await binding.dispose()
  })

  test("unload cancels pending authorization before execution", async () => {
    const started = Promise.withResolvers<void>()
    const permission = Promise.withResolvers<boolean>()
    const registry = createPluginServiceRegistry({
      authorize: () => {
        started.resolve()
        return permission.promise
      },
    })
    const binding = registry.bind(owner)
    let executed = false
    binding.services.register({
      ...definition,
      execute: () => {
        executed = true
        return "wrong"
      },
    })
    const invocation = registry.invoke(request, caller)
    await started.promise
    await binding.dispose()
    await expect(invocation).rejects.toMatchObject({ name: "AbortError" })
    permission.resolve(true)
    await Promise.resolve()
    expect(executed).toBe(false)
  })

  test("service removal is idempotent and does not remove a replacement", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    let disposed = 0
    const remove = binding.services.register({
      ...definition,
      dispose: () => {
        disposed++
      },
    })
    await Promise.all([remove(), remove()])
    binding.services.register(definition)
    await remove()
    expect(await registry.invoke(request, caller)).toBe("HELLO")
    await Promise.all([binding.dispose(), binding.dispose()])
    expect(disposed).toBe(1)
    await expect(registry.invoke(request, caller)).rejects.toMatchObject({ code: "unavailable" })
    expect(() => binding.services.register(definition)).toThrow("unloaded")
    const replacement = registry.bind(owner)
    replacement.services.register(definition)
    expect(await registry.invoke(request, caller)).toBe("HELLO")
    await replacement.dispose()
  })

  test("unload cancels active calls, cleans all services despite a failed disposer and preserves other owners", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    const independent = registry.bind({ ...owner, pluginID: "independent" })
    const started = Promise.withResolvers<void>()
    let cleanup = false
    binding.services.register({
      ...definition,
      execute: () => {
        started.resolve()
        return new Promise<string>(() => {})
      },
      dispose: () => {
        throw new Error("cleanup failed")
      },
    })
    binding.services.register({
      ...definition,
      id: "second",
      dispose: () => {
        cleanup = true
      },
    })
    independent.services.register(definition)
    const invocation = registry.invoke(request, caller)
    const cancelled = invocation.then(
      () => undefined,
      (error: unknown) => error,
    )
    await started.promise
    await expect(binding.dispose()).rejects.toThrow("cleanup failed")
    expect(await cancelled).toMatchObject({ name: "AbortError" })
    expect(cleanup).toBe(true)
    expect(await registry.invoke({ ...request, pluginID: "independent" }, caller)).toBe("HELLO")
    await independent.dispose()
  })

  test("plugin unload joins asynchronous service cleanup already in progress", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    const cleanup = Promise.withResolvers<void>()
    const remove = binding.services.register({ ...definition, dispose: () => cleanup.promise })
    const removing = remove()
    const unloading = binding.dispose()
    expect(() => registry.bind(owner)).toThrow("already bound")
    cleanup.resolve()
    await Promise.all([removing, unloading])
    const replacement = registry.bind(owner)
    await replacement.dispose()
  })

  test("reentrant cancellation listeners dispose a service only once", async () => {
    const registry = createPluginServiceRegistry({ authorize: () => true })
    const binding = registry.bind(owner)
    const started = Promise.withResolvers<void>()
    let disposed = 0
    const remove = binding.services.register({
      ...definition,
      execute: (_, context) => {
        context.signal.addEventListener(
          "abort",
          () => {
            void remove()
          },
          { once: true },
        )
        started.resolve()
        return new Promise<string>(() => {})
      },
      dispose: () => {
        disposed++
      },
    })
    const invocation = registry.invoke(request, caller).then(
      () => undefined,
      (error: unknown) => error,
    )
    await started.promise
    await remove()
    expect(await invocation).toMatchObject({ name: "AbortError" })
    expect(disposed).toBe(1)
    await binding.dispose()
  })
})
