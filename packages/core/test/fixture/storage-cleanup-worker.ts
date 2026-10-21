import { writeFile } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { StorageCleanup } from "@opencode-ai/core/storage-cleanup"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"

type Message = {
  readonly root: string
  readonly data: string
  readonly state: string
  readonly snapshot: string
  readonly locks: string
  readonly now: number
  readonly settings: StorageCleanup.Settings
  readonly ready: string
  readonly go: string
  readonly result: string
}

const message = JSON.parse(process.argv[2]) as Message
const global = Global.layerWith({
  home: message.root,
  data: message.data,
  cache: message.root,
  config: message.root,
  state: message.state,
  bin: message.root,
  log: message.root,
})
const layer = EffectFlock.layer.pipe(Layer.provide(global), Layer.provide(FSUtil.defaultLayer))

async function waitForGo() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await Bun.file(message.go).exists()) return
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${message.go}`)
}

await writeFile(message.ready, String(process.pid))
await waitForGo()

await Effect.runPromise(
  Effect.gen(function* () {
    const flock = yield* EffectFlock.Service
    const cleanup = StorageCleanup.make({
      data: message.data,
      state: message.state,
      snapshotDirectory: message.snapshot,
      locks: StorageCleanup.lockManager(flock, message.locks),
      now: () => message.now,
    })
    return yield* Effect.promise(() => cleanup.runIfDue(message.settings))
  }).pipe(Effect.provide(layer)),
)
  .then((result) => Bun.write(message.result, JSON.stringify(result)))
  .catch((cause) => {
    process.stderr.write(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause))
    process.exitCode = 1
  })
