import { Project } from "@/project/project"
import { ProjectIcon } from "@/project/icon"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ProjectNotFoundError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/project"
const UpdatePayload = Schema.Struct({
  name: Project.UpdatePayload.fields.name,
  icon: Project.UpdatePayload.fields.icon,
  iconGeneration: Project.UpdatePayload.fields.iconGeneration,
  commands: Project.UpdatePayload.fields.commands,
})
const GenerateIconPayload = Schema.Struct({ force: Schema.optional(Schema.Boolean) })

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Project.Info), "List of projects"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OpenCode.",
          }),
        ),
        HttpApiEndpoint.get("current", `${root}/current`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Current project information"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OpenCode is working with.",
          }),
        ),
        HttpApiEndpoint.post("initGit", `${root}/git/init`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Project information after git initialization"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", `${root}/:projectID`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Project.Info, "Updated project information"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError, ProjectIcon.InvalidIconError],
         }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
        HttpApiEndpoint.post("generateIcon", `${root}/:projectID/icon/generate`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          payload: GenerateIconPayload,
          success: described(Project.Info, "Project with queued icon generation"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.generateIcon",
            summary: "Generate project icon",
            description: "Queue automatic image generation for a project's icon.",
          }),
        ),
        HttpApiEndpoint.post("retryIcon", `${root}/:projectID/icon/retry`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(Project.Info, "Project with retried icon generation"),
          error: [HttpApiError.BadRequest, ProjectNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.retryIcon",
            summary: "Retry project icon generation",
            description: "Retry automatic image generation after a failed or interrupted attempt.",
          }),
        ),
        HttpApiEndpoint.get("directories", `${root}/:projectID/directories`, {
          params: { projectID: ProjectV2.ID },
          query: WorkspaceRoutingQuery,
          success: described(ProjectV2.Directories, "Project directories"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directories",
            summary: "List project directories",
            description: "List known local absolute directories for a project.",
          }),
        ),
        HttpApiEndpoint.get("directoryIcons", `${root}/directory-icons`, {
          query: WorkspaceRoutingQuery,
          success: described(Project.DirectoryIcons, "Directory icons"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directoryIcons",
            summary: "List directory icons",
            description: "List the icons stored for directories that have no project row of their own.",
          }),
        ),
        HttpApiEndpoint.put("directoryIcon", `${root}/directory-icon`, {
          query: WorkspaceRoutingQuery,
          payload: Project.DirectoryIconInput,
          success: described(Project.DirectoryIconUpdate, "Stored directory icon, or the directory alone once cleared"),
          error: [HttpApiError.BadRequest, ProjectIcon.InvalidIconError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.directoryIcon",
            summary: "Set or clear a directory icon",
            description:
              "Store a 128px thumbnail of an uploaded image for a directory. An omitted or empty url clears the icon.",
          }),
        ),
        HttpApiEndpoint.post("resolve", `${root}/resolve`, {
          query: WorkspaceRoutingQuery,
          payload: Project.ResolveDirectoriesInput,
          success: described(Project.ResolvedDirectories, "Resolved directories in request order"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.resolve",
            summary: "Resolve directories",
            description:
              "Resolve junctions, symlinks and alias spellings to the real directory on the server host and report whether it exists.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "Experimental HttpApi project routes.",
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
