import { expect, test } from "bun:test"
import { windowsPowerShellExecutable } from "@/util/windows-powershell"

test("Windows PowerShell resolution does not depend on PATH", () => {
  expect(windowsPowerShellExecutable("win32", { SystemRoot: "D:\\Windows" })).toBe(
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  )
  expect(windowsPowerShellExecutable("win32", { WINDIR: "E:\\Win" })).toBe(
    "E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  )
  expect(windowsPowerShellExecutable("linux", {})).toBe("powershell.exe")
})
