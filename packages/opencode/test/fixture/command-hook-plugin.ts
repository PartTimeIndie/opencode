export default async () => ({
  "command.execute.before": async (
    input: { command: string; arguments: string },
    output: { parts: Array<{ type: "text"; text: string }> },
  ) => {
    if (input.command !== "demo") return
    output.parts = [{ type: "text", text: `Hooked command: ${input.arguments}` }]
  },
})
