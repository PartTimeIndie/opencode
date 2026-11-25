export * as BuiltInTools from "./builtins"

import { Layer } from "effect"
import { BashTool } from "./bash"
import { BrowserTool } from "./browser"
import { ApplyPatchTool } from "./apply-patch"
import { GitStatusTool } from "./git-status"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ImageGenerateTool } from "./image-generate"
import { SurfaceTool } from "./surface"
import { ReadTool } from "./read"
import { ReadToolFileSystem } from "./read-filesystem"
import { SessionReadTool } from "./session-read"
import { SessionSendTool } from "./session-send"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { PlanDocumentTool } from "./plan-document"
import { AgentSwitchTool } from "./agent-switch"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped canonical registrations, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared Location
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: LSP,
 * repo_clone, repo_overview, and Rune/code mode. Keep MCP and plugin
 * transforms separate from this static built-in list.
 */
/**
 * Inspectable composition of every shipped location-scoped tool. The retired
 * edit/write leaves stay absent by contract (apply_patch is the only shipped
 * general file-write tool); tool/edit.ts and tool/write.ts remain as legacy
 * modules for historical display fixtures, never registered here.
 */
export const composition = [
  ApplyPatchTool.layer,
  BashTool.layer,
  BrowserTool.layer.pipe(Layer.provide(BrowserTool.defaultBridgeLayer)),
  GitStatusTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  ImageGenerateTool.layer,
  SurfaceTool.layer,
  ReadTool.layer.pipe(Layer.provide(ReadToolFileSystem.layer)),
  SessionReadTool.layer,
  SessionSendTool.layer,
  SkillTool.layer,
  TodoWriteTool.layer,
  WebFetchTool.layer,
  WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
  PlanDocumentTool.layer,
  AgentSwitchTool.layer,
] as const

export const locationLayer = Layer.mergeAll(...composition)
