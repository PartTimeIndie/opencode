export * as AgentPlugin from "./agent"

import path from "path"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { PermissionV2 } from "../permission"
import { PluginV2 } from "../plugin"

const TRUNCATION_GLOB = path.join(Global.Path.data, "tool-output", "*")
export const BUILD_SYSTEM = `Implement only the authorized scope. Read the applicable rules and affected files, preserve existing work, use apply_patch for file changes, and run the relevant tests. When the user invokes Native Orchestrator, plan and refine in the current main conversation in normal mode; do not call switch_agent or enter Plan Mode for that workflow. Finish plan review and obtain or reuse explicit implementation authorization before starting native task forks. Outside Native Orchestrator, if asked to plan first, use switch_agent to hand off the exact request to plan with host confirmation before editing. For requested chat coordination, use session_send only with the exact user-referenced or provenance sender ID; never guess IDs, broadcast, spawn, or read another chat without a separate explicit request.`
export const PLAN_SYSTEM = `Plan without changing project files or running implementation commands. Inspect relevant sources, clarify material decisions, and update the session plan after each decision. Present the plan. On explicit implementation approval, use switch_agent to hand off the exact task to build; wait for host confirmation. For requested chat coordination, use session_send only with the exact user-referenced or provenance sender ID; never guess IDs, broadcast, spawn, or read another chat without a separate explicit request.`

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use Glob for broad file pattern matching
- Use Grep for searching file contents with regex
- Use Read when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- For clear communication, avoid using emojis
- Do not create any files, or run bash commands that modify the user's system state in any way

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_REVIEW = `You are a read-only reviewer. Inspect the requested code, plan, or diagnosis independently and return concise, evidence-based findings.

Guidelines:
- Do not edit files or perform destructive actions
- Verify working-tree claims with git_status: scope "summary" for branch/status and scope "patch" for the actual staged and unstaged diffs. Read relevant source and untracked files separately. Truncated output is incomplete evidence; state any remaining verification gap plainly
- Cite concrete file, line, test, log, or quoted evidence for every finding
- Separate confirmed defects from hypotheses and omit unsupported speculation
- Prioritize correctness, regressions, security, maintainability, and missing verification
- Include a concrete suggested fix and verification step when you report a defect
- Return one compact JSON object with findings and notes, without a preamble or markdown fence
- Return an empty findings array when the evidence does not support a defect`

const PROMPT_COMPACTION = `You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`

const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- 2-5 words
- <=35 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Prefer fewer, information-dense words over long phrases
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("agent"),
  effect: Effect.gen(function* () {
    const agent = yield* AgentV2.Service
    const whitelistedDirs = [
      TRUNCATION_GLOB,
      path.join(Global.Path.tmp, "*"),
      path.join(Global.Path.config, "skills", "*"),
      path.join(Global.Path.config, "plugins", "*"),
      path.join(Global.Path.home, ".agents", "skills", "*"),
      path.join(Global.Path.home, ".claude", "skills", "*"),
      path.join(Global.Path.home, ".cursor", "skills", "*"),
      path.join(Global.Path.home, ".codex", "skills", "*"),
    ]
    const readonlyExternalDirectory: PermissionV2.Ruleset = [
      { action: "external_directory", resource: "*", effect: "ask" },
      ...whitelistedDirs.map((resource): PermissionV2.Rule => ({
        action: "external_directory",
        resource,
        effect: "allow",
      })),
    ]
    const defaults: PermissionV2.Ruleset = [
      { action: "*", resource: "*", effect: "allow" },
      ...readonlyExternalDirectory,
      { action: "surface", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]

    yield* agent.update((editor) => {
      editor.update(AgentV2.defaultID, (item) => {
        item.description = "The default agent. Executes tools based on configured permissions."
        item.system ??= BUILD_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "surface", resource: "*", effect: "allow" },
            { action: "switch_agent", resource: "*", effect: "deny" },
            { action: "switch_agent", resource: "plan", effect: "allow" },
          ]),
        )
      })

      editor.update(AgentV2.ID.make("plan"), (item) => {
        item.description = "Planning agent with read-only workspace access and one session-owned plan document."
        item.system ??= PLAN_SYSTEM
        item.mode = "primary"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "surface", resource: "*", effect: "allow" },
            { action: "edit", resource: "*", effect: "deny" },
            { action: "bash", resource: "*", effect: "deny" },
            { action: "task", resource: "*", effect: "deny" },
            { action: "task", resource: "review", effect: "allow" },
            { action: "plan_document", resource: "*", effect: "allow" },
            { action: "switch_agent", resource: "*", effect: "deny" },
            { action: "switch_agent", resource: "build", effect: "allow" },
          ]),
        )
      })

      editor.update(AgentV2.ID.make("general"), (item) => {
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(defaults, [
            { action: "surface", resource: "*", effect: "allow" },
            { action: "todowrite", resource: "*", effect: "deny" },
          ]),
        )
      })

      editor.update(AgentV2.ID.make("review"), (item) => {
        item.description =
          "Read-only agent for independently reviewing code, plans, diagnoses, and proposed solutions. Use model and variant overrides to run configured multi-agent reviewers."
        item.system = PROMPT_REVIEW
        item.mode = "subagent"
        // Review and proposal workers are coordinator-sized workflows. Their
        // duration is governed by explicit caller cancellation/provider limits,
        // not by a hidden ten-turn host cap.
        item.steps = undefined
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
              { action: "git_status", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      editor.update(AgentV2.ID.make("explore"), (item) => {
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions. This agent may run on a fast low-reasoning model: use it for lookups you will verify yourself, not for bug hunting, root-cause analysis, or correctness judgments you would act on unchecked.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(
          ...PermissionV2.merge(
            defaults,
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
            ],
            readonlyExternalDirectory,
          ),
        )
      })

      editor.update(AgentV2.ID.make("compaction"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_COMPACTION
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      editor.update(AgentV2.ID.make("title"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })

      editor.update(AgentV2.ID.make("summary"), (item) => {
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push(...PermissionV2.merge(defaults, [{ action: "*", resource: "*", effect: "deny" }]))
      })
    })
  }),
})
