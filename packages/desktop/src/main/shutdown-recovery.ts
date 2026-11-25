export async function stopWithRecovery(input: {
  stop: () => Promise<void>
  choose: (error: unknown) => Promise<"retry" | "force" | "cancel">
  force: () => Promise<void>
}) {
  for (;;) {
    try {
      await input.stop()
      return
    } catch (error) {
      const choice = await input.choose(error)
      if (choice === "cancel") throw error
      if (choice === "force") {
        await input.force()
        return
      }
    }
  }
}
