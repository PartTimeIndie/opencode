import { expect, test } from "bun:test"
test("sync defaults to all sources but a named sync never touches unrelated runtimes", async () => {
  const { selectPluginSources } = await import(new URL("../../../../script/sync-plugin-selection.ts", import.meta.url).href) as {
    selectPluginSources(names: string[], args: string[]): string[]
  }
  const sources = ["speech-to-text-app", "session-navigator-app"]
  expect(selectPluginSources(sources, [])).toEqual(sources)
  expect(selectPluginSources(sources, ["--only=speech-to-text-app"])).toEqual(["speech-to-text-app"])
  for (const args of [["--only=missing"], ["--only="], ["--only=speech-to-text-app", "extra"], ["session-navigator-app"]]) {
    expect(() => selectPluginSources(sources, args)).toThrow()
  }
})
