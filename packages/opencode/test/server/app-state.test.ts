import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AppState } from "../../src/server/app-state"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("database-scoped app state", () => {
  test("keeps the default production database on the legacy app-state path", async () => {
    const data = await tempData()
    const scope = { data, database: join(data, "opencode.db") }
    const state = { items: { favorite: { id: "ses_default" } } }

    expect(AppState.file("session-favorites.v1", scope)).toBe(join(data, "app-state", "session-favorites.v1.json"))
    await AppState.write("session-favorites.v1", state, scope)
    expect(await AppState.read("session-favorites.v1", scope)).toEqual(state)
  })

  test("isolates non-default databases without reading or overwriting legacy favorites", async () => {
    const data = await tempData()
    const legacy = { data, database: join(data, "opencode.db") }
    const stable = { data, database: join(data, "opencode-stable.db") }
    const beta = { data, database: join(data, "opencode-beta.db") }

    expect(AppState.file("session-favorites.v1", stable)).not.toBe(AppState.file("session-favorites.v1", legacy))
    expect(AppState.file("session-favorites.v1", beta)).not.toBe(AppState.file("session-favorites.v1", stable))
    expect(AppState.file("session-favorites.v1", stable)).toStartWith(join(data, "app-state", "databases"))

    await AppState.write("session-favorites.v1", { items: { desktop: { id: "ses_desktop" } } }, legacy)
    expect(await AppState.read("session-favorites.v1", stable)).toEqual({})
    await AppState.write("session-favorites.v1", { items: { stable: { id: "ses_stable" } } }, stable)
    await AppState.write("session-favorites.v1", { items: { beta: { id: "ses_beta" } } }, beta)

    expect(await AppState.read("session-favorites.v1", legacy)).toEqual({ items: { desktop: { id: "ses_desktop" } } })
    expect(await AppState.read("session-favorites.v1", stable)).toEqual({ items: { stable: { id: "ses_stable" } } })
    expect(await AppState.read("session-favorites.v1", beta)).toEqual({ items: { beta: { id: "ses_beta" } } })
  })
})

async function tempData() {
  const root = await mkdtemp(join(tmpdir(), "opencode-app-state-"))
  roots.push(root)
  return root
}
