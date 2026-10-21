import { Effect } from "effect"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

const [directory, key] = process.argv.slice(2)
if (!directory || !key) throw new Error("fixture needs directory and key")
await Effect.runPromise(
  EffectFlock.Service.use((flock) =>
    flock.withLock(
      Effect.promise(async () => {
        process.stdout.write("acquired\n")
        await Bun.stdin.text()
      }),
      key,
      directory,
    ),
  ).pipe(Effect.provide(EffectFlock.defaultLayer)),
)
