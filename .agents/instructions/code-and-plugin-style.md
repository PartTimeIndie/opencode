# OpenCode code and plugin style

Read when routed here by the project entrypoint. These contracts retain their original force. Code paths and backtick file paths are relative to the project root unless explicitly absolute; Markdown links are relative to this guide. Reading this guide grants no installation, process, Git, tracking or release authorization.

## Style Guide

### General Principles

- Before extending a tool API for multiple inputs, check whether the runner already executes independent tool calls from one model round in parallel and waits for all their results before the next round. Prefer multiple single-input calls in that round, for example one `image_generate` call per image, over a multi-image API extension.
- Before applying a patch, read the current target file and inspect its current diff; use small, context-specific hunks. If a patch is rejected for stale context, re-read the file and create a fresh patch instead of retrying the old hunk.
- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

### Plugin Icon Style

- For OpenCode app and toolbar plugin icons, use compact SVG assets that remain readable at 16-24px.
- Icons must be monochrome by default: use `currentColor` for visible strokes/fills or render external SVGs through CSS masks with `background: currentColor` so the UI can theme them. Do not hard-code cyan, blue, purple, dark base fills, or gradient accents for default app or toolbar icons.
- Prefer simple outline symbols with consistent stroke widths around 1.5-2.5px, rounded line caps/joins, transparent SVG backgrounds, no text, no letter abbreviations, and no multi-color gradients.
- Store icons under the plugin `assets/` directory and reference them with `new URL("./assets/name.svg", import.meta.url).href` instead of embedding large inline SVG strings in plugin code.
- Edit app plugin source under `.opencode/plugin-sources/*-app` and run `bun run sync:plugins` to copy it into `.opencode/plugins/*-app`. Do not use symlinks for this; `.opencode/plugins` is the generated runtime copy and deleting it must not risk deleting source files.
- Any OpenCode plugin changed locally must have a durable source checkout. App plugins belong under `.opencode/plugin-sources/*-app`; generated runtime copies under `.opencode/plugins/*-app` must never be the only edited copy. NPM/server plugins such as `opencode-scheduler` need a local source repo under `C:\GitRepros\<plugin-name>` and the active `~/.config/opencode/node_modules/<plugin-name>/dist` must be built or patched from that source.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

### Database Migrations

- When changing the core database schema, make sure existing installed databases are migrated and also covered by the startup schema-repair path in `packages/core/src/database/migration.ts`.
- Add or update a regression test in `packages/core/test/database-migration.test.ts` for schema drift where the migration journal says a migration already ran but safe additive schema pieces are missing.
- Safe automatic repair may add missing tables, nullable/defaulted columns, and indexes. Do not auto-repair destructive changes, incompatible type changes, or non-default `NOT NULL` columns without a dedicated migration.
- For session queue, runner, or context epoch schema changes, explicitly cover legacy databases missing `session_input`, `session_activity`, `background_job`, or `session_context_epoch` columns such as `agent` and `replacement_seq`.
