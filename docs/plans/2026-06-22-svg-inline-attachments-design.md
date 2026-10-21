# SVG Inline Attachments Design

## Quick Overview

- [Problem](#problem): SVG attachments are not reliably available as inline chat previews.
- [Findings](#findings): The likely break is between tool file-content output and UI attachment rendering, not only SVG MIME detection.
- [Recommendation](#recommendation): Populate tool-state attachments from file content, render SVGs through a safe expandable preview path, and keep download fallback.
- [Key Changes](#key-changes): Fix core message state first, then centralize UI MIME fallback and SVG rendering behavior.
- [Tests](#tests): Add focused core/UI regression coverage and run package-scoped typechecks/tests only.
- [Implementierungs-Reihenfolge & Parallelisierung](#implementierungs-reihenfolge--parallelisierung): Workstreams can split after the data contract is confirmed.

## Problem

SVGs are currently not correctly attached/rendered inline in chat. The desired behavior is an inline-capable, safe preview: SVGs should be visible from the message attachment area through an expandable preview, with a normal download/open fallback.

Planning decisions from the Octto flow:

- Start investigation at the attach/tool-output side.
- Target a strict safe SVG policy rather than blindly treating every SVG as a normal raster image.
- Prefer an expandable preview over always rendering raw SVG directly in the timeline.
- Use the approved implementation sequence: trace metadata, fix MIME/security, fix UI, then add regression tests and verification.

## Findings

### Attachment pipeline

- `packages/opencode/src/tool/attach.ts` creates tool-output attachments as data URLs with MIME and filename metadata.
- `packages/opencode/src/session/tools.ts` adds durable metadata to legacy tool attachments.
- `packages/opencode/src/session/processor.ts` maps legacy attachments into V2 file content entries like `{ type: "file", uri, mime, name }`.
- `packages/core/src/session/message.ts` has `ToolStateCompleted.attachments?: FileAttachment[]`, but `packages/core/src/session/message-updater.ts` currently handles `session.next.tool.success` with `content` and does not populate `attachments` from file content.
- `packages/ui/src/components/message-part.tsx` passes `part().state.attachments` into the `attach` renderer, so V2 tool success events that only carry `content` can lose the inline attachment path.

### SVG MIME and safety

- `packages/opencode/src/util/media.ts` intentionally excludes `image/svg+xml` from generic image attachment handling in some paths.
- Tool-generated data URLs can still carry `image/svg+xml`.
- SVG should not be treated exactly like trusted raster formats because script, external references, and embedded content can create security and rendering risks.
- The selected policy is: allow a safe expandable inline preview for generated/attached SVG file content, but preserve a download fallback and avoid broad unsafe SVG execution assumptions.

### UI rendering

- `packages/ui/src/components/message-file.ts` classifies attachments mainly by `part.mime`; if MIME is missing or generic, a `data:image/svg+xml...` URL can be rendered as a generic file card.
- `packages/ui/src/components/message-part.tsx` has both assistant file rendering and an `attach` tool renderer. The attach renderer already has helpers that parse MIME from a data URL (`attachDataMime`, `attachToolMime`, `attachToolKind`).
- `packages/ui/src/components/file-media.tsx` already has SVG-specific preview behavior for file views and is a useful reference for safe SVG handling.

### Tests and verification

- Relevant focused tests live under package dirs, not repo root.
- Existing useful targets:
  - `packages/core/test/application-tools.test.ts`
  - `packages/app/e2e/regression/assistant-attachments.spec.ts`
  - `packages/app/e2e/regression/preview-attachments.spec.ts`
  - `packages/opencode/test/tool/webfetch.test.ts` and `packages/opencode/test/tool/read.test.ts` for current SVG-as-text/image policy checks.
- Do not run tests from repo root; use package directories.

## Recommendation

Implement the fix as a data-contract repair plus UI rendering hardening:

1. In core message state, derive `attachments` from successful tool `content` entries where `type === "file"`.
2. In UI attachment classification, use the declared MIME first and fall back to the `data:` URL MIME when needed.
3. Treat `image/svg+xml` as a supported media preview type, but render it through an expandable preview/card path with download fallback instead of assuming every SVG is equivalent to PNG/JPG.
4. Add regression tests proving SVG file content from tool output reaches the UI attachment renderer and is visible/openable.

This keeps the existing tool contract stable while fixing the likely V2 gap where file content exists but `state.attachments` is empty.

## Key Changes

- `packages/core/src/session/message-updater.ts`
  - In the `session.next.tool.success` handler, map `event.data.content` file entries into `attachments` for `ToolStateCompleted`.
  - Preserve existing `content`, `outputPaths`, and `result` behavior.

- `packages/ui/src/components/message-file.ts`
  - Centralize MIME resolution: declared MIME first, then parse `data:<mime>;...` from the URL.
  - Ensure `image/svg+xml` resolves to image/media rather than generic file when safe preview is intended.

- `packages/ui/src/components/message-part.tsx`
  - Keep the `attach` renderer compatible with `state.attachments`.
  - Add a fallback to file entries from `state.content` only if core-side attachment derivation is insufficient or older sessions need compatibility.
  - Render SVG as expandable preview with download/open fallback.

- Optional follow-up, only if SVG uploads should also be accepted:
  - Add `image/svg+xml`/`.svg` to prompt-input picker constants in `packages/app/src/constants/file-picker.ts` and `packages/app/src/components/prompt-input/files.ts`.
  - This is separate from fixing tool-generated inline attachments.

## Tests

Run only from package directories:

```powershell
cd C:\GitRepros\opencode\packages\core
bun test --only-failures test/application-tools.test.ts
bun typecheck

cd C:\GitRepros\opencode\packages\app
bun run test:e2e:controlled -- e2e/regression/assistant-attachments.spec.ts
bun typecheck

cd C:\GitRepros\opencode\packages\ui
bun typecheck
```

If the implementation touches `packages/opencode` tool MIME policy, also run:

```powershell
cd C:\GitRepros\opencode\packages\opencode
bun test --timeout 30000 --only-failures test/tool/webfetch.test.ts test/tool/read.test.ts
bun typecheck
```

Visual QA should include an actual SVG attachment preview. If the installed desktop app must be tested, run the full prod desktop deploy flow before saying it is ready for `OpenCode.exe`:

1. `OPENCODE_CHANNEL=prod bun run build` in `packages/desktop`
2. `OPENCODE_CHANNEL=prod bun run deploy-asar.ts` in `packages/opencode`

## Assumptions

- The immediate bug is about tool/output inline attachments, not necessarily user-uploaded SVGs from the prompt picker.
- Inline means visible/openable in the chat attachment area, not raw unsandboxed SVG execution.
- Existing attachment and file-content schemas should remain backward compatible.

## Implementierungs-Reihenfolge & Parallelisierung

### Sichere Reihenfolge

1. **Trace/Data Contract bestätigen**
   - Owner: exploration/general subagent or main implementer.
   - Confirm that a tool success event contains SVG/file `content` but `ToolStateCompleted.attachments` is empty.
   - This must happen first because it defines the shared interface for frontend and tests.

2. **Core attachment derivation implementieren**
   - Owner: backend/core implementer subagent.
   - Update `packages/core/src/session/message-updater.ts` so file content becomes `attachments` in completed tool state.
   - Verification: focused core test.

3. **UI MIME fallback + SVG expandable preview implementieren**
   - Owner: frontend/UI implementer subagent.
   - Can start in parallel with step 2 after the expected attachment shape is agreed.
   - Update `message-file.ts` / `message-part.tsx` to classify SVG/data URLs correctly and keep fallback download behavior.
   - Verification: UI typecheck and attachment rendering regression.

4. **Regression tests ergänzen**
   - Owner: test subagent.
   - Can draft in parallel once the expected data shape is known, but final assertions should be adjusted after steps 2 and 3 land.
   - Add/extend core and app E2E coverage for SVG tool attachments.

5. **Finale Verifikation**
   - Owner: main implementer.
   - Run package-scoped tests/typechecks in dependency order: core first, then UI/app, then opencode only if touched.
   - Attach visual QA evidence if UI screenshots/videos are generated.

### Was parallel gehen kann

- Core implementation and UI rendering can run in parallel after the file-content-to-attachment contract is fixed or documented.
- Test scaffolding can run in parallel with implementation, but final expected snapshots/assertions depend on the landed UI behavior.
- Security review of SVG rendering can run in parallel with UI work, focused on avoiding unsafe raw SVG assumptions.

### Was sequentiell bleiben muss

- Do not finalize UI tests before the core attachment shape is settled.
- Do not declare installed desktop testing ready until prod build and ASAR deploy complete successfully.
- Do not broaden SVG upload acceptance until the tool-output bug is fixed and verified; upload support is a separate scope decision.

### Passende Subagents

- `explore`: trace current pipeline and locate exact call sites.
- `general` or implementation worker: core message-updater change.
- `general` or frontend worker: UI renderer and MIME fallback change.
- `general` test worker: focused regression tests and command verification.
