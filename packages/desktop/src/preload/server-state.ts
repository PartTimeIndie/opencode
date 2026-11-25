export type ServerState = {
  phase: "starting" | "healthy" | "restarting" | "exhausted" | "blocked" | "stopped"
  attempt: number
}

export function serverStateLabel(state: ServerState) {
  const labels: Record<ServerState["phase"], string> = {
    starting: "Lokaler Server startet",
    healthy: "Lokaler Server verbunden",
    restarting: `Lokaler Server wird neu gestartet (${state.attempt}/5). Sessions werden anschließend sicher geprüft.`,
    exhausted: "Lokaler Server konnte nicht neu gestartet werden. Sessions bleiben gespeichert.",
    blocked: "Serverende nicht bestätigt. Ein Ersatzstart bleibt zum Schutz der Sessions gesperrt.",
    stopped: "Lokaler Server beendet",
  }
  return labels[state.phase]
}
