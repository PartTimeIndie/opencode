# Visual QA High-Resolution Evidence & Shared Image Overlay Design

## Problem

The current `/visual-qa-testing` evidence flow often produces screenshots that are too low-resolution for detailed review. In addition, images attached by the user in chat do not reliably open in the same inline fullscreen/zoomable overlay experience as images attached by the LLM via the attachment tool. The desired result is a consistent image-inspection UX and a durable Visual QA rule that future agents capture and attach useful high-resolution visual evidence.

## Findings

### Durable `/visual-qa-testing` instructions

- Approved durable updates: add explicit Visual QA evidence guidance for higher-resolution screenshots and strengthen the rule that broken inline image rendering/opening is a product bug.
- Not selected for this first plan: a broad cross-harness memory mirror beyond the existing skill/rule locations.
- Current context: `C:\Users\crisc\.agents\skills\visual-qa-testing\SKILL.md` already has an Evidence section and a Durable Instructions section, so the targeted wording belongs there.

### Chat attachment overlay

- Approved implementation direction: reuse the existing LLM attachment overlay for user-uploaded images.
- Current context: LLM/tool attachments render through `packages/app/src/components/message/attachment-renderer.tsx`, which already opens images/videos in `data-component="attachment-fullscreen-overlay"`.
- Current user image context: prompt image thumbnails render in `packages/app/src/components/prompt-input/image-attachments.tsx`; `packages/app/src/components/prompt-input.tsx` currently opens them with `@opencode-ai/ui/image-preview` via `dialog.show(...)`, which is a different control path than LLM attachments.
- Recommended design: extract the overlay portion from `AttachmentRenderer` into a small shared component or route prompt image attachments through the same renderer shape, then use that same component for both assistant and user image previews.

### Screenshot pipeline

- Approved policy: adaptive high-resolution evidence.
- Interpretation: for visual/UI checks, agents should prefer high-resolution capture settings such as device scale factor 2, full-size PNG, or equivalent harness options. For non-visual checks, repeated loop screenshots, or attachment-size constraints, compact evidence is acceptable if the report states why.
- Current context: this repo-level search did not reveal one central `/visual-qa-testing` screenshot helper inside the app. The immediate durable change is therefore skill wording; implementation work should also inspect harness-specific screenshot runners when the actual Visual QA runner is changed.

### Verification order

- Approved order: inspect context first, implement shared overlay behavior, improve screenshot policy/path, update durable skill instructions, then verify the combined behavior.
- Verification should prove both image sources open in the same overlay/control and that Visual QA evidence remains readable inline.

## Recommendation

Implement this as two connected but separable changes:

1. **Shared image preview control in the app**
   - Make the existing `attachment-fullscreen-overlay` behavior reusable.
   - Replace prompt-input user-image preview calls with the same shared image overlay path used by `AttachmentRenderer`.
   - Keep the existing thumbnail UI; only change what happens when the thumbnail is clicked.

2. **Durable Visual QA evidence policy**
   - Update `visual-qa-testing` so future runs prefer high-resolution screenshot evidence for visual checks.
   - Add explicit wording that user-attached images and LLM-attached images must both open inline in the same zoomable/fullscreen inspection control; failure to do so is a product bug or blocker.

This keeps UX consistent by construction, avoids a second image viewer, and makes future Visual QA sessions less likely to attach unreadable evidence.

## Implementation Details

### App UI

- Extract a shared `AttachmentFullscreenOverlay` or `MediaPreviewOverlay` near `packages/app/src/components/message/attachment-renderer.tsx` unless an existing UI package component is already equivalent.
- Preserve the current assistant attachment card behavior.
- Update `PromptImageAttachments`/`prompt-input.tsx` so user image thumbnails open the shared overlay with an attachment-like shape:
  - `id`: existing prompt attachment id
  - `mediaType`: prompt attachment mime
  - `url`: prompt attachment data URL
  - `filename`: prompt attachment filename
- If real zoom controls are absent in the current overlay, treat fullscreen/object-contain parity as the minimum first fix and add zoom/pan as a follow-up only if required by product expectations.

### Visual QA skill wording

- In `C:\Users\crisc\.agents\skills\visual-qa-testing\SKILL.md`, update Evidence guidance to require high-resolution screenshots for visual checks where the harness supports it.
- Mention concrete examples: use a stable viewport plus higher device scale factor, preserve full PNG evidence, avoid unnecessary downscaling/compression, and document any size-driven fallback.
- Strengthen the inline attachment rule: screenshots/videos must be attached inline; images attached by either the LLM or the user must open in the same inspectable fullscreen/zoomable overlay/control; failure is a product bug/blocker to report or fix.

## Tests

- Add or update component tests around prompt image thumbnail opening if the app test harness supports it.
- Manually or browser-test the preview route/chat composer behavior:
  - attach/upload a user image, click it, confirm `data-component="attachment-fullscreen-overlay"` opens;
  - render an assistant attachment image, click it, confirm the same overlay opens;
  - close overlay with backdrop and close button.
- Run package verification from the package directory, not repo root:
  - `bun typecheck` from `packages/app` after UI changes.
- For Visual QA evidence policy, run one targeted visual check and attach/read the resulting screenshot inline; verify the evidence is large enough to inspect relevant UI details.

## Implementierungs-Reihenfolge & Parallelisierung

### Sicherer Ablauf

1. **Sequential: context lock-in**
   - Inspect `attachment-renderer.tsx`, `image-attachments.tsx`, `prompt-input.tsx`, and the Visual QA skill file.
   - Confirm whether the existing overlay is sufficient or needs a tiny extraction.
2. **Parallel workstream A: app overlay implementation**
   - Subagent fit: `explore` for component references, then a UI implementer/general agent for the shared overlay refactor.
   - Work: reuse/extract the assistant attachment overlay and wire user image thumbnails to it.
3. **Parallel workstream B: Visual QA instruction update**
   - Subagent fit: docs/instruction reviewer or `general` agent.
   - Work: edit the durable skill wording for high-resolution screenshots and same-overlay attachment expectations.
4. **Sequential integration review**
   - Ensure the app change and skill wording use the same terms: “same fullscreen/zoomable overlay/control” and “high-resolution visual evidence”.
5. **Sequential verification**
   - Run `bun typecheck` from `packages/app`.
   - Run focused UI/Visual QA verification for user-image and LLM-image overlay behavior.
   - Attach high-resolution evidence inline in the final report.

### What can run in parallel

- App overlay code work and skill wording updates can run in parallel after the initial file inspection.
- A QA reviewer can prepare the acceptance checklist while implementation is in progress.

### What must remain sequential

- Final verification must wait for both app behavior and durable instructions.
- Any desktop-installed-app readiness claim must wait for the full prod ASAR deploy flow if the user wants to test through `OpenCode.exe`.

### Verification order

1. Typecheck/build-level sanity in `packages/app`.
2. Component or browser check for user image overlay.
3. Component or browser check for assistant attachment overlay regression.
4. Visual QA evidence check with readable high-resolution screenshot.
5. Optional desktop deploy verification only if installed desktop testing is requested.

## Assumptions

- The first implementation should not introduce a second overlay system.
- “Zoomable” means the same existing attachment inspection overlay/control unless product review requires explicit pinch/wheel zoom controls.
- High-resolution screenshot capture should remain adaptive to avoid huge repeated evidence files, but visual pass/fail screenshots should default to readable/high-res output.
