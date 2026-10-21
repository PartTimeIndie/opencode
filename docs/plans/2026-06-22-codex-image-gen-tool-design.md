# Codex Image Generation Tool Design

## Problem

We want to use the image-generation capability that is available through the Codex app or Codex CLI from this opencode environment. The workflow should be simple enough to generate an image from chat, attach the generated image inline, and eventually expose the behavior as a reusable local tool.

The previous attempt to plan this through `/octto` had tooling issues, so this document records the restarted planning session and the decisions collected there.

## Findings

### Codex invocation discovery

Decision: start with read-only CLI inspection.

- First inspect installed Codex executables and their help/version output.
- Prefer safe commands such as `codex --help`, `codex --version`, and subcommand help before any real generation call.
- The discovery step must identify:
  - the executable path,
  - whether the CLI is already authenticated through the Codex app/CLI auth state,
  - the image prompt syntax,
  - how to set or discover the output path,
  - how to run non-interactively,
  - how errors and exit codes are reported.

### Tool API shape

Decision: expose a structured image-generation tool with sensible defaults.

Recommended initial parameters:

- `prompt`: required text prompt.
- `size`: optional, default `1024x1024` if Codex supports it.
- `style` or `quality`: optional, default omitted or `auto` unless the CLI exposes stable options.
- `filename`: optional safe basename, default generated from timestamp and a slug of the prompt.
- `outputDir`: optional but restricted to an approved generated-images directory.
- `attach`: optional boolean, default `true` for chat use.

The tool should not force users to know CLI details. It should wrap discovery results behind a simple prompt-to-image experience while keeping enough structured options for future Octto controls.

### Security and safety

The safety branch requested more explanation rather than selecting fixed constraints. The practical safety baseline should be:

- Reuse the existing Codex auth boundary; do not copy, print, or store API keys or auth tokens.
- Do not dump environment variables or Codex config into logs.
- Resolve and allowlist the Codex executable path before real generation.
- Avoid arbitrary shell strings. Prefer structured argument arrays where possible; when PowerShell is required, quote paths carefully and reject unsafe output names.
- Restrict generated files to a known output directory such as `C:\Users\crisc\AppData\Local\Temp\opencode\codex-images` or a workspace-local generated-images folder.
- Enforce a timeout and a small default image count.
- Ask for explicit confirmation before the first real remote generation run if the prompt may contain private data.

This keeps the workflow convenient while avoiding the two main risks: leaking credentials and turning a chat prompt into an unsafe command line.

### Attachment and verification

The verification plan must prove at least two things:

- a real image file was created at the expected output path,
- the result can be attached inline in chat, not merely returned as a path.

Useful additional checks:

- missing CLI gives an actionable message,
- auth failures explain that the Codex app/CLI login must be refreshed,
- unsupported size/style options fail clearly,
- a second generation can run without repeating manual discovery.

## Recommendation

Build this in two phases.

### Phase 1: discovery spike

1. Locate the Codex CLI executable available on this machine.
2. Inspect version and help output only.
3. Identify the exact non-interactive image-generation command and output behavior.
4. Run one small test generation only after confirming the command is safe.
5. Attach the generated test image inline to prove the end-to-end path.

### Phase 2: reusable tool

Create a small reusable implementation around the discovered command:

1. Validate the prompt and optional structured parameters.
2. Generate a safe output filename in a fixed output directory.
3. Run the allowlisted Codex executable with structured arguments.
4. Verify that the output file exists and is an image.
5. Return structured metadata and attach the image inline when requested.
6. Document the defaults and one example prompt.

The preferred user experience is: “generate an image of …” calls the tool with defaults, stores the image in the approved directory, and attaches it in chat automatically.

## Implementation

Implemented as a project-local opencode customization:

- `.opencode/tool/codex-image.ts` registers the reusable `codex-image` tool.
- `.opencode/command/codex-image.md` adds a command prompt that tells the agent to call the tool with `$ARGUMENTS`.

The tool resolves the installed Codex CLI, avoids running the Windows `.cmd` wrapper directly by invoking the installed `@openai/codex/bin/codex.js` through `node`, writes only under the temp output root, verifies PNG/JPEG/WebP file signatures, and returns a data-URL attachment when the image is small enough for inline chat display.

Because opencode loads custom tools at session start, a restart is required before the new tool and command are available to normal chat sessions.
