export default async () => ({
  "command.execute.before": async (
    command: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: "text"; text: string }> },
  ) => {
    if (command.command !== "goal-control-probe") return
    output.parts = [{
      type: "text",
      text: JSON.stringify({ arguments: command.arguments }),
    }]
  },
})
