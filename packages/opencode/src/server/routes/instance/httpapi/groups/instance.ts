import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
}).annotate({ identifier: "Path" })

export const VcsDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  mode: Vcs.Mode,
  context: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
})

export const VcsGitQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
})

export const VcsGitDiscoverQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Vcs.GitDiscoverQuery.fields,
})

export class ApiVcsApplyError extends Schema.ErrorClass<ApiVcsApplyError>("VcsApplyError")(
  {
    name: Schema.Literal("VcsApplyError"),
    data: Schema.Struct({
      message: Schema.String,
      reason: Schema.Literals(["non-git", "not-clean"]),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class ApiVcsGitActionError extends Schema.ErrorClass<ApiVcsGitActionError>("VcsGitActionError")(
  {
    name: Schema.Literal("VcsGitActionError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 500 },
) {}

const ApiVcsGitHistoryErrorData = Schema.Struct({
  message: Schema.String,
  code: Schema.Literals([
    "invalid_ref",
    "invalid_cursor",
    "history_unavailable",
    "shallow_changed",
    "output_limit",
    "process_failed",
  ]),
  recovery: Schema.Literals(["refresh", "retry", "change-selection", "none"]),
})

export class ApiVcsGitHistoryInvalidError extends Schema.ErrorClass<ApiVcsGitHistoryInvalidError>("VcsGitHistoryInvalidError")(
  { name: Schema.Literal("VcsGitHistoryError"), data: ApiVcsGitHistoryErrorData },
  { httpApiStatus: 400 },
) {}

export class ApiVcsGitHistoryStaleError extends Schema.ErrorClass<ApiVcsGitHistoryStaleError>("VcsGitHistoryStaleError")(
  { name: Schema.Literal("VcsGitHistoryError"), data: ApiVcsGitHistoryErrorData },
  { httpApiStatus: 409 },
) {}

export class ApiVcsGitHistoryLimitError extends Schema.ErrorClass<ApiVcsGitHistoryLimitError>("VcsGitHistoryLimitError")(
  { name: Schema.Literal("VcsGitHistoryError"), data: ApiVcsGitHistoryErrorData },
  { httpApiStatus: 413 },
) {}

export class ApiVcsGitHistoryProcessError extends Schema.ErrorClass<ApiVcsGitHistoryProcessError>("VcsGitHistoryProcessError")(
  { name: Schema.Literal("VcsGitHistoryError"), data: ApiVcsGitHistoryErrorData },
  { httpApiStatus: 502 },
) {}

export const ApiVcsGitHistoryErrors = [
  ApiVcsGitHistoryInvalidError,
  ApiVcsGitHistoryStaleError,
  ApiVcsGitHistoryLimitError,
  ApiVcsGitHistoryProcessError,
] as const

export const InstancePaths = {
  dispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  vcsGit: "/vcs/git",
  vcsGitHistory: "/vcs/git/history",
  vcsGitCommitMessage: "/vcs/git/commit-message",
  vcsGitDiscover: "/vcs/git/discover",
  vcsGitAction: "/vcs/git/action",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
  formatter: "/formatter",
} as const

export const InstanceApi = HttpApi.make("instance")
  .add(
    HttpApiGroup.make("instance")
      .add(
        HttpApiEndpoint.post("dispose", InstancePaths.dispose, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Instance disposed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", InstancePaths.path, {
          query: WorkspaceRoutingQuery,
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description:
              "Retrieve the current working directory and related path information for the OpenCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", InstancePaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: described(Vcs.Info, "VCS info"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description:
              "Retrieve version control system (VCS) information for the current project, such as git branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", InstancePaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Vcs.FileStatus), "VCS status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve changed files in the current working tree without patches.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", InstancePaths.vcsDiff, {
          query: VcsDiffQuery,
          success: described(Schema.Array(Vcs.FileDiff), "VCS diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current git diff for the working tree or against the default branch.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", InstancePaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/x-diff; charset=utf-8" })),
            "Raw VCS diff",
          ),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff.raw",
            summary: "Get raw VCS diff",
            description: "Retrieve a raw patch for current uncommitted changes.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", InstancePaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.ApplyInput,
          success: described(Vcs.ApplyResult, "VCS patch applied"),
          error: ApiVcsApplyError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a raw patch to the current working tree.",
          }),
        ),
        HttpApiEndpoint.get("vcsGit", InstancePaths.vcsGit, {
          query: VcsGitQuery,
          success: described(Vcs.GitSnapshot, "Git workbench snapshot"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.git",
            summary: "Get Git workbench snapshot",
            description: "Retrieve status, history, branches, remotes, tags, stashes, conflicts, and operation state.",
          }),
        ),
        HttpApiEndpoint.post("vcsGitHistory", InstancePaths.vcsGitHistory, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.GitHistoryRequest,
          success: described(Vcs.GitHistoryPage, "Git history page"),
          error: ApiVcsGitHistoryErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.git.history",
            summary: "Get a filtered Git history page",
            description:
              "Retrieve one page of a branch-filtered, anchored commit history. Initial requests pass a selector; continuations pass the opaque cursor only.",
          }),
        ),
        HttpApiEndpoint.post("vcsGitCommitMessage", InstancePaths.vcsGitCommitMessage, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.GitCommitMessageRequest,
          success: described(Vcs.GitCommitMessagePage, "Git commit message chunk"),
          error: ApiVcsGitHistoryErrors,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.git.commit-message",
            summary: "Get a chunk of a full commit message",
            description:
              "Retrieve the next char-safe chunk of a commit message for commits whose body was truncated in the history page.",
          }),
        ),
        HttpApiEndpoint.get("vcsGitDiscover", InstancePaths.vcsGitDiscover, {
          query: VcsGitDiscoverQuery,
          success: described(Vcs.GitDiscoverResult, "Discovered Git repositories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.git.discover",
            summary: "Discover nested Git repositories",
            description: "Find Git repositories below the current directory up to a bounded depth.",
          }),
        ),
        HttpApiEndpoint.post("vcsGitAction", InstancePaths.vcsGitAction, {
          query: WorkspaceRoutingQuery,
          payload: Vcs.GitActionInput,
          success: described(Vcs.GitActionResult, "Git action result"),
          error: ApiVcsGitActionError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.git.action",
            summary: "Run Git workbench action",
            description: "Run a controlled Git action for the Git Workbench app plugin.",
          }),
        ),
        HttpApiEndpoint.get("command", InstancePaths.command, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Command.Info), "List of commands"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("agent", InstancePaths.agent, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "List of agents"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("skill", InstancePaths.skill, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.Info), "List of skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", InstancePaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(LSP.Status), "LSP server status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status",
          }),
        ),
        HttpApiEndpoint.get("formatter", InstancePaths.formatter, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Format.Status), "Formatter status"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "formatter.status",
            summary: "Get formatter status",
            description: "Get formatter status",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "instance",
          description: "Experimental HttpApi instance read routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
