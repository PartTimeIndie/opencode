export * as SkillV2 from "./skill"

import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { castDraft } from "immer"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath, withStatics } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"
import { ModelV2 } from "./model"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { Location } from "./location"

export class DirectorySource extends Schema.Class<DirectorySource>("SkillV2.DirectorySource")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export class UrlSource extends Schema.Class<UrlSource>("SkillV2.UrlSource")({
  type: Schema.Literal("url"),
  url: Schema.String,
}) {}

export class EmbeddedSource extends Schema.Class<EmbeddedSource>("SkillV2.EmbeddedSource")({
  type: Schema.Literal("embedded"),
  skill: Schema.suspend(() => Info),
}) {}

export const Source = Schema.Union([DirectorySource, UrlSource, EmbeddedSource]).pipe(
  Schema.toTaggedUnion("type"),
  withStatics(() => ({
    equals: (a: DirectorySource | UrlSource | EmbeddedSource, b: DirectorySource | UrlSource | EmbeddedSource) => {
      if (a.type !== b.type) return false
      if (a.type === "directory" && b.type === "directory") return a.path === b.path
      if (a.type === "url" && b.type === "url") return a.url === b.url
      if (a.type === "embedded" && b.type === "embedded") return a.skill.name === b.skill.name
      return false
    },
    key: (source: DirectorySource | UrlSource | EmbeddedSource) =>
      source.type === "directory"
        ? `directory:${source.path}`
        : source.type === "url"
          ? `url:${source.url}`
          : `embedded:${source.skill.name}`,
  })),
)
export type Source = typeof Source.Type

export class Info extends Schema.Class<Info>("SkillV2.Info")({
  name: Schema.String,
  description: Schema.String.pipe(Schema.optional),
  groups: Schema.Array(Schema.String).pipe(Schema.optional),
  aliases: Schema.Array(Schema.String).pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
  disableModelInvocation: Schema.Boolean.pipe(Schema.optional),
  agent: Schema.String.pipe(Schema.optional),
  model: ModelV2.Ref.pipe(Schema.optional),
  requiredTools: Schema.Array(Schema.String).pipe(Schema.optional),
  requestedCapabilities: Schema.Array(Schema.String).pipe(Schema.optional),
  location: AbsolutePath,
  content: Schema.String,
}) {}

export class ResolveInput extends Schema.Class<ResolveInput>("SkillV2.ResolveInput")({
  names: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))).pipe(
    Schema.check(Schema.isMaxLength(16)),
  ),
}) {}

export class Resolved extends Schema.Class<Resolved>("SkillV2.Resolved")({
  name: Schema.String,
  content: Schema.String,
}) {}

export class ResolveIssue extends Schema.Class<ResolveIssue>("SkillV2.ResolveIssue")({
  name: Schema.String,
  code: Schema.Literals(["not_found", "not_a_skill", "too_large", "total_too_large"]),
}) {}

export class ResolveOutput extends Schema.Class<ResolveOutput>("SkillV2.ResolveOutput")({
  skills: Schema.Array(Resolved),
  issues: Schema.Array(ResolveIssue),
}) {}

const MAX_SKILL_CONTENT_BYTES = 64 * 1024
const MAX_TOTAL_SKILL_CONTENT_BYTES = 256 * 1024

export function resolveSelected(skills: ReadonlyArray<Info>, names: ReadonlyArray<string>) {
  const available = new Map(skills.map((skill) => [skill.name, skill]))
  const requested = Array.from(new Set(names))
  const initial = { skills: [] as Resolved[], issues: [] as ResolveIssue[], bytes: 0 }
  const result = requested.reduce((output, name) => {
    if (!name || name.startsWith("/") || name.includes("/") || name.includes("\\")) {
      output.issues.push(new ResolveIssue({ name, code: "not_a_skill" }))
      return output
    }
    const skill = available.get(name)
    if (!skill) {
      output.issues.push(new ResolveIssue({ name, code: "not_found" }))
      return output
    }
    const bytes = new TextEncoder().encode(skill.content).byteLength
    if (bytes > MAX_SKILL_CONTENT_BYTES) {
      output.issues.push(new ResolveIssue({ name, code: "too_large" }))
      return output
    }
    if (output.bytes + bytes > MAX_TOTAL_SKILL_CONTENT_BYTES) {
      output.issues.push(new ResolveIssue({ name, code: "total_too_large" }))
      return output
    }
    output.skills.push(new Resolved({ name, content: skill.content }))
    output.bytes += bytes
    return output
  }, initial)
  return new ResolveOutput({ skills: result.skills, issues: result.issues })
}

export const available = (
  skills: ReadonlyArray<Info>,
  agent: AgentV2.Info,
  policy: AgentV2.Info["tools"] = agent.tools,
) =>
  skills.filter(
    (skill) =>
      PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny" &&
      missingTools(skill, agent, policy).length === 0,
  )

export function missingTools(skill: Info, agent: AgentV2.Info, policy: AgentV2.Info["tools"] = agent.tools) {
  return (skill.requiredTools ?? []).filter((tool) => {
    const entry = policy?.entries[tool]
    if (policy?.mode === "explicit" && !entry) return true
    if (entry?.visible === false || entry?.permission === "deny") return true
    return PermissionV2.evaluate(tool, "*", agent.permissions).effect === "deny"
  })
}

export function invokedBySlash(skill: Info, text: string) {
  const name = text.trim().match(/^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/)?.[1]
  return name !== undefined && (name === skill.name || skill.aliases?.includes(name) === true)
}

const Frontmatter = Schema.Struct({
  metadata: Schema.Struct({ "opencode/groups": Schema.String.pipe(Schema.optional) }).pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  aliases: Schema.Array(Schema.String).pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
  "disable-model-invocation": Schema.Boolean.pipe(Schema.optional),
  provider: Schema.String.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  agent: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  tools: Schema.Array(Schema.String).pipe(Schema.optional),
  capabilities: Schema.Array(Schema.String).pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

function skillModel(frontmatter: typeof Frontmatter.Type) {
  if (!frontmatter.model) return
  if (!frontmatter.provider && !frontmatter.model.includes("/")) return
  const parsed = ModelV2.parse(frontmatter.model.includes("/") ? frontmatter.model : `${frontmatter.provider}/${frontmatter.model}`)
  return {
    id: parsed.modelID,
    providerID: parsed.providerID,
    variant: frontmatter.variant ? ModelV2.VariantID.make(frontmatter.variant) : undefined,
  }
}

export type Data = {
  sources: Source[]
}

export type Editor = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface {
  readonly transform: State.Interface<Data, Editor>["transform"]
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: (options?: { refresh?: boolean }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const config = Option.getOrUndefined(yield* Effect.serviceOption(Config.Service))
    const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))

    const state = State.create<Data, Editor>({
      initial: () => ({ sources: [] }),
      editor: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(castDraft(source))
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      return (
        yield* Effect.forEach(
          directories,
          (directory) =>
            Effect.gen(function* () {
              const files = yield* fs
                .glob("{*.md,**/SKILL.md}", {
                  cwd: directory,
                  absolute: true,
                  include: "file",
                  symlink: true,
                  dot: true,
                })
                .pipe(Effect.catch(() => Effect.succeed([] as string[])))
              return (
                yield* Effect.forEach(
                  files.toSorted(),
                  (filepath) =>
                    Effect.gen(function* () {
                      const content = yield* fs
                        .readFileStringSafe(filepath)
                        .pipe(Effect.catch(() => Effect.succeed(undefined)))
                      if (!content) return
                      const markdown = ConfigMarkdown.parseOption(content)
                      if (!markdown) return
                      const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
                      if (!frontmatter) return
                      const name =
                        frontmatter.name !== undefined
                          ? frontmatter.name
                          : path.dirname(filepath) === directory
                            ? path.basename(filepath, ".md")
                            : undefined
                      if (!name) return
                      return new Info({
                        name,
                        description: frontmatter.description,
                        slash: frontmatter.slash,
                        disableModelInvocation: frontmatter["disable-model-invocation"],
                        agent: frontmatter.agent,
                        model: skillModel(frontmatter),
                        requiredTools: frontmatter.tools,
                        requestedCapabilities: frontmatter.capabilities,
                        aliases: frontmatter.aliases,
                        groups: frontmatter.metadata?.["opencode/groups"]?.split(",").map((id) => id.trim()).filter(Boolean),
                        location: AbsolutePath.make(filepath),
                        content: markdown.content,
                      })
                    }),
                  { concurrency: 16 },
                )
              ).filter((skill): skill is Info => skill !== undefined)
            }),
          { concurrency: 4 },
        )
      ).flat()
    })

    // Directory sources refresh on demand while downloaded URL sources remain cached.
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* (options?: { refresh?: boolean }) {
      if (options?.refresh) {
        for (const source of state.get().sources) {
          if (source.type === "directory") cache.delete(Source.key(source))
        }
      }
      const skills = new Map<string, Info>()
      const entries = config ? yield* config.entries() : []
      const scopes = Config.globalLatest(entries, "skill_scopes")
      const invocation = Config.globalLatest(entries, "skill_invocation")
      const scopedDirectories = yield* Effect.forEach(Object.entries(scopes ?? {}), ([directory, scope]) =>
        fs.realPath(directory).pipe(
          Effect.map((canonical) => ({ directory, canonical, scope })),
          Effect.catch(() => Effect.succeed({ directory, canonical: directory, scope })),
        ),
      )
      const loadedSources = yield* Effect.forEach(
        state.get().sources,
        (source) =>
          Effect.gen(function* () {
            const key = Source.key(source)
            const loaded = cache.get(key) ?? (yield* load(source))
            cache.set(key, loaded)
            return loaded
          }),
        { concurrency: 8 },
      )
      for (const loaded of loadedSources) {
        for (const skill of loaded) {
          const canonical = yield* fs.realPath(skill.location).pipe(Effect.catch(() => Effect.succeed(skill.location)))
          const scope = scopedDirectories
            .filter((item) => FSUtil.contains(item.directory, skill.location) || FSUtil.contains(item.canonical, canonical))
            .sort((left, right) => right.canonical.length - left.canonical.length)[0]?.scope
          if (scope && (!location || !ConfigAgent.projectScopeAllows(scope, location.project.directory))) continue
          skills.set(skill.name, skill)
        }
      }
      // Apply exact-name restrictions outside the source cache. Unlisted skills
      // retain their own modes, including project-specific exceptions.
      return Array.from(skills.values(), (skill) =>
        invocation?.manual.includes(skill.name)
          ? new Info({ ...skill, disableModelInvocation: true })
          : skill,
      )
    })

    return Service.of({
      transform: state.transform,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(SkillDiscovery.defaultLayer))
