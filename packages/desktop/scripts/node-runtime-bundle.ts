const forbidden =
  /(?:from\s*|import\s+|import\(|require\()[\s"']*bun:[^"']*|\bBun\.(?:CryptoHasher|spawn|file|hash|listen|serve|sleep|write)\b/g

export function findForbiddenNodeRuntimeAPIs(source: string) {
  return source.match(forbidden) ?? []
}
