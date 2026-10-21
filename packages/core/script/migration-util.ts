export function matchesGeneratedFile(actual: string, expected: string) {
  return actual.replaceAll("\r\n", "\n") === expected.replaceAll("\r\n", "\n")
}
