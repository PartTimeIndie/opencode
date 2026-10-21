import { Effect, Layer } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { IntegrationSchema } from "@opencode-ai/core/integration/schema"
import { join } from "node:path"

const directory = process.argv[2]!
const phase = process.argv[3]!
const run = Effect.gen(function* () {
  const service = yield* Credential.Service
  if (phase === "seed") {
    yield* service.create({
      integrationID: IntegrationSchema.ID.make("native-fixture"),
      value: new Credential.Key({ type: "key", key: "native-fixture-key" }),
    })
  }
  if (phase !== "seed") {
    yield* Effect.promise(() => Bun.write(join(directory, `${phase}.ready`), "ready"))
    while (!(yield* Effect.promise(() => Bun.file(join(directory, "start")).exists()))) {
      yield* Effect.sleep("10 millis")
    }
  }
  for (let round = 0; round < (phase === "seed" ? 1 : 3); round++) {
    const overwritten = yield* service.syncLegacy({
      mode: "bootstrap",
      integrationID: IntegrationSchema.ID.make("native-fixture"),
      value: new Credential.Key({ type: "key", key: "foreign-fixture-key" }),
    })
    if (overwritten) return yield* Effect.die(new Error("Legacy import replaced a native credential"))
    for (let index = 0; index < 50; index++) {
      yield* service.syncLegacy({
        mode: "bootstrap",
        integrationID: IntegrationSchema.ID.make(`fixture-${index}`),
        value: new Credential.Key({ type: "key", key: `fixture-${phase}-${round}` }),
      })
    }
  }
}).pipe(
  Effect.provide(Credential.layer.pipe(Layer.provide(Database.layerFromPath(join(directory, "race.db"))))),
  Effect.scoped,
)
try {
  await Effect.runPromise(run)
  console.log(JSON.stringify({ phase, status: "ok" }))
} catch (error) {
  const walk = (value: unknown, depth = 0): unknown => {
    if (depth > 6 || value === null || typeof value !== "object") return
    const record = value as Record<string, unknown>
    return {
      name: record.name,
      code: record.code,
      errno: record.errno,
      message: record.message,
      cause: walk(record.cause, depth + 1),
      reason: walk(record.reason, depth + 1),
      reasons: Array.isArray(record.reasons) ? record.reasons.map((item) => walk(item, depth + 1)) : undefined,
      error: walk(record.error, depth + 1),
    }
  }
  console.error(JSON.stringify({ phase, status: "failed", error: walk(error) }))
  process.exitCode = 1
}
