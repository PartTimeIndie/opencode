// The desktop launcher starts the compiled CLI binary with its embedded Bun exec
// flags followed by a bare "--" separator (see script/build.ts `execArgv`), and
// external review runners replay that exact command line. Strict yargs parsing
// rejects those unknown flags with the general help output, so this launcher
// prefix must be stripped before parsing. A user-typed bare "--" is left intact:
// the prefix is only removed when it consists solely of launcher exec flags and
// is actually terminated by the separator.
export function stripLauncherExecArgs(argv: string[]): string[] {
  let index = 0
  while (index < argv.length && isLauncherExecFlag(argv[index])) {
    index++
  }
  if (index === 0 || argv[index] !== "--") return argv
  return argv.slice(index + 1)
}

function isLauncherExecFlag(arg: string): boolean {
  return arg === "--user-agent" || arg.startsWith("--user-agent=") || arg === "--use-system-ca"
}
