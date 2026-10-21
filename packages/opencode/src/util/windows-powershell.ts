import { win32 } from "node:path"

export function windowsPowerShellExecutable(platform = process.platform, environment = process.env) {
  if (platform !== "win32") return "powershell.exe"
  return win32.join(
    environment.SystemRoot || environment.WINDIR || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
}
