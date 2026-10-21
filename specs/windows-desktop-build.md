# Windows Desktop Build Runbook

Use this for local Windows desktop builds.

## Build

- Work from `packages/desktop`.
- Use the development channel by default: `OPENCODE_CHANNEL=dev`.
- Build command: `bun run build`.
- Package command: `bun run package:win`.

## Outputs

- Intermediate build output goes under `packages/desktop/out/`.
- The Windows installer is `packages/desktop/dist/opencode-desktop-win-x64.exe`.

## Safety

- Do not use the production channel for local smoke builds unless the user explicitly asks for it. A production-channel install can overwrite the installed desktop app.
- If the app aborts on startup, check the Windows notification text and sidecar logs before broad debugging; custom tool import failures in `.opencode/tool` and `.opencode/tools` are a known first suspect.
