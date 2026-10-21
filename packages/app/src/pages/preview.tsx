import { Show, createMemo, type Component } from "solid-js"
import { useParams } from "@solidjs/router"
import { AttachmentRenderer, type Attachment } from "@/components/message/attachment-renderer"
import {
  AutomationEditor,
  AutomationsPanel,
  type Automation,
  type AutomationRun,
} from "@/pages/automations/automations-panel"

// Dev-only preview route that renders the Feature 2 (AttachmentRenderer) and
// Feature 3 (Automations) components with sample data. Exists so the components
// can be exercised and video-proven in isolation via Playwright, independently
// of the deeper core/server integration.

const SAMPLE_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAP5FAxd9kT2/AAAAAElFTkSuQmCC"

const SAMPLE_FILE = "data:text/plain;charset=utf-8,opencode%20attachment%20deliverable"

const sampleAttachments: Attachment[] = [
  { id: "att_img_1", mediaType: "image/png", url: SAMPLE_IMAGE, filename: "screenshot.png", sizeBytes: 4200 },
  { id: "att_vid_1", mediaType: "video/mp4", url: "", filename: "demo.mp4", sizeBytes: 1_820_000 },
  { id: "att_file_1", mediaType: "text/plain", url: SAMPLE_FILE, filename: "report.txt", sizeBytes: 28 },
]

const sampleAutomations: Automation[] = [
  {
    id: "auto_sample_1",
    name: "Nightly typecheck",
    enabled: true,
    trigger: { type: "cron", expressions: ["0 22 * * 1-5"] },
    action: { type: "cli", command: "bun", args: ["typecheck"], cwd: "." },
    last_run_at: Date.now() - 3_600_000,
    next_run_at: Date.now() + 60_000,
  },
  {
    id: "auto_sample_2",
    name: "Morning standup session",
    enabled: false,
    trigger: { type: "interval", seconds: 3600 },
    action: { type: "new_session", prompt: "Summarize yesterday's progress", auto_focus: false },
  },
]

const sampleRuns: AutomationRun[] = [
  { id: "run_1", automation_id: "auto_sample_1", status: "succeeded", exit_code: 0, duration_ms: 4200, started_at: Date.now() - 3_600_000 },
  { id: "run_2", automation_id: "auto_sample_1", status: "failed", exit_code: 1, duration_ms: 900, started_at: Date.now() - 7_200_000 },
]

export const PreviewRoute: Component = () => {
  const params = useParams()
  const showAttachments = createMemo(() => !params.name || params.name === "all" || params.name === "attachments")
  const showAutomations = createMemo(() => !params.name || params.name === "all" || params.name === "automations")

  return (
    <div class="mx-auto max-w-3xl p-6">
      <h1 class="mb-4 text-20-strong text-text-strong">Preview · {params.name || "all"}</h1>
      <Show when={showAttachments()}>
        <section class="mb-8">
          <h2 class="mb-2 text-16-strong text-text-strong">Attachments</h2>
          <AttachmentRenderer label="Attached deliverables" attachments={sampleAttachments} />
        </section>
      </Show>
      <Show when={showAutomations()}>
        <section class="mb-8">
          <h2 class="mb-2 text-16-strong text-text-strong">Automations</h2>
          <AutomationsPanel automations={sampleAutomations} runs={sampleRuns} />
        </section>
        <section class="mb-8">
          <h2 class="mb-2 text-16-strong text-text-strong">New automation</h2>
          <AutomationEditor />
        </section>
      </Show>
    </div>
  )
}
