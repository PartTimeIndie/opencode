export function pendingAttentionQuestion(
  requests: ReadonlyArray<{ id: string; sessionID: string; mode: string }>,
  sessionID: string,
) {
  return requests.find((request) => request.sessionID === sessionID && request.mode === "blocking")?.id
}
