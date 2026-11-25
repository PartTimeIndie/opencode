export function selectPluginSources(names: string[], args: string[]) {
  if (args.length === 0) return names
  if (args.length !== 1 || !args[0].startsWith("--only=") || !args[0].slice(7) || !names.includes(args[0].slice(7)))
    throw new Error("Expected --only=<existing-plugin-directory>")
  return [args[0].slice(7)]
}
