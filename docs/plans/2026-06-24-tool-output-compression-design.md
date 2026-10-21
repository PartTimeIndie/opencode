# Tool Output Compression Boundary Design

## Problem

Large local tool outputs can dominate model-visible context and CLI rendering, but the repo already has separate paths for host logs, V2 managed tool-output retention, provider replay, HTTP/API session reads, and UI/share projection. A global compression layer across Session history would mutate durable replay data and risk breaking consumers that expect the original projected message shape.

## Decision

Future compression work must be opt-in and scoped to the tool-output settlement and display boundaries only. It must not rewrite Session history, projected Session messages, EventV2 replay rows, share payloads, or public API responses as a generic post-processing step.

The intended integration points are:

- `packages/core/src/tool-output-store.ts` for V2 managed output bounding, retention, and optional compressed managed artifacts after a tool result has fully settled.
- `packages/tui/src/util/collapse-tool-output.ts` and adjacent CLI display code for local presentation-only compaction of long outputs.
- Existing read/grep managed-output flows for retrieval of retained content, so compressed managed artifacts remain transparent to callers that open full output.

Host process logs such as `opencode.log` are a separate operational logging path. Tool output truncation and `ToolOutputStore` retention are also separate from Session History. Compression must preserve those boundaries rather than adding one global log/session compressor.

## Non-Goals

- Do not compress or replace durable Session History events.
- Do not change provider replay semantics or provider-native tool-result payloads.
- Do not change share/export/API output unless a later public contract explicitly introduces compressed references.
- Do not infer compression from display truncation; display collapse is only presentation.

## Test Plan For A Compression PR

A future implementation should include focused coverage for:

- Tool settlement writes a full managed artifact and returns the same bounded preview contract as today.
- `read` or equivalent managed-output retrieval opens compressed retained content without exposing compression internals.
- `grep` or equivalent managed-output search works against retained full output, including compressed artifacts.
- Retention cleanup still removes managed `tool_` artifacts after `ToolOutputStore.RETENTION`.
- Session replay and `sessions.events(...)` preserve the original durable tool settlement shape.
- Session share/export/API reads do not receive globally rewritten history.
- CLI/TUI display collapse remains presentation-only and does not alter retained output.

## Acceptance Checklist

- Compression is configured explicitly and defaults to current behavior.
- The PR references both integration boundaries: V2 tool-output settlement/managed retention and CLI display collapse.
- The PR states that Session History is not mutated.
- Replay, share/API, managed read/grep, and retention tests are listed or implemented.
