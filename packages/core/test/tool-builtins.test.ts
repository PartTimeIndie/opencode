import { describe, expect, test } from "bun:test"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { WriteTool } from "@opencode-ai/core/tool/write"

// The shipped location composition retires edit/write: apply_patch is the
// only general file-write tool OpenCode ships. tool/edit.ts and tool/write.ts
// stay as legacy modules for historical display fixtures; they must never
// re-enter the shipped composition, and their names stay available to
// independently registered location/application/plugin tools.
describe("BuiltInTools composition", () => {
  test("registers neither edit nor write and keeps apply_patch", () => {
    expect(BuiltInTools.composition).not.toContain(EditTool.layer)
    expect(BuiltInTools.composition).not.toContain(WriteTool.layer)
    expect(BuiltInTools.composition).toContain(ApplyPatchTool.layer)
  })
})
