import { expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { FanoutWorkflow } from "../src/fanout-workflow"

const definition = { id: "first", configKey: "first", agentID: "alpha", commands: ["/first"], tools: [], resultSchema: { type: "object" } }

test("resolves exact IDs, registered commands, and public command names", async () => {
  const review = { ...definition, id: "review", commands: ["/multi-agent-review"] }
  const command = { ...definition, id: "command-owner", commands: ["review"] }
  const entries = [command, review]

  expect(FanoutWorkflow.resolve(entries, "review")).toBe(review)
  expect(FanoutWorkflow.resolve(entries, "/multi-agent-review")).toBe(review)
  expect(FanoutWorkflow.resolve(entries, "multi-agent-review")).toBe(review)
  expect(FanoutWorkflow.resolve(entries, "missing")).toBeUndefined()

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const service = yield* FanoutWorkflow.Service
    yield* service.register("review-plugin", review)
    expect(service.resolve("review")?.id).toBe("review")
    expect(service.resolve("/multi-agent-review")?.id).toBe("review")
    expect(service.resolve("multi-agent-review")?.id).toBe("review")
  })).pipe(Effect.provide(FanoutWorkflow.layer)))
})

test("canonical IDs and aliases cannot redirect another agent in either registration order", async () => {
  for (const reverse of [false, true]) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* FanoutWorkflow.Service
      const other = { ...definition, id: "second", configKey: "second", agentID: "beta", commands: ["/second"], agentAliases: ["alpha"] }
      yield* service.register("one", reverse ? other : definition)
      const failed = yield* service.register("two", reverse ? definition : other).pipe(Effect.flip)
      expect(failed).toBeInstanceOf(Error)
      expect(service.agent("alpha")).toBe(reverse ? "beta" : "alpha")
    })).pipe(Effect.provide(FanoutWorkflow.layer)))
  }
})

test("same canonical agent aliases may be shared by separate workflows", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const service = yield* FanoutWorkflow.Service
    yield* service.register("one", { ...definition, agentAliases: ["alpha"] })
    yield* service.register("two", { ...definition, id: "second", commands: ["/second"], agentAliases: ["alpha"] })
    expect(service.agent("alpha")).toBe("alpha")
  })).pipe(Effect.provide(FanoutWorkflow.layer)))
})

test("malformed schemas and empty commands fail registration without defects or stored entries", async () => {
  for (const input of [{ ...definition, resultSchema: { invalid: () => {} } }, { ...definition, commands: [""] }]) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const service = yield* FanoutWorkflow.Service
      const result = yield* Effect.exit(service.register("one", input))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(false)
      expect(service.get(input.id)).toBeUndefined()
    })).pipe(Effect.provide(FanoutWorkflow.layer)))
  }
})
