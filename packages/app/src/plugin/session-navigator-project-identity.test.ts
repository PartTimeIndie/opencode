import { expect, test } from "bun:test"

const navigator = await import(new URL("../../../../.opencode/plugins/session-navigator-app/index.js", import.meta.url).href)

test("groups canonical workspace spellings, not distinct checkouts with a shared project ID", () => {
  const real = "E:/GitRepros/opencode"
  const junction = "C:/GitRepros/opencode"
  const lower = real.toLowerCase()
  const other = "E:/Other/opencode"
  const ambiguous = "C:/old/opencode"
  const groups = navigator.groupNavigatorProjects([
    { projectID: "one", worktree: real, name: "opencode", sessionDirectories: [junction, other.toLowerCase(), ambiguous] },
    { projectID: "one", worktree: lower, name: "opencode" },
    { projectID: "one", worktree: other, name: "opencode", sessionDirectories: [real, ambiguous] },
  ])
  expect(groups.map((project: { worktree: string }) => project.worktree)).toEqual([real, other])
  expect(groups[0].sessionDirectories).toEqual([real, junction, lower])
  expect(groups[1].sessionDirectories).toEqual([other])
})

test("each alias follows its own cursor and keeps the stored session directory", async () => {
  const requests: [string, string | undefined][] = []
  const api = { client: { experimental: { session: {
    list: async ({ directory, cursor }: { directory: string; cursor?: string }) => {
      requests.push([directory, cursor])
      const id = cursor ? "ses_first" : "ses_second"
      return {
        data: [{ id, directory }],
        response: new Response(null, { headers: cursor ? {} : { "x-next-cursor": `123:${id}` } }),
      }
    },
  } } } }
  const alias = "C:/GitRepros/opencode"
  const real = "E:/GitRepros/opencode"
  const [left, right] = await Promise.all([alias, real].map((directory) =>
    navigator.loadNavigatorDirectory(api, {}, directory, Infinity)))
  expect(requests).toEqual([[alias, undefined], [real, undefined], [alias, "123:ses_second"], [real, "123:ses_second"]])
  expect(left.map((session: { directory: string }) => session.directory)).toEqual([alias, alias])
  expect(right.map((session: { directory: string }) => session.directory)).toEqual([real, real])
})
