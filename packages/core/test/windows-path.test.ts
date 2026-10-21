import { describe, expect, test } from "bun:test"
import { mergeWindowsPath, parseWindowsRegistryPath } from "@opencode-ai/core/util/windows-path"

describe("Windows executable path", () => {
  test("parses string and expandable registry values", () => {
    expect(
      parseWindowsRegistryPath(`\nHKEY_LOCAL_MACHINE\\Environment\n    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Program Files\\Git\\cmd\n`),
    ).toBe("%SystemRoot%\\System32;C:\\Program Files\\Git\\cmd")
    expect(parseWindowsRegistryPath("    Path    REG_SZ    C:\\Tools\r\n")).toBe("C:\\Tools")
    expect(parseWindowsRegistryPath("    TEMP    REG_EXPAND_SZ    %TEMP%\r\n")).toBeUndefined()
  })

  test("merges inherited, machine, and user paths with expansion and case-insensitive deduplication", () => {
    expect(
      mergeWindowsPath(
        [
          "C:\\Existing;C:\\Program Files\\Git\\cmd\\",
          "%SystemRoot%\\System32;C:\\PROGRAM FILES\\Git\\cmd",
          '"%UserProfile%\\bin";C:\\Existing\\',
        ],
        { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\test" },
      ),
    ).toBe("C:\\Existing;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Users\\test\\bin")
  })
})
