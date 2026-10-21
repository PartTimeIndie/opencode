export function pluginEventType(type: string) {
  return type.replace(/\.\d+$/, "")
}

export async function runPluginEventHooks<Input>(
  hooks: Array<((input: Input) => void | Promise<void>) | undefined>,
  input: Input,
) {
  const errors: unknown[] = []
  // Hooks intentionally remain sequential so registration order stays deterministic.
  for (const hook of hooks) {
    if (!hook) continue
    await Promise.resolve()
      .then(() => hook(input))
      .catch((error) => errors.push(error))
  }
  return errors
}
