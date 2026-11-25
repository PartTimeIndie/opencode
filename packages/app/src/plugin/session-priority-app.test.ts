import { expect, test } from "bun:test"

const source = new URL("../../../../.opencode/plugin-sources/session-priority-app/", import.meta.url)
const runtime = new URL("../../../../.opencode/plugins/session-priority-app/", import.meta.url)

test("priority plugin uses the selected menu target, not the active session", async () => {
  const plugin = (await import(new URL("index.js", runtime).href)).default
  const calls: Array<{ directory: string; sessionID: string; enabled: boolean }> = []
  let item: { menu: { state(target: { directory: string; sessionID: string }): { checked: boolean }; run(target: { directory: string; sessionID: string }): Promise<void> } } | undefined
  plugin.app({
    host: { sessions: { attention: {
      register: () => () => {},
      get: (target: { directory: string; sessionID: string }) => ({ enabled: target.sessionID === "a" }),
      set: async (target: { directory: string; sessionID: string }, enabled: boolean) => {
        calls.push({ ...target, enabled }); return true
      },
    } } },
    slots: { register: (value: typeof item) => { item = value } },
  })
  expect(item!.menu.state({ directory: "/project", sessionID: "b" })).toMatchObject({ checked: false, label: "Wichtige Session markieren" })
  await item!.menu.run({ directory: "/project", sessionID: "b" })
  expect(calls).toEqual([{ directory: "/project", sessionID: "b", enabled: true }])
  for (const name of ["index.js", "package.json"]) {
    expect(await Bun.file(new URL(name, runtime)).text()).toBe(await Bun.file(new URL(name, source)).text())
  }
})
