# Local image annotations

## Use

Click a PNG, JPEG or WebP attachment in the composer to edit it. An image already
in the conversation opens in its normal preview; **Edit as new copy** adds an
editable copy to that conversation's composer. Historical messages do not change.
Proof attachments and unsupported formats remain read-only. Animated PNG/WebP,
GIF and active formats such as SVG cannot be annotated. File contents, not just
MIME metadata, determine whether an editor source is supported.

Tools include freehand drawing, line, arrow, multiline plain text, unfilled
rectangle/ellipse, emoji, selection and pan. Select an object to move it, change
its color, stroke or size, or delete it. Arrows have endpoint handles and a
rotation handle that preserves their length. Undo/redo is local to the open
editor; it is not retained after closing it. Keyboard shortcuts include
Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y, Delete and arrow-key nudging.

The offline emoji picker has categories and German/English search. Three
profile-wide frequent-emoji shortcuts initially show 👉, ❌ and ✅. Only committed
placements affect their ranking; reopening, exporting, copying into a send queue
or retrying a save does not count a placement again. Emoji use the system font,
keep their own colors, and can differ between operating systems. No emoji service,
external graphics or additional editor package is used.

**Apply** first exports an original-resolution PNG, then saves the original,
editable scene and PNG durably in local IndexedDB. Only then is the composer
attachment replaced. Export, quota, transaction and revision-conflict failures
leave the editor open with its changes. Cancel leaves the previous attachment
unchanged and asks before discarding unsaved edits. The narrow layout supports
single-pointer touch drawing; multi-finger gestures are not promised.

## Ownership and storage boundary

The app module is `packages/app/src/components/image-annotation/`. The editor and
Canvas exporter are lazy-loaded. Geometry and history are independent of the UI;
SVG displays vector marks while Canvas composes the PNG. Text and emoji share the
same raster tiles in preview and export. Selection handles and controls are never
part of the export.

`opencode.image-annotations` (IndexedDB schema 1) owns image blobs and versioned
scenes. Its heads retain ownership, revision, tombstone and snapshot-pin metadata;
documents hold revision-specific blobs; usage holds local emoji counts. The scope
includes server, normalized project path and session or draft identity. The normal
persisted prompt contains a versioned reference, not original paths or large inline
image data. Existing limits on ordinary inline attachments remain unchanged.

A compare-and-swap transaction rejects saving over a revision changed in another
window. Recovery reconciles the database with the prompt, including a crash after
the document commit but before its prompt marker. It replaces an original with the
same attachment ID and removes stale sent/removed markers instead of resurrecting
them. Missing/corrupt storage fails closed; there is no volatile-only success or
fallback to the original image.

Sends pin their captured revisions and materialize only their PNGs. Both prompt
and slash-command request builders reject unresolved references. Resolution strips
original file paths, annotation markers and local metadata. Cleanup follows server
admission; a failed send keeps its editable draft. An old send's acknowledgement
cannot remove a newer revision. Unpinned obsolete revisions are pruned; tombstone
metadata remains to prevent recovery from reviving stale markers. Captured,
unsettled operations retain pinned data until their owner releases it.

A locally parked followup owns an independent durable document snapshot, without
inline image bytes or another emoji count. It is excluded from composer recovery.
Editing it transfers ownership back to a draft; sending or deleting it retires
its document. This separates a queued image from later composer edits.

The optional image-copy callback lives at the UI DataProvider boundary. Composer
source loading and sent-image copying reuse the existing authorized managed-media
path. There is no annotation server endpoint or upload of the original/scene.

## Maintenance and verification

Keep behavior contracts next to model/geometry/catalog/source validation and prompt
integration. Canvas, actual blobs, IndexedDB, cross-window transactions and browser
pointer behavior must be checked in real Chromium, not inferred from Happy DOM.
Use synthetic fixtures; captured screenshots/videos stay in ignored test output.
Do not turn a source/browser test into a claim about the installed desktop build.

Run from `packages/app`:

```sh
bun test --preload ./happydom.ts ./src/components/image-annotation ./src/context/prompt.test.ts ./src/components/prompt-input/attachments.test.ts ./src/components/prompt-input/build-request-parts.test.ts ./src/components/prompt-input/submit.test.ts ./src/components/prompt-input/prepared-submit-policy.test.ts
bun run test:browser
bun typecheck
bun run typecheck:e2e
bun run test:e2e:controlled -- e2e/regression/image-annotation.spec.ts e2e/regression/composer-attachment-inputs.spec.ts e2e/regression/pasted-image-reconciliation.spec.ts e2e/regression/assistant-attachments.spec.ts --workers=1
```

Run from `packages/ui`:

```sh
bun test src --only-failures
bun typecheck
```

The real-browser specification covers tools/history, endpoint changes and rotation,
pointer cancellation, original-resolution pixels and text/emoji parity,
persisted/recovered drafts, large PNG blobs, transaction/CAS
conflicts, quota rollback, context guards, queued snapshots, idempotent emoji usage,
two windows, pins/tombstones, failed-send retry, both send dialects and new copies
from user, assistant and attach-tool previews. It captures 1440×900 desktop and
390×844 touch evidence and checks console/network errors in the main flow.

Future storage/send changes must preserve these boundaries and extend their tests;
never bypass an unresolved marker, relax unrelated tests to obtain a green run,
or silently deploy/restart the installed app as part of verification.
