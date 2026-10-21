import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "./project"
import { AbsolutePath, optionalOmitUndefined } from "./schema"
import { WorkspaceV2 } from "./workspace"
import { FSUtil } from "./fs-util"

export * as Location from "./location"

export class Ref extends Schema.Class<Ref>("Location.Ref")({
  directory: AbsolutePath,
  workspaceID: Schema.optional(WorkspaceV2.ID).pipe(Schema.withConstructorDefault(Effect.succeed(undefined))),
}) {}

export function identity(ref: Pick<Ref, "directory" | "workspaceID">) {
  const directory = FSUtil.normalizePath(ref.directory)
  return `${ref.workspaceID ?? ""}\u0000${process.platform === "win32" ? directory.replaceAll("/", "\\").toLowerCase() : directory}`
}

export function same(left: Pick<Ref, "directory" | "workspaceID">, right: Pick<Ref, "directory" | "workspaceID">) {
  return identity(left) === identity(right)
}

export class Info extends Schema.Class<Info>("Location.Info")({
  directory: AbsolutePath,
  workspaceID: optionalOmitUndefined(WorkspaceV2.ID),
  project: Schema.Struct({
    id: Project.ID,
    directory: AbsolutePath,
  }),
}) {}

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export function response<S extends Schema.Top>(data: S) {
  return Schema.Struct({ location: Info, data })
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
      })
    }),
  )
