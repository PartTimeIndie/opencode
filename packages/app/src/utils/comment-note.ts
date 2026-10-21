import type { FileSelection } from "@/context/file"

export type PromptComment = {
  path: string
  selection?: FileSelection
  comment: string
  preview?: string
  origin?: "review" | "file"
}

export function formatCommentNote(input: { path: string; selection?: FileSelection; comment: string }) {
  const start = input.selection ? Math.min(input.selection.startLine, input.selection.endLine) : undefined
  const end = input.selection ? Math.max(input.selection.startLine, input.selection.endLine) : undefined
  const range =
    start === undefined || end === undefined
      ? "this file"
      : start === end
        ? `line ${start}`
        : `lines ${start} through ${end}`
  return `The user made the following comment regarding ${range} of ${input.path}: ${input.comment}`
}

export function parseCommentNote(text: string) {
  const match = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  )
  if (!match) return
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined
  return {
    path: match[5],
    selection:
      start !== undefined && end !== undefined
        ? {
            startLine: start,
            startChar: 0,
            endLine: end,
            endChar: 0,
          }
        : undefined,
    comment: match[6],
  } satisfies PromptComment
}
