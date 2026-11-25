import { expect, test } from "bun:test"
import plugin from "./index.js"
import manifest from "./package.json"
import { readFileSync } from "node:fs"

test("Mirror uses the host's session-less, scoped, admission-bound toggle in every project", () => {
  const items = []
  plugin.app({ toolbar: { register: (item) => items.push(item) } })
  expect(plugin.id).toBe("mirror-app")
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({
    id: "mirror", title: "Mirror", placement: "composer", defaultVisible: true,
    mobile: "visible", skill: { name: "mirror" }, appendOnSubmit: true,
  })
  // No directory/Session gate, status subprocess, or custom submit lifecycle.
  expect(items[0].visible).toBeUndefined()
  expect(items[0].enabled).toBeUndefined()
  expect(items[0].mount).toBeUndefined()
  expect(items[0].run).toBeUndefined()
  expect(manifest.opencode.app.capabilities).toEqual(["ui:toolbar", "host:composer"])
})

test("native orchestration uses conversation forks and host-owned child mirrors, not legacy activation", () => {
  const skill = readFileSync(new URL("./skills/mirror/SKILL.md", import.meta.url), "utf8")
  expect(skill).toContain("`/native-orchestrator`")
  expect(skill).toContain('`workspace: "mirror"`')
  expect(skill).toContain("Their conversation forks")
  expect(skill).toContain("do not create a standalone mirror for Main")
  expect(skill).toContain("**Existing native child:** keep its host-bound workspace")
  expect(skill).toContain("`task_integrate`")
  expect(skill).toContain("**Historical legacy Main or child:** execution remains blocked")
  expect(skill).toContain("stop state, children, claims and approvals")
  expect(skill).not.toContain("workspaceMode")
  expect(skill).not.toContain("guarded host activation")
})

test("a bare Mirror submission closes an existing standalone mirror instead of opening another", () => {
  const skill = readFileSync(new URL("./skills/mirror/SKILL.md", import.meta.url), "utf8")
  expect(skill).toContain("**Active standalone Mirror: close and merge back by default.**")
  expect(skill).toContain("a message containing only `/mirror`")
  expect(skill).toContain("an empty draft submitted with the Mirror toolbar toggle armed")
  expect(skill).toContain("Do not ask whether to keep using the Mirror")
  expect(skill).toContain("**No existing Mirror: start one**")
})

test("default close intent retains exact-plan approval, ownership and separate deletion", () => {
  const skill = readFileSync(new URL("./skills/mirror/SKILL.md", import.meta.url), "utf8")
  expect(skill).toContain("does not approve an unseen merge plan")
  expect(skill).toContain("approval names\n   exactly this planDigest")
  expect(skill).toContain("Deleting the integrated mirror is separate")
  expect(skill).toContain("do not create a replacement or pretend it is registered")
  expect(skill).not.toContain("Reuse it unless the human explicitly requests closeout")
})
