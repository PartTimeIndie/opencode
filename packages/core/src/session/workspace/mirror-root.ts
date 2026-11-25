export * as MirrorRoot from "./mirror-root"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { QuestionV2 } from "../../question"
import { AgentMirror } from "./agent-mirror"
import { WorkspaceCheckout } from "./checkout"

/** Written into every root that admission may fill with task-owned mirrors. An
 * existing unmarked folder must be empty before it is adopted; populated user
 * folders are never claimed. */
const MARKER = ".opencode-mirror-root.json"
const MARKER_CONTENT = { version: 1, kind: "native-task-mirror-root" }
/** One hidden container beside a checkout, so its parent directory gains at most one entry. */
const CONTAINER = ".opencode-task-mirrors"
/** The copy reports ENOSPC itself; this floor only turns "nearly full" into a readable refusal first. */
export const MIN_FREE_BYTES = 64 * 1024 * 1024

const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1), kind: Schema.Literal("native-task-mirror-root"),
})))
const decodeFormAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  type: Schema.Literal("opencode.form.answer"),
  values: Schema.Record(Schema.String, Schema.Unknown),
})))

export type Code =
  | "absent"
  | "volume"
  | "inside"
  | "not-folder"
  | "unowned"
  | "unwritable"
  | "space"
  | "io"
  | "answer"

/** A mirror root that must not be used. `code` lets admission and tests tell the
 * refusal apart without matching message text. */
export class Refused extends Error {
  readonly code: Code
  constructor(code: Code, detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.code = code
  }
}

/** Deterministic default for NEW mirrors of one canonical checkout: a host-named
 * folder inside one hidden container beside the checkout. That keeps the mirror on
 * the checkout's own volume, outside the checkout and out of the OS temp dir, and
 * never requires writing to a volume root. A checkout that sits directly at a volume
 * root therefore has no default and needs an explicit folder choice. */
export function defaultRoot(checkout: string): string | undefined {
  const parent = path.dirname(checkout)
  if (parent === path.parse(checkout).root) return undefined
  const key = createHash("sha256").update(WorkspaceCheckout.pathKey(checkout)).digest("hex").slice(0, 12)
  const name = path.basename(checkout).slice(0, 40).replace(/[. ]+$/, "")
  return path.join(parent, CONTAINER, `${name}-${key}`)
}

/** Resolves and claims a mirror root for `checkout`. Links in the chosen path are
 * resolved so an alias into the checkout is seen as the checkout, the volume must be
 * the checkout's, an existing unmarked folder must be empty, and the ownership
 * marker is written before any mirror uses the root. Never writes inside the
 * checkout and never deletes anything. Returns the physical root. */
export async function prepare(input: {
  readonly checkout: string
  readonly root: string
  readonly minimumFreeBytes?: number
}): Promise<string> {
  const checkout = await fs.realpath(input.checkout)
  const target = await resolveExisting(input.root)
  const [source, host] = await Promise.all([fs.stat(checkout), fs.stat(target.existing)])
  if (String(source.dev) !== String(host.dev))
    throw new Refused("volume", `the folder ${target.resolved} is on another volume than the source checkout ${checkout}`)
  if (AgentMirror.inside(checkout, target.resolved))
    throw new Refused("inside", `the folder ${input.root} is inside the source checkout ${checkout} or reaches it through a link`)
  const minimum = input.minimumFreeBytes ?? MIN_FREE_BYTES
  const free = await fs.statfs(target.existing).then((stat) => stat.bavail * stat.bsize, () => undefined)
  if (free !== undefined && free < minimum)
    throw new Refused("space", `only ${Math.floor(free / 1048576)} MiB are free in ${target.resolved}; at least ${Math.ceil(minimum / 1048576)} MiB are required before copying the checkout`)
  if (target.missing > 0)
    await fs.mkdir(target.resolved, { recursive: true }).catch(rethrow("create", target.resolved))
  await claim(target.resolved)
  return target.resolved
}

export type Choice = {
  readonly childID: string
  readonly checkout: string
  readonly dispatchDigest: string
  readonly refused: string
}

/** The hidden echo that ties a form answer to exactly one task start. */
const binding = (input: Choice) => JSON.stringify([input.childID, input.checkout, input.dispatchDigest])

/** The single explicit folder choice for one exact start, rendered by the host's
 * existing blocking question UI through a `folder_picker` form field: a folder path
 * only, never an upload. */
export function choiceQuestion(input: Choice): QuestionV2.Info {
  return {
    type: "form",
    header: "Mirror folder",
    question: "Choose a folder for this task's private mirror",
    body: [{
      id: "reason",
      type: "markdown",
      content: [
        `The default mirror folder could not be used: ${input.refused}`,
        "",
        `Project: ${input.checkout}`,
        `Task: ${input.childID}`,
        "",
        "Pick an empty folder, or a folder OpenCode already uses for mirrors, on the same drive as the project. A private copy of the project is created there; nothing is uploaded and the project folder itself is never used.",
      ].join("\n"),
    }],
    form: {
      version: 1,
      id: "opencode-mirror-root",
      title: "Private mirror folder",
      submitLabel: "Use this folder",
      fields: [
        { id: "binding", type: "hidden", defaultValue: binding(input) },
        {
          id: "folder",
          type: "folder_picker",
          label: "Folder",
          required: true,
          multiple: false,
          description: "An empty folder or an existing OpenCode mirror folder on the same drive as the project.",
          placeholder: process.platform === "win32" ? "D:\\path\\to\\folder" : "/path/to/folder",
        },
      ],
    },
  }
}

/** Extracts the single folder path from a reply to `choiceQuestion`. Anything else —
 * an upload, several paths, a relative path, or a form answer echoing another start —
 * is refused so the caller refuses the start instead of guessing. */
export function chosenPath(answers: ReadonlyArray<QuestionV2.Answer>, input: Choice): string {
  const items = answers[0] ?? []
  const first = items[0]
  if (items.length !== 1 || typeof first !== "string")
    throw new Refused("answer", items.some((item) => typeof item !== "string")
      ? "a folder path is required; uploads are never accepted"
      : "exactly one folder path is required")
  const form = decodeFormAnswer(first)
  if (Option.isNone(form)) return absolute(first)
  if (form.value.values.binding !== binding(input))
    throw new Refused("answer", "the answer is bound to a different task start")
  const folder = form.value.values.folder
  const single = Array.isArray(folder) ? (folder.length === 1 ? folder[0] : undefined) : folder
  if (typeof single !== "string") throw new Refused("answer", "exactly one folder path is required")
  return absolute(single)
}

function absolute(folder: string) {
  if (!folder.trim() || !path.isAbsolute(folder)) throw new Refused("answer", "an absolute folder path is required")
  return folder.trim()
}

/** Physical path of `target`: every existing ancestor is resolved through its links,
 * so a junction into the checkout is seen as the checkout. Missing tail segments are
 * kept as typed. `existing` is the nearest existing folder; `missing` counts the
 * segments that would have to be created. */
async function resolveExisting(target: string): Promise<{ resolved: string; existing: string; missing: number }> {
  const tail: string[] = []
  let current = path.resolve(target)
  for (;;) {
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw refuse("inspect", current, error)
    })
    if (stat) {
      const existing = await fs.realpath(current).catch(rethrow("resolve", current))
      if (!(await fs.stat(existing)).isDirectory()) throw new Refused("not-folder", `${current} exists and is not a folder`)
      return { resolved: tail.length ? path.join(existing, ...tail.reverse()) : existing, existing, missing: tail.length }
    }
    tail.push(path.basename(current))
    const parent = path.dirname(current)
    if (parent === current) throw new Refused("io", `no existing folder is reachable for ${target}`)
    current = parent
  }
}

async function claim(root: string) {
  const marker = path.join(root, MARKER)
  const readMarker = () => fs.readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw refuse("read", marker, error)
  })
  const requireOwned = (stored: string) => {
    if (Option.isNone(decodeMarker(stored)))
      throw new Refused("unowned", `the folder ${root} carries a marker that does not belong to OpenCode`)
  }
  const stored = await readMarker()
  if (stored !== undefined) return requireOwned(stored)
  const entries = await fs.readdir(root).catch(rethrow("inspect", root))
  // Only the marker itself may appear from a concurrent preparation of the same root.
  if (entries.some((name) => name !== MARKER))
    throw new Refused("unowned", `the folder ${root} is not empty and is not an OpenCode mirror root`)
  const raced = await fs.writeFile(marker, JSON.stringify(MARKER_CONTENT), { flag: "wx" }).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return readMarker()
      throw refuse("mark", marker, error)
    },
  )
  if (raced !== undefined) requireOwned(raced)
}

const rethrow = (operation: string, target: string) => (error: NodeJS.ErrnoException) => {
  throw refuse(operation, target, error)
}

function refuse(operation: string, target: string, error: NodeJS.ErrnoException): Refused {
  const code: Code = ["EACCES", "EPERM", "EROFS"].includes(error.code ?? "") ? "unwritable"
    : ["ENOSPC", "EDQUOT"].includes(error.code ?? "") ? "space"
    : ["EEXIST", "ENOTDIR"].includes(error.code ?? "") ? "not-folder"
    : "io"
  return new Refused(code, `cannot ${operation} ${target}: ${error.message}`, { cause: error })
}
