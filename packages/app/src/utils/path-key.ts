export type PathKey = string & { _brand: "PathKey" }

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  const trimmed = trimTrailingSlashes(value)
  if (!trimmed && value.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}

export const directoryKey = (path: string) => {
  const key = pathKey(path)
  if (isWindowsPath(path) || key.startsWith("//")) return key.toLowerCase() as PathKey
  return key
}

// Do not resolve parent segments: a symlink can change what `..` means.
export const projectWorktreeKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  return directoryKey(value.replace(/\/\.(?=\/|$)\/?/g, "/"))
}

export const projectDirectoryKey = (path: string) => {
  const value = path.replaceAll("\\", "/")
  const segments = value.split("/").reduce<string[]>((parts, segment) => {
    if (!segment || segment === ".") return parts
    if (segment === ".." && parts.length > 0 && parts.at(-1) !== "..") return parts.slice(0, -1)
    return [...parts, segment]
  }, [])
  const prefix = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : ""
  const normalized = /^[A-Za-z]:$/.test(segments[0] ?? "") && segments.length === 1
    ? `${segments[0]}/`
    : `${prefix}${segments.join("/")}` || "/"
  return /^[A-Za-z]:\//.test(normalized) || prefix === "//" ? normalized.toLowerCase() : normalized
}
