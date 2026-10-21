import { describe, expect, test } from "bun:test"
import { mkdir } from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import path from "path"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { SurfaceTool } from "@opencode-ai/core/tool/surface"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { TodoWriteTool } from "@opencode-ai/core/tool/todowrite"
import { WebFetchTool } from "@opencode-ai/core/tool/webfetch"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { tmpdir } from "./fixture/tmpdir"

const fixturePath = (resource: string) => path.resolve("/repo", resource)

const checkpoint = (resource: string) => ({
  target: fixturePath(resource),
  resource,
  before: { exists: true as const, bytes: 6, sha256: "before" },
  after: { exists: true as const, bytes: 5, sha256: "after" },
})

const builtinFiles = [
  "apply-patch.ts",
  "bash.ts",
  "edit.ts",
  "glob.ts",
  "grep.ts",
  "surface.ts",
  "read.ts",
  "skill.ts",
  "task.ts",
  "todowrite.ts",
  "webfetch.ts",
  "websearch.ts",
  "write.ts",
]

describe("Core tool output contract baseline", () => {
  test("snapshots model-visible output formatters", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, "clipboard-attachments"), { recursive: true })
    await Bun.write(path.join(tmp.path, "clipboard-attachments", "answer.txt"), "hello")

    const skillDirectory = path.dirname(AbsolutePath.make("/repo/skills/demo/SKILL.md"))
    const attachmentUrl = pathToFileURL(path.join(tmp.path, "clipboard-attachments", "answer.txt")).href

    expect({
      applyPatch: ApplyPatchTool.toModelOutput({
        applied: [
          { type: "add", resource: "src/new.ts", target: fixturePath("src/new.ts"), checkpoint: checkpoint("src/new.ts") },
          { type: "update", resource: "src/app.ts", target: fixturePath("src/app.ts"), checkpoint: checkpoint("src/app.ts") },
          { type: "delete", resource: "src/old.ts", target: fixturePath("src/old.ts"), checkpoint: checkpoint("src/old.ts") },
        ],
      }),
      bash: BashTool.toModelOutput({
        command: "printf hi",
        cwd: fixturePath("."),
        exitCode: 0,
        output: "hi",
        truncated: false,
      }),
      bashTimedOut: BashTool.toModelOutput({
        command: "sleep 60",
        cwd: fixturePath("."),
        output: "Command exceeded timeout of 10 ms. Retry with a larger timeout if the command is expected to take longer.",
        truncated: false,
        timedOut: true,
        warnings: ["Command argument references external directory /tmp/*."],
      }),
      edit: EditTool.toModelOutput(
        {
          operation: "write",
          target: fixturePath("src/app.ts"),
          resource: "src/app.ts",
          existed: true,
          replacements: 1,
          checkpoint: checkpoint("src/app.ts"),
        },
        "before\nsecond line",
        "after\nsecond line",
      ),
      globEmpty: GlobTool.toModelOutput([]),
      globResults: GlobTool.toModelOutput([
        { path: fixturePath("src/app.ts"), type: "file", mime: "text/typescript" },
        { path: fixturePath("src/session/index.ts"), type: "file", mime: "text/typescript" },
      ]),
      grepEmpty: GrepTool.toModelOutput([]),
      grepResults: GrepTool.toModelOutput([
        {
          entry: { path: fixturePath("src/app.ts"), type: "file", mime: "text/typescript" },
          line: 12,
          offset: 2,
          text: "const needle = true",
          submatches: [],
        },
        {
          entry: { path: fixturePath("src/session/index.ts"), type: "file", mime: "text/typescript" },
          line: 3,
          offset: 0,
          text: "needle()",
          submatches: [],
        },
      ]),
      surfaceAnswered: SurfaceTool.toModelOutput(
        { mode: "blocking", questions: [{ question: "Ship it?" }] },
        { mode: "blocking", answers: [["yes", "after tests"]] },
      ),
      surfaceInteractive: SurfaceTool.toModelOutput(
        { mode: "interactive", version: 1, controlID: "draft", controls: [] },
        { mode: "interactive", requestID: "que_surface_output", revision: 1, controlID: "draft" },
      ),
      surfaceContent: SurfaceTool.toModelContent(
        { mode: "blocking", questions: [{ question: "Upload evidence?" }] },
        {
          mode: "blocking",
          answers: [["attached", { type: "file", mime: "text/plain", url: attachmentUrl, filename: "answer.txt" }]],
        },
      ),
      readImage: ReadTool.toModelOutput(
        { path: "diagram.png" },
        { uri: "file:///repo/diagram.png", content: "aGVsbG8=", encoding: "base64", mime: "image/png" },
      ),
      readPdf: ReadTool.toModelOutput(
        { path: "document.pdf" },
        { uri: "file:///repo/document.pdf", content: "JVBERi0x", encoding: "base64", mime: "application/pdf" },
      ),
      readDirectory: ReadTool.toModelOutput(
        { path: "src" },
        {
          entries: [
            { path: "components\\", type: "directory", mime: "application/x-directory" },
            { path: "index.ts", type: "file", mime: "text/typescript" },
          ],
          truncated: true,
          next: 3,
        },
      ),
      readText: ReadTool.toModelOutput(
        { path: "notes.txt" },
        { uri: "file:///repo/notes.txt", content: "plain text", encoding: "utf8", mime: "text/plain" },
      ),
      readTextTrailingNewline: ReadTool.toModelOutput(
        { path: "source.ts" },
        { uri: "file:///repo/source.ts", content: "first\nsecond\n", encoding: "utf8", mime: "text/typescript" },
      ),
      skill: SkillTool.toModelOutput(
        new SkillV2.Info({
          name: "demo-skill",
          location: AbsolutePath.make("/repo/skills/demo/SKILL.md"),
          content: "Use this skill carefully.\n",
        }),
        ["/repo/skills/demo/scripts/run.ts", "/repo/skills/demo/reference.md"],
      ),
      task: TaskTool.renderOutput({
        sessionID: SessionSchema.ID.make("ses_task_contract"),
        task_id: SessionSchema.ID.make("ses_task_contract"),
        state: "completed",
        text: "Task finished",
      }),
      todoWrite: TodoWriteTool.toModelOutput({
        todos: [
          { content: "write baseline", status: "completed", priority: "high" },
          { content: "run tests", status: "pending", priority: "medium" },
        ],
      }),
      writeCreated: WriteTool.toModelOutput({
        operation: "write",
        target: fixturePath("src/new.ts"),
        resource: "src/new.ts",
        existed: false,
        checkpoint: {
          target: fixturePath("src/new.ts"),
          resource: "src/new.ts",
          before: { exists: false },
          after: { exists: true, bytes: 7, sha256: "new" },
        },
      }),
      writeUpdated: WriteTool.toModelOutput({
        operation: "write",
        target: fixturePath("src/app.ts"),
        resource: "src/app.ts",
        existed: true,
        checkpoint: checkpoint("src/app.ts"),
      }),
      webfetch: WebFetchTool.toModelOutput({
        url: "https://example.com",
        contentType: "text/plain; charset=utf-8",
        format: "text",
        output: "Example body",
      }),
      websearch: WebSearchTool.toModelOutput({ provider: "exa", text: "Result one\nResult two" }),
    }).toEqual({
      applyPatch: "Applied patch sequentially:\nA src/new.ts\nM src/app.ts\nD src/old.ts",
      bash: "hi\n\nCommand exited with code 0.",
      bashTimedOut:
        "Command exceeded timeout of 10 ms. Retry with a larger timeout if the command is expected to take longer.\n\nWarnings:\n- Command argument references external directory /tmp/*.\n\nCommand timed out before completion.",
      edit: "Edited file successfully: src/app.ts\nReplacements: 1\n```diff\n-before\n-second line\n+after\n+second line\n```",
      globEmpty: "No files found",
      globResults: `${fixturePath("src/app.ts")}\n${fixturePath("src/session/index.ts")}`,
      grepEmpty: "No files found",
      grepResults:
        `Found 2 matches\n${fixturePath("src/app.ts")}:\n  Line 12: const needle = true\n\n${fixturePath("src/session/index.ts")}:\n  Line 3: needle()`,
      surfaceAnswered:
        'User has answered your questions: "Ship it?"="yes, after tests". You can now continue with the user\'s answers in mind.',
      surfaceInteractive: "Opened interactive Surface draft (que_surface_output, revision 1).",
      surfaceContent: [
        {
          type: "text",
          text: `User has answered your questions: "Upload evidence?"="attached, [file: answer.txt (text/plain) ${attachmentUrl}]". You can now continue with the user's answers in mind.`,
        },
        { type: "file", data: "aGVsbG8=", mime: "text/plain", name: "answer.txt" },
      ],
      readImage: [
        { type: "text", text: "Image read successfully" },
        { type: "file", data: "aGVsbG8=", mime: "image/png", name: "diagram.png" },
      ],
      readPdf: [
        { type: "text", text: "PDF read successfully" },
        { type: "file", data: "JVBERi0x", mime: "application/pdf", name: "document.pdf" },
      ],
      readDirectory: [
        {
          type: "text",
          text: "<path>src</path>\n<type>directory</type>\n<entries>\ncomponents/\nindex.ts\n(Showing 2 entries. Use 'offset' parameter to read beyond entry 3)\n</entries>",
        },
      ],
      readText: [
        {
          type: "text",
          text: "<path>notes.txt</path>\n<type>file</type>\n<content>\n1: plain text\n\n(End of file - total 1 lines)\n</content>",
        },
      ],
      readTextTrailingNewline: [
        {
          type: "text",
          text: "<path>source.ts</path>\n<type>file</type>\n<content>\n1: first\n2: second\n\n(End of file - total 2 lines)\n</content>",
        },
      ],
      skill:
        `<skill_content name="demo-skill">\n# Skill: demo-skill\n\nUse this skill carefully.\n\nBase directory for this skill: ${pathToFileURL(skillDirectory).href}\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file>/repo/skills/demo/scripts/run.ts</file>\n<file>/repo/skills/demo/reference.md</file>\n</skill_files>\n</skill_content>`,
      task: '<task id="ses_task_contract" state="completed">\n<task_result>\nTask finished\n</task_result>\n</task>',
      todoWrite:
        '[\n  {\n    "content": "write baseline",\n    "status": "completed",\n    "priority": "high"\n  },\n  {\n    "content": "run tests",\n    "status": "pending",\n    "priority": "medium"\n  }\n]',
      writeCreated: "Created file successfully: src/new.ts",
      writeUpdated: "Wrote file successfully: src/app.ts",
      webfetch: [{ type: "text", text: "Example body" }],
      websearch: [{ type: "text", text: "Result one\nResult two" }],
    })
  })

  test("shipped Core built-in tool leaves are constructed with Tool.make", async () => {
    const toolDirectory = fileURLToPath(new URL("../src/tool/", import.meta.url))
    const sources = Object.fromEntries(
      await Promise.all(
        builtinFiles.map(async (file) => [file, await Bun.file(path.join(toolDirectory, file)).text()] as const),
      ),
    )

    expect(
      Object.fromEntries(builtinFiles.map((file) => [file, sources[file]!.includes("Tool.make(")])),
    ).toEqual(Object.fromEntries(builtinFiles.map((file) => [file, true])))
  })

  test("read formatter preserves page guidance for capped full-file text", () => {
    const output = ReadTool.toModelOutput(
      { path: "many-lines.txt" },
      {
        uri: "file:///repo/many-lines.txt",
        content: `${"x".repeat(2_001)}\n${Array.from({ length: 2_000 }, (_, index) => `line-${index}`).join("\n")}`,
        encoding: "utf8",
        mime: "text/plain",
      },
    )

    expect(output).toHaveLength(1)
    expect(output[0]?.type).toBe("text")
    if (output[0]?.type !== "text") return
    expect(output[0].text).toContain("... (line truncated to 2000 chars)")
    expect(output[0].text).toContain("(Showing lines 1-2000 of 2001. Use offset=2001 to continue.)")
    expect(output[0].text).not.toContain("2001: line-1999")
  })
})
