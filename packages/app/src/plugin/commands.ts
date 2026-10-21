import type { CommandOption } from "@/context/command"

export type PluginCommandInput = {
  id: string
  title: string
  description?: string
  category?: string
  keybind?: string
  run(): void | Promise<void>
  onKeyDown?(): void | Promise<void>
  onKeyUp?(): void | Promise<void>
}

function invoke(input: PluginCommandInput, phase: "run" | "onKeyDown" | "onKeyUp") {
  const callback = input[phase]
  if (!callback) return
  void Promise.resolve(callback()).catch((error) => {
    console.error(`[plugin-command] ${input.id}${phase === "run" ? "" : ` ${phase}`} failed`, error)
  })
}

export function createPluginCommandOption(input: PluginCommandInput): CommandOption {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    category: input.category ?? "Plugins",
    keybind: input.keybind,
    onSelect: () => invoke(input, "run"),
    onKeyDown: input.onKeyDown ? () => invoke(input, "onKeyDown") : undefined,
    onKeyUp: input.onKeyUp ? () => invoke(input, "onKeyUp") : undefined,
  }
}

export function scopePluginCommand(input: PluginCommandInput, id: string): PluginCommandInput {
  return {
    ...input,
    id,
  }
}
