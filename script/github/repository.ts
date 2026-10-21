export function requireRepository(value: string | undefined) {
  if (!value) throw new Error("Repository is required; set GITHUB_REPOSITORY or pass --repo where supported")
  if (value.trim() !== value || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(value))
    throw new Error(`Invalid repository ${value}; expected owner/name`)

  const [owner, name] = value.split("/")
  if (name === "." || name === "..") throw new Error(`Invalid repository ${value}; expected owner/name`)
  return { owner, name }
}
