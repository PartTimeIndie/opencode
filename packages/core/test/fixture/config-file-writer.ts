import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { ConfigFileWriter } from "@opencode-ai/core/config/file-writer"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

const [directory, file, key] = process.argv.slice(2)
if (!directory || !file || !key) throw new Error("Missing writer fixture arguments")
const state = Schema.Record(Schema.String, Schema.Int)
await Effect.runPromise(Effect.gen(function* () {
  const writer = yield* ConfigFileWriter.Service
  yield* Effect.promise(() => fs.writeFile(path.join(directory, `ready-${key}`), "ready"))
  // Synchronize independent processes before either read-merge-write sequence.
  for (let wait = 0; ; wait++) {
    const ready = yield* Effect.promise(() => fs.access(path.join(directory, key === "first" ? "ready-second" : "ready-first")).then(() => true, () => false))
    if (ready) break
    if (wait === 200) return yield* Effect.die("Other writer did not reach the fixture barrier")
    yield* Effect.sleep("10 millis")
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    yield* writer.update({ file }, (current) => Effect.gen(function* () {
      const previous = Schema.decodeUnknownSync(Schema.fromJsonString(state))(current.text ?? "{}")
      yield* Effect.sleep("15 millis")
      return { text: JSON.stringify({ ...previous, [key]: (previous[key] ?? 0) + 1 }), value: undefined }
    }))
  }
}).pipe(Effect.provide(ConfigFileWriter.layer.pipe(Layer.provide(EffectFlock.layer.pipe(
  Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ state: path.join(directory, "state") })),
))))))
