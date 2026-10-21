export type Runtime = {
  PublicApi: (typeof import("../../../src/server/routes/instance/httpapi/public"))["PublicApi"]
  HttpApiApp: (typeof import("../../../src/server/routes/instance/httpapi/server"))["HttpApiApp"]
  AppLayer: (typeof import("../../../src/effect/app-runtime"))["AppLayer"]
  memoMap: import("effect").Layer.MemoMap
  InstanceRef: (typeof import("../../../src/effect/instance-ref"))["InstanceRef"]
  InstanceStore: (typeof import("../../../src/project/instance-store"))["InstanceStore"]
  Session: (typeof import("../../../src/session/session"))["Session"]
  SessionActivity: (typeof import("@opencode-ai/core/session/activity"))["SessionActivity"]
  Question: (typeof import("@opencode-ai/core/question"))["QuestionV2"]
  Database: (typeof import("@opencode-ai/core/database/database"))["Database"]
  EventV2: (typeof import("@opencode-ai/core/event"))["EventV2"]
  Todo: (typeof import("../../../src/session/todo"))["Todo"]
  Worktree: (typeof import("../../../src/worktree"))["Worktree"]
  Project: (typeof import("../../../src/project/project"))["Project"]
  Tui: typeof import("../../../src/server/shared/tui-control")
  disposeAllInstances: (typeof import("../../fixture/fixture"))["disposeAllInstances"]
  tmpdir: (typeof import("../../fixture/fixture"))["tmpdir"]
  resetDatabase: (typeof import("../../fixture/db"))["resetDatabase"]
}

let runtimePromise: Promise<Runtime> | undefined

export function runtime() {
  return (runtimePromise ??= (async () => {
    const publicApi = await import("../../../src/server/routes/instance/httpapi/public")
    const httpApiServer = await import("../../../src/server/routes/instance/httpapi/server")
    const appRuntime = await import("../../../src/effect/app-runtime")
    const { Layer } = await import("effect")
    const instanceRef = await import("../../../src/effect/instance-ref")
    const instanceStore = await import("../../../src/project/instance-store")
    const session = await import("../../../src/session/session")
    const sessionActivity = await import("@opencode-ai/core/session/activity")
    const { QuestionV2 } = await import("@opencode-ai/core/question")
    const { Database } = await import("@opencode-ai/core/database/database")
    const { EventV2 } = await import("@opencode-ai/core/event")
    const todo = await import("../../../src/session/todo")
    const worktree = await import("../../../src/worktree")
    const project = await import("../../../src/project/project")
    const tui = await import("../../../src/server/shared/tui-control")
    const fixture = await import("../../fixture/fixture")
    const db = await import("../../fixture/db")
    return {
      PublicApi: publicApi.PublicApi,
      HttpApiApp: httpApiServer.HttpApiApp,
      AppLayer: appRuntime.AppLayer,
      memoMap: Layer.makeMemoMapUnsafe(),
      InstanceRef: instanceRef.InstanceRef,
      InstanceStore: instanceStore.InstanceStore,
      Session: session.Session,
      SessionActivity: sessionActivity.SessionActivity,
      Question: QuestionV2,
      Database,
      EventV2,
      Todo: todo.Todo,
      Worktree: worktree.Worktree,
      Project: project.Project,
      Tui: tui,
      disposeAllInstances: fixture.disposeAllInstances,
      tmpdir: fixture.tmpdir,
      resetDatabase: db.resetDatabase,
    }
  })())
}
