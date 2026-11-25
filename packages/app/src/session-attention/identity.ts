import { directoryKey } from "@/utils/path-key"

/** Session activity and tab events may spell the same Windows directory differently. */
export function attentionKey(server: string, directory: string, sessionID: string) {
  return `${server}\n${directoryKey(directory)}\n${sessionID}`
}

export function sameAttentionTarget(left: { directory: string; sessionID: string }, right: { directory: string; sessionID: string }) {
  return left.sessionID === right.sessionID && directoryKey(left.directory) === directoryKey(right.directory)
}
