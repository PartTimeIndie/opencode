const ICON = new URL("./assets/prompt-improve.svg", import.meta.url).href
const LABEL = "Improve current prompt"
export const DEFAULT_SETTINGS = {
  modelChain: "chain:default",
  promptTemplate: [
    "Rewrite the user's draft prompt for an AI coding assistant.",
    "Return only the improved prompt text, with no preamble, no markdown fence, and no surrounding quotes.",
    "Keep the user's intent, language, constraints, and concrete details. Make it clearer, more specific, and actionable.",
    "Do not add requirements the user did not imply.",
    "Always format the improved prompt as clean, readable text: separate paragraphs, topics, and requirement groups with blank lines, and use numbered lists for ordered steps and bulleted lists for unordered points, with nested points indented consistently.",
    "In prose, use Markdown bold sparingly to highlight key requirements, constraints, or warnings. Never bold or otherwise reformat code, commands, file paths, flags, or identifiers; keep them literal and wrap multi-line code in fenced code blocks with a blank line before and after.",
    "",
    "Draft prompt:",
    "{prompt}",
  ].join("\n"),
}
// Output caps include hidden reasoning, not just the rewritten prompt.
const MIN_OUTPUT_TOKENS = 8192
const MAX_OUTPUT_TOKENS = 16384

export default {
  id: "prompt-improve-app",
  app(api) {
    const state = {
      settings: readSettings(api),
      busy: false,
      error: "",
    }

    api.settings.register({
      id: "promptImproveSettings",
      title: "Prompt Improve",
      sections: [
        {
          title: "Model",
          fields: [
            {
              key: "modelChain",
              type: "model-target",
              label: "Rewrite model or chain",
              description: "Select one model or an ordered fallback chain for prompt rewriting.",
              default: DEFAULT_SETTINGS.modelChain,
              required: true,
              autoSelectDefault: true,
            },
          ],
        },
        {
          title: "Prompt",
          fields: [
            {
              key: "promptTemplate",
              type: "textarea",
              label: "Rewrite prompt template",
              description:
                "Instruction sent to the rewrite model. Use {prompt} where the current Composer text should be inserted; if omitted, the draft prompt is appended.",
              default: DEFAULT_SETTINGS.promptTemplate,
              placeholder: DEFAULT_SETTINGS.promptTemplate,
              rows: 8,
            },
          ],
        },
      ],
    })

    api.settings.subscribe((settings) => {
      state.settings = normalizeSettings(settings)
    })

    api.toolbar.register({
      id: "promptImprove",
      defaultVisible: true,
      title: "Improve Prompt",
      tooltip: LABEL,
      placement: "composer",
      align: "right",
      kind: "mount",
      mobile: "visible",
      order: 50,
      mount(context) {
        return mountPromptImprove(api, state, context)
      },
    })
  },
}

function mountPromptImprove(api, state, context) {
  const toolbarContext = context.context ?? {}
  const button = document.createElement("button")
  const icon = document.createElement("span")
  const style = styleNode()
  let disposed = false

  button.type = "button"
  button.className = "oc-prompt-improve"
  button.setAttribute("aria-label", LABEL)
  icon.className = "oc-prompt-improve__icon"
  icon.setAttribute("aria-hidden", "true")
  button.append(icon)
  context.element.replaceChildren(style, button)

  const update = () => {
    button.disabled = state.busy
    button.classList.toggle("is-busy", state.busy)
    button.classList.toggle("has-error", !!state.error)
    button.title = state.busy ? "Improving prompt..." : state.error ? `Prompt Improve failed: ${state.error}` : LABEL
  }

  const onClick = async () => {
    if (state.busy) return
    const started = performance.now()
    state.error = ""
    const composer = api.host.composer.read(toolbarContext)
    if (!composer) {
      state.error = "Composer is not available"
      update()
      return
    }
    if (composer.mode !== "normal") {
      state.error = "Only normal prompts can be improved"
      update()
      return
    }

    const prompt = composer.text.trim()
    if (!prompt) {
      state.error = "Write a prompt first"
      update()
      return
    }

    state.busy = true
    update()
    let requestedAt = started
    try {
      requestedAt = performance.now()
      const result = await api.host.ai.run({
        directory: composer.directory,
        ...promptImproveAIRequest(state.settings),
        prompt: promptImproveUserPrompt(prompt, state.settings.promptTemplate),
        generation: { maxTokens: promptImproveMaxTokens(prompt), temperature: 0 },
        tools: [],
      })
      const receivedAt = performance.now()
      if (!result.ok || typeof result.text !== "string") throw new Error(result.error || "Prompt Improve failed")
      const improved = cleanImprovedPrompt(result.text)
      if (!improved) throw new Error("Model returned an empty prompt")
      const modelApplied = !disposed && api.host.composer.change({
        ...toolbarContext,
        text: improved,
        expectedText: composer.text,
      }).ok
      if (!modelApplied) state.error = "Composer changed during rewrite; prompt was not applied"
      const finishedAt = performance.now()
      console.info("[prompt-improve-app] timing", {
        totalMs: Math.round(finishedAt - started),
        composerMs: Math.round(requestedAt - started),
        requestMs: Math.round(receivedAt - requestedAt),
        applyMs: Math.round(finishedAt - receivedAt),
        modelApplied,
        model: result.model,
        server: result.timing,
      })
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      console.warn("[prompt-improve-app] prompt rewrite failed", error)
      console.info("[prompt-improve-app] timing", {
        totalMs: Math.round(performance.now() - started),
        composerMs: Math.round(requestedAt - started),
        requestMs: Math.round(performance.now() - requestedAt),
        modelApplied: false,
      })
    } finally {
      state.busy = false
      update()
    }
  }

  const dispose = () => {
    disposed = true
    button.removeEventListener("click", onClick)
    context.element.replaceChildren()
  }

  button.addEventListener("click", onClick)
  context.signal.addEventListener("abort", dispose, { once: true })
  update()
  return dispose
}

function readSettings(api) {
  return normalizeSettings({
    modelChain: api.settings.get("modelChain", DEFAULT_SETTINGS.modelChain),
    promptTemplate: api.settings.get("promptTemplate", DEFAULT_SETTINGS.promptTemplate),
  })
}

export function normalizeSettings(settings) {
  return {
    modelChain:
      typeof settings.modelChain === "string" && settings.modelChain.trim()
        ? settings.modelChain.trim()
        : DEFAULT_SETTINGS.modelChain,
    promptTemplate: normalizePromptTemplate(settings.promptTemplate),
  }
}

export function promptImproveAIRequest(settings) {
  const target = typeof settings.modelChain === "string" ? settings.modelChain.trim() : ""
  if (!target) throw new Error("Configure a rewrite model or chain in Prompt Improve settings")
  if (target.startsWith("model:")) return { model: target.slice("model:".length) }
  if (target.startsWith("chain:")) return { chain: target.slice("chain:".length) }
  return target.includes("/") ? { model: target } : { chain: target }
}

function normalizePromptTemplate(value) {
  const template = typeof value === "string" ? value.trim() : ""
  return template || DEFAULT_SETTINGS.promptTemplate
}

export function promptImproveUserPrompt(prompt, template) {
  const normalized = normalizePromptTemplate(template)
  if (normalized.includes("{prompt}")) return normalized.replaceAll("{prompt}", prompt)
  return [normalized, "", "Draft prompt:", prompt].join("\n")
}

export function promptImproveMaxTokens(prompt) {
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.ceil(prompt.length / 2) + 4096))
}

export function cleanImprovedPrompt(text) {
  const trimmed = unwrapMarkdownFence(text.trim())
  const prompt = stripPromptLabel(promptFromJson(trimmed) ?? trimmed)
  const unwrapped =
    (prompt.startsWith('"') && prompt.endsWith('"')) || (prompt.startsWith("'") && prompt.endsWith("'"))
      ? decodeQuotedPrompt(prompt).trim()
      : prompt
  return normalizeImprovedFormatting(unwrapped)
}

// Guarantees clean spacing for flowing text while keeping fenced code blocks byte-identical.
function normalizeImprovedFormatting(text) {
  const out = []
  let inFence = false
  let blankRun = 0
  for (const raw of text.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      blankRun = 0
      out.push(raw.trim())
      continue
    }
    if (inFence) {
      blankRun = 0
      out.push(raw)
      continue
    }
    const line = raw.replace(/[ \t]+$/, "")
    if (!line) {
      blankRun++
      if (blankRun === 1) out.push(line)
      continue
    }
    blankRun = 0
    out.push(line)
  }
  while (out.length && out[0] === "") out.shift()
  while (out.length && out[out.length - 1] === "") out.pop()
  return out.join("\n")
}

function unwrapMarkdownFence(text) {
  const fenced = text.match(/^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/)
  return (fenced?.[1] ?? text).trim()
}

function promptFromJson(text) {
  if (!/^(?:\{|\[|")/.test(text)) return
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === "string") return parsed.trim()
    if (Array.isArray(parsed)) return typeof parsed[0] === "string" && parsed[0].trim() ? parsed[0].trim() : undefined
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    for (const key of [
      "prompt",
      "text",
      "improvedPrompt",
      "improved_prompt",
      "rewrittenPrompt",
      "rewritten_prompt",
      "content",
      "result",
      "output",
    ]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key].trim()
    }
  } catch {
    return
  }
}

function stripPromptLabel(text) {
  const stripped = text
    .replace(/^\s*(?:here(?:'s| is)\s+)?(?:the\s+)?(?:improved|rewritten|revised)\s+prompt\s*:\s*/i, "")
    .trim()
  if (stripped !== text.trim()) return stripped
  return (
    text.match(
      /(?:^|\n)\s*(?:here(?:'s| is)\s+)?(?:the\s+)?(?:improved|rewritten|revised)\s+prompt\s*:\s*([\s\S]*)$/i,
    )?.[1] ?? text
  ).trim()
}

function decodeQuotedPrompt(text) {
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === "string") return parsed
    } catch {
      return decodeCommonEscapes(text.slice(1, -1))
    }
  }
  return decodeCommonEscapes(text.slice(1, -1))
}

function decodeCommonEscapes(text) {
  return text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
}

function styleNode() {
  const style = document.createElement("style")
  style.textContent = `
    .oc-prompt-improve {
      align-items: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 8px;
      color: var(--v2-icon-icon-base, currentColor);
      cursor: pointer;
      display: inline-flex;
      height: 28px;
      justify-content: center;
      padding: 0;
      transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, opacity 120ms ease;
      width: 28px;
    }

    .oc-prompt-improve:hover,
    .oc-prompt-improve:focus-visible {
      background: var(--v2-overlay-simple-overlay-hover, rgba(255, 255, 255, 0.08));
      outline: none;
    }

    .oc-prompt-improve:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    .oc-prompt-improve.has-error {
      color: var(--v2-icon-icon-danger, var(--v2-text-error, currentColor));
    }

    .oc-prompt-improve__icon {
      background: currentColor;
      display: block;
      height: 18px;
      -webkit-mask: url("${ICON.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, "")}") center / contain no-repeat;
      mask: url("${ICON.replace(/["\\]/g, "\\$&").replace(/[\n\r\f]/g, "")}") center / contain no-repeat;
      width: 18px;
    }

    .oc-prompt-improve.is-busy .oc-prompt-improve__icon {
      animation: oc-prompt-improve-spin 900ms linear infinite;
    }

    @keyframes oc-prompt-improve-spin {
      to { transform: rotate(360deg); }
    }
  `
  return style
}
