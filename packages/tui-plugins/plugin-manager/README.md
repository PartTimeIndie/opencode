# plugin-manager

Independent OpenCode TUI plugin. Requires public TUI API version 2.

Run `bun run build`, `bun typecheck`, then load the package with OpenCode's TUI plugin configuration. The `./tui` export is the built artifact. Solid and OpenTUI are shared peer dependencies so host contexts and renderers retain one identity.
