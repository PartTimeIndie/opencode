# Desktop package notes

- Renderer process should only call `window.api` from `src/preload`.
- Main process should register IPC handlers in `src/main/ipc.ts`.

## Local document links

- Markdown may preserve local `file:` destinations on explicit anchors only. Do not allow file sources on images or frames, or broaden the embedded browser's HTTP(S)-only URL policy.
- Route document clicks through the trusted desktop `open-link` IPC and `openDesktopLink`, which validates local paths and document types before calling `shell.openPath`. Keep network/device paths and executable file types blocked, and surface OS opening errors rather than dropping clicks silently.
- Cover both Markdown sanitization and the main-process opening boundary, including encoded filenames and rejection paths. Confirm the installed app only after a verified full-package prod deployment.
- Security rejection tests must prove validation, not just missing-file errors: test the path policy directly and use existing unsafe files at the OS-opening boundary. Check the runtime's real URL-decoding behavior before adding duplicate guards.
- Local Markdown links use the document-opening path, not a preview control that tries to fetch `file:`. Installed QA must verify selection and restoration of the requested Session; a dispatched click or absence of renderer errors alone does not prove that the OS viewer opened.
