---
description: "Generate an image with the local Codex CLI and attach it inline"
---

Use the regular built-in `image_generate` tool to generate an image for this user request:

```text
$ARGUMENTS
```

First interpret what the user is actually trying to visualize. Do not pass the raw text above as the image prompt unless it is already a clean visual prompt. Convert rough notes, mixed German/English instructions, UI tasks, control-panel workflow text, and implementation wording into a concise image-generation brief that describes the intended visual result.

When the request asks for design ideas or replacements, ask for a polished concept sheet or concrete icon mockup variants rather than a literal screenshot of the prompt text. Preserve any explicit size, style, format, model, or timeout as structured tool arguments; otherwise use the tool defaults and set `timeoutSeconds` to 300.

If `image_generate` fails, report the concrete Codex CLI, login, timeout, or image-validation error. Do not create a fallback drawing.

After the tool returns, show the inline attachment if present and summarize the generated file path. If the tool reports that Codex did not create a real image, explain the concrete Codex CLI/auth/capability issue instead of creating a fallback drawing.
