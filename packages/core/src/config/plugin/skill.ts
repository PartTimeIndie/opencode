export * as ConfigSkillPlugin from "./skill"

import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"
import { Location } from "../../location"
import { PluginV2 } from "../../plugin"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { ConfigAgent } from "../agent"

const externalDirectories = [".agents", ".cursor", ".claude", ".codex"]

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("config-skill"),
  effect: Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const skill = yield* SkillV2.Service
    const transform = yield* skill.transform()
    const entries = yield* config.entries()
    const directories = entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
    const items = entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
    const projectDirectories = yield* fs
      .up({ targets: externalDirectories, start: location.directory, stop: location.project.directory })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const scopes = Config.globalLatest(entries, "skill_scopes") ?? {}

    yield* transform((editor) => {
      for (const directory of externalDirectories) {
        editor.source(
          new SkillV2.DirectorySource({
            type: "directory",
            path: AbsolutePath.make(path.join(global.home, directory, "skills")),
          }),
        )
      }
      for (const directory of projectDirectories) {
        editor.source(
          new SkillV2.DirectorySource({
            type: "directory",
            path: AbsolutePath.make(path.join(directory, "skills")),
          }),
        )
      }
      for (const directory of directories) {
        editor.source(
          new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }),
        )
        editor.source(
          new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        )
      }
      for (const [directory, scope] of Object.entries(scopes)) {
        if (!ConfigAgent.projectScopeAllows(scope, location.project.directory)) continue
        editor.source(new SkillV2.DirectorySource({ type: "directory", path: AbsolutePath.make(directory) }))
      }
      for (const item of items) {
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          editor.source(new SkillV2.UrlSource({ type: "url", url: item }))
          continue
        }
        const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
        editor.source(
          new SkillV2.DirectorySource({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
          }),
        )
      }
    })
  }),
})
