export * as ReadReceipt from "./read-receipt"

import { FileKnowledge } from "../file-knowledge"
import { ReadToolFileSystem } from "./read-filesystem"
import type { ReadTool } from "./read"

/** Coverage describes complete rendered lines, not the whole-file version hash. */
export function coverage(output: ReadTool.Output): FileKnowledge.Coverage | undefined {
  if ("entries" in output || ("encoding" in output && output.encoding !== "utf8")) return
  const offset = "offset" in output ? output.offset : 1
  const fullLines = "type" in output && output.type === "text-page" && ReadToolFileSystem.rendersFullLines(output)
  const content = output.content.replace(/\r?\n$/, "")
  const lines =
    "lineCount" in output && output.lineCount !== undefined
      ? output.lineCount === 0
        ? []
        : output.content.split(/\r?\n/)
      : output.content === ""
        ? []
        : content.split(/\r?\n/)
  const ranges = lines
    .slice(0, ReadToolFileSystem.MAX_READ_LINES)
    .flatMap((line, index): [number, number][] =>
      !fullLines &&
      (line.length > ReadToolFileSystem.MAX_LINE_LENGTH || line.endsWith(ReadToolFileSystem.MAX_LINE_SUFFIX))
        ? []
        : [[offset + index, offset + index]],
    )
  const end = !("truncated" in output)
    ? offset + lines.length - 1
    : output.truncated
      ? undefined
      : (output.totalLines ??
        (output.content !== "" && !output.content.endsWith("\n") ? offset + lines.length - 1 : undefined))
  return FileKnowledge.merge({ ranges: [] }, { ranges, ...(end === undefined ? {} : { end }) })
}
