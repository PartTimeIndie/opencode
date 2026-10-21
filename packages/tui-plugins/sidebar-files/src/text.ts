export function truncateLeft(str: string, len: number): string {
  if (str.length <= len) return str
  return "…" + str.slice(-(len - 1))
}
