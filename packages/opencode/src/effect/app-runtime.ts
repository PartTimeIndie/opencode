import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "@opencode-ai/core/observability"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { Auth } from "@/auth"
import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { Git } from "@/git"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Storage } from "@/storage/storage"
import { Snapshot } from "@/snapshot"
import { Plugin } from "@/plugin"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Provider } from "@/provider/provider"
import { ProviderAuth } from "@/provider/auth"
import { HeadlessAI } from "@/headless-ai"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "@/session/revert"
import { SessionRevertRepair } from "@/session/revert-repair"
import { SessionSummary } from "@/session/summary"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Format } from "@/format"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { Workspace } from "@/control-plane/workspace"
import { Worktree } from "@/worktree"
import { Installation } from "@/installation"
import { ShareNext } from "@/share/share-next"
import { SessionShare } from "@/share/session"
import { Npm } from "@opencode-ai/core/npm"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { BackgroundJob } from "@/background/job"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"

export const AppLayer = Layer.mergeAll(
  Npm.defaultLayer,
  FSUtil.defaultLayer,
  Database.defaultLayer,
  Auth.defaultLayer,
  Account.defaultLayer,
  Config.defaultLayer,
  Git.defaultLayer,
  Storage.defaultLayer,
  Snapshot.defaultLayer,
  Plugin.defaultLayer,
  ModelsDev.defaultLayer,
  Provider.defaultLayer,
  ProviderAuth.defaultLayer,
  HeadlessAI.defaultLayer,
  Agent.defaultLayer,
  Skill.defaultLayer,
  Discovery.defaultLayer,
  Permission.defaultLayer,
  Todo.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  BackgroundJob.defaultLayer,
  RuntimeFlags.defaultLayer,
  EventV2Bridge.defaultLayer,
  SessionRunState.defaultLayer,
  SessionRevert.defaultLayer,
  SessionRevertRepair.defaultLayer,
  SessionSummary.defaultLayer,
  Instruction.defaultLayer,
  LLM.defaultLayer,
  LSP.defaultLayer,
  MCP.defaultLayer,
  McpAuth.defaultLayer,
  Command.defaultLayer,
  Format.defaultLayer,
  Project.defaultLayer,
  Vcs.defaultLayer,
  Workspace.defaultLayer,
  Worktree.appLayer,
  Installation.defaultLayer,
  ShareNext.defaultLayer,
  SessionShare.defaultLayer,
).pipe(
  Layer.provideMerge(Ripgrep.defaultLayer),
  Layer.provideMerge(InstanceLayer.layer),
  Layer.provideMerge(Observability.layer),
)

const rt = ManagedRuntime.make(AppLayer, { memoMap })
type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">

/** Services provided by AppRuntime — i.e. what an Effect run via AppRuntime.runPromise can yield. */
export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof rt>
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

export const AppRuntime: Runtime = {
  runSync(effect) {
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}

const runtimeGlobal = globalThis as typeof globalThis & {
  [key: symbol]: (() => Promise<void>) | undefined
}
runtimeGlobal[Symbol.for("opencode.app-runtime.dispose")] = AppRuntime.dispose
