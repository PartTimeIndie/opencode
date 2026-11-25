export * as ProjectIcon from "./icon"

import { ImageGeneration } from "@opencode-ai/core/image-generation"
import { Effect, Schema } from "effect"

const RASTER_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i
const MIMES = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
} as const
const THUMBNAIL_SIZE = 128

export class InvalidIconError extends Schema.TaggedErrorClass<InvalidIconError>()(
  "Project.InvalidIconError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/**
 * Uploaded raster icons are stored as 128px thumbnails so a project list or
 * event never repeats a multi-megabyte data URL. Other values (http(s), svg,
 * relative) are kept verbatim and an empty string still means "cleared".
 */
export function normalize(url: string | undefined): Effect.Effect<string | undefined, InvalidIconError> {
  if (!url) return Effect.succeed(url)
  const match = RASTER_DATA_URL.exec(url)
  if (!match) return Effect.succeed(url)
  const payload = url.slice(match[0].length)
  const invalid = () => new InvalidIconError({
    message: "The image could not be decoded or resized. Use a PNG, JPEG, WebP or GIF file.",
  })
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return Effect.fail(invalid())
  return ImageGeneration.thumbnail(
    {
      data: Buffer.from(payload, "base64"),
      mime: MIMES[match[1].toLowerCase() as keyof typeof MIMES],
      filename: `icon.${match[1]}`,
    },
    THUMBNAIL_SIZE,
  ).pipe(
    Effect.map((image) => `data:${image.mime};base64,${Buffer.from(image.data).toString("base64")}`),
    Effect.mapError(invalid),
    Effect.catchDefect(() => Effect.fail(invalid())),
  )
}

/**
 * Storage form of a directory: forward slashes, no "." segments or trailing
 * slashes, upper-case drive letter. Junctions and symlinks are deliberately not
 * resolved here; callers store the real directory the host reported.
 */
export function canonicalDirectory(directory: string) {
  const windows = /^[a-zA-Z]:/.test(directory) || /^[\\/]{2}/.test(directory)
  const value = (windows ? directory.replaceAll("\\", "/") : directory).replace(/\/\.(?=\/|$)/g, "")
  const trimmed = value.replace(/\/+$/, "") || "/"
  return /^[a-z]:/.test(trimmed) ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed
}

/** Comparison form of `canonicalDirectory`; Windows paths compare case-insensitively. */
export function directoryKey(directory: string) {
  const canonical = canonicalDirectory(directory)
  return /^[A-Za-z]:/.test(canonical) || canonical.startsWith("//") ? canonical.toLowerCase() : canonical
}
