import { describe, expect, test } from "bun:test"
import { rendererPermissionAllowed } from "./renderer-permissions"

describe("rendererPermissionAllowed", () => {
  test("allows audio-only media from the trusted main renderer", () => {
    expect(
      rendererPermissionAllowed({
        permission: "media",
        trusted: true,
        mainContents: true,
        mediaTypes: ["audio"],
      }),
    ).toBe(true)
    expect(
      rendererPermissionAllowed({
        permission: "media",
        trusted: true,
        mainContents: true,
        mediaType: "audio",
      }),
    ).toBe(true)
  })

  test("denies camera, mixed, and unspecified media", () => {
    expect(
      rendererPermissionAllowed({
        permission: "media",
        trusted: true,
        mainContents: true,
        mediaTypes: ["video"],
      }),
    ).toBe(false)
    expect(
      rendererPermissionAllowed({
        permission: "media",
        trusted: true,
        mainContents: true,
        mediaTypes: ["audio", "video"],
      }),
    ).toBe(false)
    expect(
      rendererPermissionAllowed({ permission: "media", trusted: true, mainContents: true, mediaType: "unknown" }),
    ).toBe(false)
    expect(rendererPermissionAllowed({ permission: "media", trusted: true, mainContents: true })).toBe(false)
  })

  test("requires the trusted main renderer", () => {
    expect(
      rendererPermissionAllowed({
        permission: "media",
        trusted: false,
        mainContents: true,
        mediaTypes: ["audio"],
      }),
    ).toBe(false)
    expect(
      rendererPermissionAllowed({
        permission: "media",
        trusted: true,
        mainContents: false,
        mediaTypes: ["audio"],
      }),
    ).toBe(false)
  })

  test("preserves the narrow non-media allowlist", () => {
    expect(
      rendererPermissionAllowed({ permission: "clipboard-sanitized-write", trusted: true, mainContents: true }),
    ).toBe(true)
    expect(rendererPermissionAllowed({ permission: "notifications", trusted: true, mainContents: true })).toBe(true)
    expect(rendererPermissionAllowed({ permission: "geolocation", trusted: true, mainContents: true })).toBe(false)
  })
})
