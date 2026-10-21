import type { Platform } from "@/context/platform"
import type { ServerConnection } from "@/context/server"
import { directoryPickerKind } from "@/components/directory-picker-policy"

// Folder answers contain paths only. Never derive them from a FileList: browser
// directory uploads enumerate children and cannot provide the selected root path.
export async function pickQuestionFolders(input: {
  platform: Platform
  server: ServerConnection.Any
  title: string
  multiple?: boolean
  pickServer: () => Promise<string | string[] | null>
}) {
  const result =
    input.platform.platform === "desktop" && directoryPickerKind(input.platform.platform, input.server) === "native"
      ? await input.platform.openDirectoryPickerDialog({ title: input.title, multiple: input.multiple === true })
      : await input.pickServer()
  return questionFolderValues([], result, input.multiple)
}

export function questionFolderValues(existing: string[], result: string | string[] | null, multiple?: boolean) {
  const paths = (typeof result === "string" ? [result] : (result ?? [])).filter((item) => item.trim().length > 0)
  if (!paths.length) return existing
  if (multiple !== true) return [paths[0]!]
  return [...new Set([...existing, ...paths])]
}
