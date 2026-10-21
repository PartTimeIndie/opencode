export type DoubleTapAccelerator = { kind: "double-tap"; id: string; key: number; modifiers: number }

export function parseDesktopAccelerator(value: string): { kind: "single"; accelerator: string } | DoubleTapAccelerator | undefined {
  if (!value.trim() || value.length > 128) return
  const parts = value.trim().split(/\s+/)
  if (parts.length === 1) return { kind: "single", accelerator: parts[0]! }
  if (parts.length !== 2) return
  const first = combination(parts[0]!)
  const second = combination(parts[1]!)
  if (!first || !second || first.id !== second.id) return
  return { kind: "double-tap", ...first }
}

function combination(value: string) {
  const parts = value.toLowerCase().split("+")
  const name = parts.pop()!
  const key = /^[a-z0-9]$/.test(name) ? name.toUpperCase().charCodeAt(0)
    : /^f([1-9]|1\d|2[0-4])$/.test(name) ? 111 + Number(name.slice(1))
    : ({ space: 32, enter: 13, return: 13, tab: 9, escape: 27, esc: 27, backspace: 8, delete: 46, insert: 45, home: 36, end: 35, pageup: 33, pagedown: 34, left: 37, up: 38, right: 39, down: 40 } as Record<string, number>)[name]
  if (!key || !parts.length) return
  const modifiers = parts.map((part) => ({ ctrl: 1, control: 1, commandorcontrol: 1, cmdorctrl: 1, alt: 2, option: 2, shift: 4, super: 8, meta: 8 } as Record<string, number>)[part])
  if (modifiers.some((modifier) => !modifier) || new Set(modifiers).size !== modifiers.length) return
  const mask = modifiers.reduce<number>((mask, modifier) => mask | modifier!, 0)
  return { id: `${mask}:${key}`, key, modifiers: mask }
}
