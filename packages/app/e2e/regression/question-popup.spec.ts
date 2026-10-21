import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import fs from "node:fs/promises"
import path from "node:path"
import { mockOpenCodeServer } from "../utils/mock-server"
import { trackPageErrors, expectNoSmokeErrors } from "../utils/errors"
import { expectAppVisible } from "../utils/waits"

test.use({ video: "on", screenshot: "on" })

const directory = "C:/OpenCode/QuestionPopup"
const projectID = "proj_question_popup"
const sourceID = "ses_question_source"
const targetID = "ses_question_target"
const doneID = "ses_question_done"
const incompleteID = "ses_question_incomplete"
const requestID = "que_question_target"
const formRequestID = "que_question_form"
const server = `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
// Single-server tab fixtures omit `server` so persisted-tab migration binds them to this controlled test server.
const cardArtPreviewSrc = "C:/GitRepros/PU/Assets/CardArena/Textures/CardImages/SpritesForUICard/Freia_Card.png"
const videoPosterPreviewSrc =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 960 540'%3E%3Crect width='960' height='540' fill='%23111827'/%3E%3Crect x='56' y='56' width='848' height='428' rx='20' fill='%23293448'/%3E%3Cpath d='M412 205v130l118-65z' fill='%23f8fafc'/%3E%3Crect x='86' y='440' width='560' height='8' rx='4' fill='%2364748b'/%3E%3Crect x='86' y='440' width='226' height='8' rx='4' fill='%2338bdf8'/%3E%3Ctext x='86' y='112' font-size='34' font-family='Arial' fill='%23f8fafc'%3EVidMD source preview%3C/text%3E%3Ctext x='86' y='156' font-size='22' font-family='Arial' fill='%23cbd5e1'%3EUse Start hier / Ende hier to mark the cut%3C/text%3E%3C/svg%3E"
const videoFullscreenTestSrc =
  "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAfsEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggfW7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYh64GUNATeGz5yBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhA7msoDgkLCBQLqBJJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WIeuBlDQE3hs9nyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1RirngQCjRUWBAACAECIAnQEqQAAkAABHCIWFiJmEiAICyAX8B/AHqB/gP2A6gD+AMyA/wH8AdcD/AfIF/MP4D/gOYj+gP8P+v/mARrAP8B/ByebokzD4b+Ff7V/4D5CaG/Jftn+4H96ywngz+gfjN/VfcD/gPwB7AH9Pfsr4AP6LfzH+A+wD/Nv8l9//gA/pNwAP6vegr/Vf7v8BH6gf2L/QfAD/NP5P96mIi5Z86Z1f9OvMB/DPYCfGvw5/Ib2M90D/C/xR/Kv1AdUB/IDVAf4D+Dn76//XcAf4D/PPyn/3n0ifhn9U/kv9A/zv+w8wH3Bf0C/kH46f37////D7AeoJ/UXYcZ56AnubZmBKPEuUKwhhFLHn0Ro40rB6u2oWYqoQdlmA/v/ymzBs0fyZ//rKLcCnibf+TFf8qQkkERAKm7wIbnBMrI7mHE/hURQZqpRf+k3xUVaHtiL6RJgn3yQE2XXckM5i9/DqCkfcpRcTs1O2s1DU1Lqq7pyVotQEGekFXKPGkcH/sNTqsi5vCcXuCNSKuYyW64EXFliwYFnaTMFP/6PLhAGqPu6Iz1eqI5Rm12+icOvrXPCjob5e9+//P53DLxVmTbNUEZTIhvYTCuf/2CnBw23Jm49QyNcmfvGCSGVlITjekNRYvWfRj7/NDjWCrWLq5A/yUYf+bLxAD+/ED1Nq2qbUKx/9Xy/MqBgDOifsfVFLpBRuDehWxRCRKbp5bwHkI1qCNtZMCvidOgjoOVVJNELa33m2TBhE4RyliIomqQdZrN04SC3P4uycUez1eV0RzI9Uxc2Cthes/duJJprXIfo//EP9u340rTxLxS/GzTKVMadN96f3ePVnBYy9JFVuKnuvItDBBpFWgz//Igy//5nAQoi+SLml6UV4FM/THSY5zKBkmBukqCqH+Vb+Y38f/pGeOVhPRhVj0B//tAWIgH1qk6xeT6UbkBsQW0DF7/d+//gP/7YH/9n2J/5///nsgkH9cbXmzjfkPwhWCm7nUuMileHzeHDNJuRg6glL4o3dwldrtHr31pMSVJ0c4q/kaFr4XsW7XJ1V4GIl8pd/Pkjjtm5IdTURaYexHE9bSkKwal5bCCQL0CHIH9a0gUV//neus0OA7lOOJixd+29ZxAccskeQ/udVA8VR1bz96ZWTP32GyRYHN/DQayJ/5A3/HIiomzCxJ+rYwuBZk34bj5/95DmGXWs91dR8JULWWL7sMRD3t/5LUd60lpKJoFZkV0a71PonZx2PqTu0XKSw5Sh3DH6dsiBT+JDroZ3tHWTtFk7F1jPieIP+l9TzMn/V+QwRqCWAYJpgPg+N9uQVWwf9D58m7bJGu2kN6eckEVEl/irEybl/petULn5xtsNN7qO/PacUB2InB01fv4JRuwK5yqec2aMVx5OJv0901fv4JqNWfj7P/jheKw/GWJqg1q/iSA5wX043B1Ps+XGcVpirKX/gmk844vSFuTUNZcjqaAlS7ncZ/pwgz4O58KvX/hYfXkMcAhS1jbLGNC6pxuSKwDKse8lvOJsGwQ8yowAVyV38rleYH18RYIIqahhMOwP6RrR5cSuI6ZgP93B0/dC0jX9mR1vpklgADRty/0WeqCPqw2Sckqz1QR9Tdvbs+fttXwuTP8RVc21SJKuZbCjFSkQAAaGJZsIAXqgYuIAgA9QaxVAgA9QaxVA//+Wt//qTf/9Rp/1G9oS7QLBCmJ+LK3oLBCmJ6YZmJlBvhFEUbTyyg3wigRGCbb1jTC+NhzYAAZrmwo6goiL4O1p3mVLQocyyd5lS0KHMsgQADaAAAAAAAKO9gQD6AFECAAQQnAAYCGgxf8Odlp5YABttAJv/yCbaKYfmd6BIWj8nwS/p4kaeiJfoIBMEvw5CmCpeakgAAKO8gQH0AFECAAQQfAAYAjwHn/w2pOTmwAGgWMqkajnx/D1aS7eYyB8r3PVCjRHvZvlTUZnQhLNLxK2LZaPAo+CBAu4AEQMABBBkABjsZyXLcGk/9jVh8ZMrjl+AJbQAzPt3cOEnptCQYggkCJdDk7f9ngU0ks7VCp5RyS+yLeqD2f5JrCBQ5kd27HK/EhninFu/eGp+qKiUVzj0mlF+gwAcU7trkbuPs4EAt4r3gQHxggGm8IED"

function screenshotPath(name: string) {
  return test.info().outputPath(name)
}
const questionRequest = () => ({
  id: requestID,
  sessionID: targetID,
  questions: [
    {
      question: "Answer this from the popup?",
      header: "Popup check",
      options: [
        { label: "Yes", description: "Answer directly from the popup" },
        { label: "Review", description: "Jump to the session first" },
      ],
    },
  ],
})
const secondRequestID = "que_question_target_second"
const secondQuestionRequest = () => ({
  id: secondRequestID,
  sessionID: targetID,
  questions: [
    {
      question: "Second pending question?",
      header: "Queue check",
      options: [
        { label: "Later", description: "Keep this question pending" },
        { label: "Now", description: "Answer this question now" },
      ],
    },
  ],
})
const overflowingQuestionRequest = () => ({
  id: `${requestID}_overflow`,
  sessionID: targetID,
  questions: [
    {
      question: "Pick every option that should remain available in a tight popup.",
      header: "Popup overflow check",
      multiple: true,
      options: Array.from({ length: 16 }, (_, index) => ({
        label: `Option ${index + 1}`,
        description: "This option has enough text to make the popup overflow vertically.",
      })),
    },
  ],
})
const formQuestionRequest = () => ({
  id: formRequestID,
  sessionID: targetID,
  questions: [
    {
      type: "form",
      question: "Review this email draft before sending.",
      header: "Email Draft",
      form: {
        version: 1,
        id: "email-composer.v1",
        title: "Email Composer",
        description: "Edit recipients, subject, body, and attachments in one card.",
        submitLabel: "Approve draft",
        fields: [
          { id: "to", type: "recipient_list", label: "An", required: true, multiple: true },
          { id: "cc", type: "recipient_list", label: "Cc", multiple: true },
          { id: "bcc", type: "recipient_list", label: "Bcc", multiple: true },
          { id: "subject", type: "text", label: "Subject", required: true },
          {
            id: "body",
            type: "rich_text",
            label: "Body",
            required: true,
            rows: 8,
            toolbar: ["bold", "italic", "underline", "link", "bullet_list", "numbered_list"],
          },
          { id: "attachments", type: "file_picker", label: "Attachments", multiple: true },
          {
            id: "action",
            type: "select",
            label: "Action",
            required: true,
            defaultValue: "send",
            options: [
              { id: "send", label: "Send" },
              { id: "draft", label: "Save draft" },
              { id: "cancel", label: "Cancel" },
            ],
          },
        ],
        layout: {
          type: "vstack",
          gap: "18px",
          children: [
            {
              type: "hstack",
              gap: "16px",
              children: [
                { type: "field", field: "to", width: "fill" },
                { type: "field", field: "cc", width: "fill" },
                { type: "field", field: "bcc", width: "fill" },
              ],
            },
            { type: "field", field: "subject" },
            { type: "field", field: "body" },
            { type: "field", field: "attachments" },
            { type: "field", field: "action" },
          ],
        },
      },
    },
  ],
})
const directFormQuestionRequest = () => {
  const request = formQuestionRequest()
  return {
    ...request,
    id: "que_question_form_direct",
    detached: true,
    questions: request.questions.map((question) => ({
      ...question,
      form: {
        ...question.form,
        submitLabel: "Run action",
        actions: [
          { id: "send", trigger: { event: "submit", when: { field: "action", equals: "send" } }, steps: [{ type: "gmail", mode: "send" }] },
          { id: "draft", trigger: { event: "submit", when: { field: "action", equals: "draft" } }, steps: [{ type: "gmail", mode: "draft" }] },
          { id: "cancel", trigger: { event: "submit", when: { field: "action", equals: "cancel" } }, steps: [{ type: "dismiss" }] },
        ],
        fields: question.form.fields.map((field) =>
          field.type === "recipient_list"
            ? { ...field, autocomplete: { provider: "gmail-recipients", minLength: 2 } }
            : field,
        ),
      },
    })),
  }
}
const puCardTweakerRequest = () => ({
  id: "que_question_pu_card_tweaker",
  sessionID: targetID,
  detached: true,
  questions: [
    {
      type: "form",
      question: "Tune a PU card tier without editing JSON by hand.",
      header: "PU Card Tweaker",
      form: {
        version: 1,
        id: "pu-card-tweaker.v1",
        title: "PU Card Tweaker",
        description: "Adjust card tiers with numeric validation, preview art, and script-backed JSON output.",
        tooltip: "Compact form renderer regression fixture.",
        submitLabel: "Run action",
        actions: [
          {
            id: "preview",
            trigger: { event: "submit", when: { field: "output", equals: "preview" } },
            steps: [
              {
                type: "command",
                command: "bun",
                arguments: [".opencode/scripts/pu-card-tweaker-action.ts"],
                directory: "C:/GitRepros/opencode",
              },
            ],
          },
          {
            id: "apply",
            trigger: { event: "submit", when: { field: "output", equals: "apply" } },
            steps: [
              {
                type: "command",
                command: "bun",
                arguments: [".opencode/scripts/pu-card-tweaker-action.ts"],
                directory: "C:/GitRepros/opencode",
              },
            ],
          },
        ],
        fields: [
          {
            id: "card_art_preview",
            type: "image_preview",
            label: "Card art",
            src: cardArtPreviewSrc,
          },
          {
            id: "card",
            type: "select",
            label: "Card",
            required: true,
            defaultValue: "CardFreia",
            options: [
              { id: "CardFreia", label: "CardFreia", description: "Cost 5, score 8 -> 10, EffectFreia" },
              { id: "CardTalia", label: "CardTalia", description: "Cost 2, ongoing one-cost might" },
              { id: "CardAres", label: "CardAres", description: "Cost 7, reveal might burst" },
            ],
          },
          {
            id: "tier",
            type: "select",
            label: "Tier",
            required: true,
            defaultValue: "base",
            options: [
              { id: "base", label: "Base" },
              { id: "upgrade", label: "Upgrade" },
            ],
          },
          { id: "cost", type: "number", label: "Cost", required: true, min: 0, max: 12, step: 1, defaultValue: 5 },
          {
            id: "score",
            type: "number",
            label: "Score",
            tooltip: "Target score after upgrade.",
            required: true,
            min: -20,
            max: 40,
            step: 1,
            defaultValue: 8,
          },
          {
            id: "target_cost_range",
            type: "number_range",
            label: "Cost range",
            min: 0,
            max: 12,
            step: 1,
            startLabel: "Min",
            endLabel: "Max",
            defaultValue: { start: 4, end: 6 },
          },
          {
            id: "target_score_range",
            type: "number_range",
            label: "Score range",
            min: -20,
            max: 40,
            step: 1,
            startLabel: "Min",
            endLabel: "Max",
            defaultValue: { start: 8, end: 12 },
          },
          { id: "effect", type: "text", label: "Effect", required: false, defaultValue: "EffectFreia" },
          { id: "update_preview", type: "button", label: "Update preview" },
          { id: "art_file", type: "file_picker", label: "Art override", accept: "image/*", multiple: false },
          {
            id: "asset_folder",
            type: "folder_picker",
            label: "Asset folder",
            multiple: false,
            defaultValue: ["C:\\GitRepros\\PU\\Assets\\Resources\\Configuration\\CardConfiguration"],
          },
          {
            id: "notes",
            type: "textarea",
            label: "Balance notes",
            rows: 4,
            defaultValue: "Keep the upgrade as a clear reward while avoiding a runaway 5-cost tempo spike.",
          },
          { id: "render_preview", type: "checkbox", label: "Render preview after change", defaultValue: true },
          {
            id: "output",
            type: "select",
            label: "Output",
            defaultValue: "preview",
            options: [
              { id: "preview", label: "Preview JSON patch" },
              { id: "apply", label: "Apply to card config" },
            ],
          },
        ],
        layout: {
          type: "vstack",
          gap: "18px",
          children: [
            {
              type: "hstack",
              gap: "18px",
              children: [
                { type: "field", field: "card_art_preview", width: "180px" },
                {
                  type: "vstack",
                  width: "fill",
                  gap: "16px",
                  children: [
                    { type: "field", field: "card" },
                    {
                      type: "hstack",
                      gap: "16px",
                      children: [
                        { type: "field", field: "tier", width: "160px" },
                        { type: "field", field: "output", width: "fill" },
                      ],
                    },
                    {
                      type: "hstack",
                      gap: "16px",
                      children: [
                        { type: "field", field: "cost", width: "120px" },
                        { type: "field", field: "score", width: "120px" },
                        { type: "field", field: "effect", width: "fill" },
                      ],
                    },
                    {
                      type: "hstack",
                      gap: "16px",
                      children: [
                        { type: "field", field: "target_cost_range", width: "fill" },
                        { type: "field", field: "target_score_range", width: "fill" },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "hstack",
              gap: "16px",
              children: [
                { type: "field", field: "art_file", width: "42%" },
                { type: "field", field: "asset_folder", width: "42%" },
                { type: "field", field: "render_preview", width: "16%" },
              ],
            },
            {
              type: "hstack",
              gap: "16px",
              children: [
                { type: "field", field: "update_preview", width: "160px" },
              ],
            },
            { type: "field", field: "notes" },
          ],
        },
      },
    },
  ],
})
const vidmdCutPreviewRequest = () => ({
  id: "que_question_vidmd_cut_preview",
  sessionID: targetID,
  detached: true,
  questions: [
    {
      type: "form",
      question: "Preview and cut a VidMD source clip.",
      header: "VidMD Cut Preview",
      form: {
        version: 1,
        id: "vidmd-cut-preview.v1",
        title: "VidMD Cut Preview",
        description: "Use the preview timeline to mark a cut range, then run the VidMD script action.",
        submitLabel: "Run action",
        actions: [
          {
            id: "preview",
            trigger: { event: "submit", when: { field: "action", equals: "preview" } },
            steps: [
              {
                type: "command",
                command: "bun",
                arguments: [".opencode/scripts/vidmd-cut-preview-action.ts"],
                directory: "C:/GitRepros/opencode",
              },
            ],
          },
          {
            id: "compile",
            trigger: { event: "submit", when: { field: "action", equals: "compile" } },
            steps: [
              {
                type: "command",
                command: "bun",
                arguments: [".opencode/scripts/vidmd-cut-preview-action.ts"],
                directory: "C:/GitRepros/opencode",
              },
            ],
          },
          {
            id: "mark_start",
            trigger: { event: "markStart", source: "preview" },
            steps: [{ type: "setValue", target: "values.cut_range.start", value: "round(${state.preview.currentTime}, 2)" }],
          },
          {
            id: "mark_end",
            trigger: { event: "markEnd", source: "preview" },
            steps: [{ type: "setValue", target: "values.cut_range.end", value: "round(${state.preview.currentTime}, 2)" }],
          },
        ],
        fields: [
          { id: "project_id", type: "hidden", defaultValue: "will-glow-review" },
          {
            id: "preview",
            type: "video_preview",
            label: "Preview",
            src: videoFullscreenTestSrc,
            poster: videoPosterPreviewSrc,
          },
          {
            id: "cut_range",
            type: "duration_range",
            label: "Cut range",
            required: true,
            min: 0,
            max: 120,
            step: 0.01,
            startLabel: "Start",
            endLabel: "End",
            defaultValue: { start: 12.4, end: 18.9 },
          },
          { id: "source_file", type: "file_picker", label: "Source file", accept: "video/*", multiple: false },
          {
            id: "project_folder",
            type: "folder_picker",
            label: "Project folder",
            multiple: false,
            defaultValue: ["C:\\GitRepros\\ShortFormContent\\projects\\will-glow-review"],
          },
          {
            id: "transcript",
            type: "textarea",
            label: "Keep transcript",
            required: true,
            rows: 5,
            defaultValue:
              "This is the concise part to keep. Cut before the ramble and resume at the next strong sentence.",
          },
          {
            id: "action",
            type: "select",
            label: "Action",
            defaultValue: "preview",
            options: [
              { id: "preview", label: "Preview cut" },
              { id: "compile", label: "Compile VidMD" },
            ],
          },
          {
            id: "transition",
            type: "select",
            label: "Transition",
            defaultValue: "crossfade",
            options: [
              { id: "none", label: "None" },
              { id: "crossfade", label: "Crossfade" },
              { id: "fade", label: "Fade" },
            ],
          },
          { id: "render", type: "checkbox", label: "Render preview after compile", defaultValue: true },
        ],
        layout: {
          type: "vstack",
          children: [
            { type: "field", field: "preview" },
            {
              type: "hstack",
              gap: "16px",
              children: [
                { type: "field", field: "cut_range", width: "fill" },
                { type: "field", field: "transition", width: "fill" },
                { type: "field", field: "action", width: "180px" },
              ],
            },
            {
              type: "hstack",
              gap: "16px",
              children: [
                { type: "field", field: "source_file", width: "fill" },
                { type: "field", field: "project_folder", width: "fill" },
              ],
            },
            { type: "field", field: "transcript" },
            { type: "field", field: "render" },
          ],
        },
      },
    },
  ],
})

test("selects folder paths without uploading or enumerating their files", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const uploads: string[] = []
  let choosers = 0
  const request = {
    id: "que_folder_paths",
    sessionID: targetID,
    questions: [{
      type: "form",
      question: "Choose the project folder.",
      form: {
        version: 1,
        id: "folder-paths-v1",
        submitLabel: "Confirm folder",
        fields: [
          { id: "folder", type: "folder_picker", label: "Project folder", required: true },
          { id: "file", type: "file_picker", label: "Source file" },
        ],
        layout: { type: "vstack", children: [{ type: "field", field: "folder" }, { type: "field", field: "file" }] },
      },
    }],
  }
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, vcs: "git", name: "question-popup", time: { created: 1700000000000, updated: 1700000000000 }, sandboxes: [] },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "test-model": { id: "test-model", name: "Test model", limit: { context: 200_000 } } } }],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test-model" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => replies.length ? [] : [request],
    events: () => [{ directory, payload: { id: "evt_folder_paths", type: "surface.asked", properties: request } }],
    onQuestionReply: (reply) => { replies.push(reply); return true },
  })
  await page.addInitScript(({ directory, sourceID }) => {
    localStorage.setItem("settings.v3", JSON.stringify({}))
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({ projects: { local: [{ worktree: directory, expanded: true }] }, lastProject: { local: directory } }))
    localStorage.setItem("opencode.global.dat:tabs", JSON.stringify([{ type: "session", dirBase64: btoa(directory), sessionId: sourceID }]))
  }, { directory, sourceID })
  page.on("filechooser", () => { choosers++ })
  page.on("request", (request) => {
    if (request.method() === "POST" && /attachment|upload|blob/.test(request.url())) uploads.push(request.url())
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const popup = page.locator('[data-component="question-popup"]')
  const folder = popup.locator('[data-field-type="folder_picker"]')
  await expectAppVisible(folder)
  await expect(folder.locator('input[type="file"]')).toHaveCount(0)
  await expect(page.locator("[webkitdirectory]")).toHaveCount(0)
  await expect(popup.locator('[data-field-type="file_picker"] input[type="file"]')).toHaveCount(1)
  await folder.getByRole("button", { name: "Browse", exact: true }).click()
  const picker = page.getByRole("dialog", { name: "Project folder", exact: true })
  await expectAppVisible(picker)
  await picker.getByText("QuestionPopup", { exact: true }).click()
  await expect(picker).toHaveCount(0)
  await expect(folder.locator('[data-slot="question-form-chip"] > span')).toHaveText(["C:\\OpenCode\\QuestionPopup"])
  // Cancellation must leave the root path intact and keep the original form open.
  await folder.getByRole("button", { name: "Browse", exact: true }).click()
  await expectAppVisible(picker)
  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
  await expect(folder.locator('[data-slot="question-form-chip"] > span')).toHaveText(["C:\\OpenCode\\QuestionPopup"])
  // Manual input is one path, not a list split on punctuation in directory names.
  const manual = "C:\\Projects\\Cringebot, test; empty"
  await folder.locator('input[type="text"]').fill(manual)
  await folder.getByRole("button", { name: "Add", exact: true }).click()
  await expect(folder.locator('[data-slot="question-form-chip"] > span')).toHaveText([manual])
  await page.screenshot({ path: screenshotPath("folder-path-only.png"), fullPage: true })
  await popup.getByRole("button", { name: "Confirm folder", exact: true }).click()
  await expect.poll(() => replies.length).toBe(1)
  const body = replies[0]!.body as { answers: string[][] }
  expect(JSON.parse(body.answers[0]![0]!)).toMatchObject({ type: "opencode.form.answer", values: { folder: [manual] } })
  expect(choosers).toBe(0)
  expect(uploads).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("jumps from the out-of-session question popup to the target session", async ({ page }) => {
  const errors = trackPageErrors(page)

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [questionRequest()],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked",
          type: "surface.asked",
          properties: questionRequest(),
        },
      },
    ],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: sourceID },
          { type: "session", dirBase64: btoa(`${directory}/stale`), sessionId: targetID },
        ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)
  await expectAppVisible(page.locator('[data-component="question-popup"]'))
  await expectAppVisible(page.getByText("Answer this from the popup?"))
  await expect(page.getByText("Implementation complete")).toHaveCount(0)
  await expectAppVisible(page.getByRole("button", { name: "Go to session" }))

  await page.getByRole("button", { name: "Go to session" }).click()

  await expectAppVisible(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Question target" }))
  await expectAppVisible(page.getByRole("heading", { name: "Question target" }))
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)
  await expectAppVisible(page.getByText("Answer this from the popup?"))
  await expect
    .poll(() =>
      page.evaluate(
        ({ targetID, staleDirBase64 }) => {
          const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
            dirBase64?: string
            sessionId?: string
          }>
          const matches = tabs.filter((tab) => tab.sessionId === targetID)
          return { count: matches.length, stale: matches[0]?.dirBase64 === staleDirBase64 }
        },
        { targetID, staleDirBase64: base64Encode(`${directory}/stale`) },
      ),
    )
    .toEqual({ count: 1, stale: false })
  await expect(page.locator(`[data-dock-tab][data-session-id="${targetID}"]`)).toHaveCount(1)
  await page.screenshot({ path: screenshotPath("question-popup-session-jump.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(page.getByRole("heading", { name: "Question target" }))
  await expect
    .poll(() =>
      page.evaluate((targetID) => {
        const tabs = JSON.parse(localStorage.getItem("opencode.global.dat:tabs") ?? "[]") as Array<{
          sessionId?: string
        }>
        return tabs.filter((tab) => tab.sessionId === targetID).length
      }, targetID),
    )
    .toBe(1)
  await page.screenshot({ path: screenshotPath("question-popup-session-jump-mobile.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps a mixed-case Windows V2 question inline in the initially active session", async ({ page }) => {
  const errors = trackPageErrors(page)
  const request = {
    ...questionRequest(),
    id: "que_question_active_mixed_case",
    sessionID: sourceID,
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source")],
    pageMessages: () => ({ items: [] }),
    questions: () => [],
    events: () => [
      {
        directory: directory.toLowerCase(),
        payload: {
          id: "evt_question_v2_active_mixed_case",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)

  const inline = page.locator(
    '[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]',
  )
  await expectAppVisible(inline.getByText("Answer this from the popup?"))
  await expect(inline).toHaveCount(1)
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("shows a subagent on-demand question inline in its initially active parent and replies to the child", async ({ page }) => {
  const errors = trackPageErrors(page)
  const childID = "ses_question_subagent"
  const continuedPromptID = "msg_question_subagent_prompt"
  const continuedMessageID = "msg_question_subagent_continued"
  const request = {
    ...questionRequest(),
    id: "que_question_subagent_on_demand",
    sessionID: childID,
    questions: [
      {
        type: "show_options",
        question: "Choose the implementation model without losing this plan.",
        header: "Implementation model",
        allowFeedback: true,
        placeholder: "Optional implementation note",
        options: [
          { label: "GLM-5.2", description: "Continue implementation with the cheaper model" },
          { label: "Sol High", description: "Keep the review model" },
        ],
      },
    ],
  }
  const replies: { requestID: string; body: unknown }[] = []
  let continued = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(childID, "Model implementation (@glm subagent)", sourceID)],
    pageMessages: (sessionID) => ({
      items:
        sessionID === sourceID
          ? [
              {
                info: {
                  id: "msg_question_subagent_parent_user",
                  sessionID: sourceID,
                  role: "user",
                  time: { created: 1699999998000 },
                  agent: "general",
                  model: { providerID: "opencode", modelID: "claude-opus-4-6" },
                },
                parts: [
                  {
                    id: "prt_question_subagent_parent_user",
                    sessionID: sourceID,
                    messageID: "msg_question_subagent_parent_user",
                    type: "text",
                    text: "Implement this with a subagent.",
                  },
                ],
              },
              {
                info: {
                  id: "msg_question_subagent_parent_assistant",
                  sessionID: sourceID,
                  role: "assistant",
                  parentID: "msg_question_subagent_parent_user",
                  time: { created: 1699999999000, completed: 1700000000000 },
                  agent: "general",
                  mode: "build",
                  modelID: "claude-opus-4-6",
                  providerID: "opencode",
                  path: { cwd: directory, root: directory },
                  cost: 0,
                  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                  finish: "stop",
                },
                parts: [
                  {
                    id: "prt_question_subagent_parent_task",
                    sessionID: sourceID,
                    messageID: "msg_question_subagent_parent_assistant",
                    type: "tool",
                    tool: "task",
                    state: {
                      status: "completed",
                      input: { description: "Model implementation", subagent_type: "general" },
                      output: "Waiting for the model choice.",
                      metadata: { sessionId: childID },
                    },
                  },
                ],
              },
            ]
          : sessionID === childID && continued
          ? [
              {
                info: {
                  id: continuedPromptID,
                  sessionID: childID,
                  role: "user",
                  time: { created: 1700000000000 },
                  agent: "general",
                  model: { providerID: "opencode", modelID: "glm-5.2" },
                },
                parts: [
                  {
                    id: "prt_question_subagent_prompt",
                    sessionID: childID,
                    messageID: continuedPromptID,
                    type: "text",
                    text: "Continue after the model choice.",
                  },
                ],
              },
              {
                info: {
                  id: continuedMessageID,
                  sessionID: childID,
                  role: "assistant",
                  parentID: continuedPromptID,
                  time: { created: 1700000001000, completed: 1700000002000 },
                  agent: "general",
                  mode: "build",
                  modelID: "glm-5.2",
                  providerID: "opencode",
                  path: { cwd: directory, root: directory },
                  cost: 0,
                  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                  finish: "stop",
                },
                parts: [
                  {
                    id: "prt_question_subagent_continued",
                    sessionID: childID,
                    messageID: continuedMessageID,
                    type: "text",
                    text: "Implementation resumed exactly once with GLM-5.2.",
                  },
                ],
              },
            ]
          : [],
    }),
    questions: () => (continued ? [] : [request]),
    events: () =>
      continued
        ? []
        : [
            {
              directory,
              payload: {
                id: "evt_question_v2_subagent_on_demand",
                type: "surface.asked",
                properties: request,
              },
            },
          ],
    onQuestionReply: async (input) => {
      replies.push(input)
      await new Promise((resolve) => setTimeout(resolve, 150))
      continued = true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)

  const inline = page.locator(
    '[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]',
  )
  await expectAppVisible(inline.getByText("Choose the implementation model without losing this plan."))
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)
  await inline.locator('[data-slot="question-option"]').filter({ hasText: "GLM-5.2" }).click()
  await inline.locator('[data-slot="question-free-input"]').fill("Keep the reviewed plan intact")
  const reply = page.waitForRequest((candidate) => {
    if (candidate.method() !== "POST") return false
    return new URL(candidate.url()).pathname === `/api/session/${childID}/surface/${request.id}/reply`
  })
  await inline.getByRole("button", { name: "Submit" }).evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("expected submit button")
    button.click()
    button.click()
  })
  await reply
  await expect
    .poll(() => replies)
    .toEqual([
      {
        requestID: request.id,
        body: { answers: [["GLM-5.2", "feedback: Keep the reviewed plan intact"]] },
      },
    ])
  await expect(inline).toHaveCount(0)

  await page.locator('[data-component="task-tool-card"]').click()
  await expect(
    page.locator(`[data-dock-area="middle"] [data-dock-tab][data-session-id="${childID}"]`).getByRole("tab"),
  ).toHaveAttribute("aria-selected", "true")
  await expectAppVisible(page.getByText("Implementation resumed exactly once with GLM-5.2."))
  await expect.poll(() => replies).toHaveLength(1)
  expectNoSmokeErrors(errors, [], [])
})

test("routes V2 question popups from a background directory", async ({ page }) => {
  const errors = trackPageErrors(page)
  const backgroundDirectory = "C:/OpenCode/QuestionPopupBackground"
  const backgroundSessionID = "ses_question_background"
  const rejectedRequest = {
    ...questionRequest(),
    id: "que_question_background_rejected",
    sessionID: backgroundSessionID,
  }
  const repliedRequest = {
    ...questionRequest(),
    id: "que_question_background_replied",
    sessionID: backgroundSessionID,
  }
  const events: Array<{ directory: string; payload: { id: string; type: string; properties: unknown } }> = []
  const replies: { requestID: string; body: unknown }[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: [
      {
        id: projectID,
        worktree: directory,
        vcs: "git",
        name: "question-popup",
        time: { created: 1700000000000, updated: 1700000000000 },
        sandboxes: [],
      },
      {
        id: "proj_question_popup_background",
        worktree: backgroundDirectory,
        vcs: "git",
        name: "question-popup-background",
        time: { created: 1700000000001, updated: 1700000000001 },
        sandboxes: [],
      },
    ],
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      session(sourceID, "Question source"),
      {
        ...session(backgroundSessionID, "Background question"),
        projectID: "proj_question_popup_background",
        directory: backgroundDirectory,
      },
    ],
    pageMessages: () => ({ items: [] }),
    questions: () => [],
    eventRetry: 16,
    globalEvents: () => events.splice(0),
    onQuestionReply: (input) => {
      replies.push(input)
    },
  })

  await page.addInitScript(
    ({ directory, backgroundDirectory, dirBase64, backgroundDirBase64, sourceID, backgroundSessionID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: {
            local: [
              { worktree: directory, expanded: true },
              { worktree: backgroundDirectory, expanded: true },
            ],
          },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: sourceID },
          { type: "session", dirBase64: backgroundDirBase64, sessionId: backgroundSessionID },
        ]),
      )
    },
    {
      directory,
      backgroundDirectory,
      dirBase64: base64Encode(directory),
      backgroundDirBase64: base64Encode(backgroundDirectory),
      sourceID,
      backgroundSessionID,
    },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  await page.locator(`[data-dock-tab][data-session-id="${backgroundSessionID}"]`).click()
  await expectAppVisible(page.getByRole("heading", { name: "Background question" }))
  await page.locator(`[data-dock-tab][data-session-id="${sourceID}"]`).click()
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  const sourceUrl = page.url()

  events.push({
    directory: backgroundDirectory,
    payload: {
      id: "evt_question_v2_background_asked_rejected",
      type: "surface.asked",
      properties: rejectedRequest,
    },
  })
  await expect.poll(() => events.length).toBe(0)
  await expectAppVisible(page.locator('[data-component="question-popup"]'))
  await expectAppVisible(page.getByText("Answer this from the popup?"))
  expect(page.url()).toBe(sourceUrl)

  events.push({
    directory: backgroundDirectory,
    payload: {
      id: "evt_question_v2_background_rejected",
      type: "surface.dismissed",
      properties: { sessionID: backgroundSessionID, requestID: rejectedRequest.id },
    },
  })
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)

  events.push({
    directory: backgroundDirectory,
    payload: {
      id: "evt_question_v2_background_asked_replied",
      type: "surface.asked",
      properties: repliedRequest,
    },
  })
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  const reply = page.waitForRequest((request) =>
    new URL(request.url()).pathname.endsWith(
      `/api/session/${backgroundSessionID}/surface/${repliedRequest.id}/reply`,
    ),
  )
  await popup.getByRole("button", { name: "Submit" }).click()
  const request = await reply
  expect(decodeURIComponent(request.headers()["x-opencode-directory"] ?? "").toLowerCase()).toBe(
    backgroundDirectory.toLowerCase(),
  )
  await expect.poll(() => replies).toEqual([{ requestID: repliedRequest.id, body: { answers: [["Yes"]] } }])
  await expect(popup).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("keeps a minimized question inline without reopening its popup in the waiting session", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const sessions = [
    session(sourceID, "Question source"),
    session(targetID, "Question target"),
    session(doneID, "Question done"),
    session(incompleteID, "Question incomplete"),
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
    questions: () => (replies.length ? [] : [questionRequest()]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked_minimize",
          type: "surface.asked",
          properties: questionRequest(),
        },
      },
      {
        directory,
        payload: {
          id: "evt_question_done",
          type: "session.turn.completed",
          properties: { sessionID: doneID, status: "done" },
        },
      },
      {
        directory,
        payload: {
          id: "evt_question_incomplete",
          type: "session.turn.completed",
          properties: { sessionID: incompleteID, status: "incomplete" },
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })
  await mockNavigatorPlugin(page, sessions)

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: sourceID },
          { type: "session", dirBase64, sessionId: targetID },
        ]),
      )
      localStorage.setItem(
        "opencode.global.dat:layout",
        JSON.stringify({
          dock: {
            left: {
              visible: true,
              size: 300,
              tabs: ["session-navigator-app/sessionNavigator"],
              active: "session-navigator-app/sessionNavigator",
            },
            items: {
              "session-navigator-app/sessionNavigator": { area: "left", visible: true },
            },
          },
        }),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)
  const popup = page.locator('[data-component="question-popup"]')
  const targetTab = page.locator(`[data-dock-tab][data-session-id="${targetID}"]`)
  const navigator = page.locator(".oc-session-nav")
  const targetNav = navigator.locator(`.oc-session-nav__session[data-session-id="${targetID}"]`).first()
  const targetNavQuestionDots = navigator.locator(
    `.oc-session-nav__session[data-session-id="${targetID}"] [data-slot="session-status-dot"][data-status="attention"]`,
  )
  const targetNavQuestionDot = targetNavQuestionDots.first()

  await expectAppVisible(popup)
  await expectAppVisible(navigator)
  await expectAppVisible(targetTab.locator('[data-slot="project-avatar-unread-dot"][data-status="question"]'))
  await expectAppVisible(targetNavQuestionDot)
  await expect(targetNavQuestionDot).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expectAppVisible(
    navigator
      .locator(`.oc-session-nav__session[data-session-id="${doneID}"] [data-slot="session-status-dot"][data-status="done"]`)
      .first(),
  )
  await expectAppVisible(
    navigator
      .locator(`.oc-session-nav__session[data-session-id="${incompleteID}"] [data-slot="session-status-dot"][data-status="incomplete"]`)
      .first(),
  )

  await popup.getByRole("button", { name: "Minimize" }).click()

  await expect(popup).toHaveCount(0)
  await expect(page.getByText("Answer this from the popup?", { exact: true })).toHaveCount(0)
  await expectAppVisible(targetTab.locator('[data-slot="project-avatar-unread-dot"][data-status="question"]'))
  await expectAppVisible(targetNavQuestionDot)
  await page.screenshot({ path: screenshotPath("question-popup-minimized-open-status-dots.png"), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(popup).toHaveCount(0)
  await expect(page.locator('[data-component="question-popup-minimized"]')).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-popup-minimized-mobile-status-dots.png"), fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })

  await targetTab.getByText("Question target").click()

  await expectAppVisible(page.getByRole("heading", { name: "Question target" }))
  const inlineQuestion = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(inlineQuestion.getByText("Answer this from the popup?"))
  await expect(popup).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAppVisible(inlineQuestion.getByText("Answer this from the popup?"))
  await expect(popup).toHaveCount(0)

  await inlineQuestion.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await inlineQuestion.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replies).toEqual([{ requestID, body: { answers: [["Yes"]] } }])
  await expect(targetNavQuestionDots).toHaveCount(0)
  await expect(targetTab.locator('[data-slot="project-avatar-unread-dot"][data-status="question"]')).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-popup-minimized-status-dots.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("recovers a server-pending question inline when its session becomes active", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions = [session(sourceID, "Question source"), session(targetID, "Question target")]
  let revealQuestion = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
    questions: () => (revealQuestion ? [questionRequest()] : []),
    events: () => [],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: sourceID },
          { type: "session", dirBase64, sessionId: targetID },
        ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  const popup = page.locator('[data-component="question-popup"]')
  await expect(popup).toHaveCount(0)

  revealQuestion = true
  await page.locator(`[data-dock-tab][data-session-id="${targetID}"]`).getByText("Question target").click()

  await expectAppVisible(page.getByRole("heading", { name: "Question target" }))
  const inlineQuestion = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(inlineQuestion.getByText("Answer this from the popup?"))
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-popup-recovered-inline-only.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("removes a stale local question when its active session is no longer pending", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions = [session(sourceID, "Question source"), session(targetID, "Question target")]
  let eventSent = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
    questions: () => [],
    events: () => {
      if (eventSent) return []
      eventSent = true
      return [
        {
          directory,
          payload: { id: "evt_stale_question_for_activation", type: "surface.asked", properties: questionRequest() },
        },
      ]
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: sourceID },
          { type: "session", dirBase64, sessionId: targetID },
        ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, targetID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Answer this from the popup?"))

  await page.locator(`[data-dock-tab][data-session-id="${targetID}"]`).getByText("Question target").click()

  await expectAppVisible(page.getByRole("heading", { name: "Question target" }))
  await expect(popup).toHaveCount(0)
  await expect(page.locator('[data-component="dock-prompt"][data-kind="question"]')).toHaveCount(0)
  await expect(page.locator(`[data-dock-tab][data-session-id="${targetID}"] [data-status="question"]`)).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("preserves a newer question event when active-session recovery returns a stale snapshot", async ({ page }) => {
  const errors = trackPageErrors(page)
  const sessions = [session(sourceID, "Question source"), session(targetID, "Question target")]
  const newerRequest = {
    ...questionRequest(),
    questions: [{ ...questionRequest().questions[0], question: "Newer question from the live event?" }],
  }
  const events: {
    directory: string
    payload: { id: string; type: string; properties: ReturnType<typeof questionRequest> }
  }[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions,
    pageMessages: () => ({ items: [] }),
    questions: () => [],
    eventRetry: 32,
    events: () => events.splice(0),
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([
          { type: "session", dirBase64, sessionId: sourceID },
          { type: "session", dirBase64, sessionId: targetID },
        ]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID, targetID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  let startPendingList = () => {}
  const pendingListStarted = new Promise<void>((resolve) => {
    startPendingList = resolve
  })
  let releasePendingList = () => {}
  const pendingListRelease = new Promise<void>((resolve) => {
    releasePendingList = resolve
  })
  let completedPendingLists = 0
  await page.route("**/api/surface/request*", async (route) => {
    startPendingList()
    await pendingListRelease
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: { directory }, data: [questionRequest()] }),
    })
    completedPendingLists += 1
  })

  await page.locator(`[data-dock-tab][data-session-id="${targetID}"]`).getByText("Question target").click()
  await pendingListStarted
  events.push({
    directory,
    payload: { id: "evt_question_newer_during_recovery", type: "surface.asked", properties: newerRequest },
  })

  const inlineQuestion = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(inlineQuestion.getByText("Newer question from the live event?", { exact: true }))
  releasePendingList()
  await expect.poll(() => completedPendingLists).toBeGreaterThan(0)
  await expectAppVisible(inlineQuestion.getByText("Newer question from the live event?", { exact: true }))
  await expect(inlineQuestion.getByText("Answer this from the popup?", { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("shows child session questions as out-of-session popups while viewing the parent", async ({ page }) => {
  const errors = trackPageErrors(page)
  const childID = "ses_question_child"
  const childRequest = {
    ...questionRequest(),
    id: "que_question_child",
    sessionID: childID,
    detached: true,
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question parent"), session(childID, "Question child", sourceID)],
    pageMessages: () => ({ items: [] }),
    questions: () => [childRequest],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_child_question_asked",
          type: "surface.asked",
          properties: childRequest,
        },
      },
    ],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)
  await expectAppVisible(popup.getByText("Question child"))
  await expectAppVisible(popup.getByText("Answer this from the popup?"))
  await page.screenshot({ path: screenshotPath("question-popup-child-session.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("submits an answer from the out-of-session question popup and closes it", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const replyPaths: string[] = []

  page.on("request", (candidate) => {
    const path = new URL(candidate.url()).pathname
    if (!path.endsWith(`/surface/${requestID}/reply`)) return
    replyPaths.push(path)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (replies.length ? [] : [questionRequest()]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked",
          type: "surface.asked",
          properties: questionRequest(),
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })
  await page.route("**/api/surface/request*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ location: { directory }, data: [] }),
    }),
  )

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)

  await expect(popup).toHaveAttribute("role", "dialog")
  await expect(popup).toHaveAttribute("aria-modal", "false")
  await expect(popup).toHaveAccessibleName(/\S/)
  await expect(popup.getByText("Erwartet: Eine Option auswählen und bestätigen.", { exact: true })).toBeVisible()
  const options = popup.getByRole("radiogroup", { name: "Answer this from the popup?" })
  await expect(options).toBeVisible()
  const yes = options.getByRole("radio", { name: /Yes/ })
  await expect(yes).toHaveAttribute("aria-checked", "false")
  await yes.focus()
  await page.keyboard.press("ArrowDown")
  await expect(options.getByRole("radio", { name: /Review/ })).toBeFocused()
  await page.keyboard.press("Home")
  await expect(yes).toBeFocused()
  await yes.click()
  await expect(yes).toHaveAttribute("aria-checked", "true")
  await popup.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replies).toEqual([{ requestID, body: { answers: [["Yes"]] } }])
  expect(replyPaths).toEqual([`/api/session/${targetID}/surface/${requestID}/reply`])
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-popup-direct-answer.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("walks all 32 review questions, follows progress, and wraps detached titles", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const selectedLabels = Array.from({ length: 32 }, (_, index) => `Apply review decision ${index + 1}`)
  const request = {
    id: "que_question_32_review_sections",
    sessionID: targetID,
    questions: selectedLabels.map((label, index) => ({
      type: "review_section",
      question: `Review decision ${index + 1}?`,
      header: `Review ${index + 1}`,
      content: `Evidence and risk summary for review decision ${index + 1}.`,
      custom: false,
      options: [
        { label: `Unselected default ${index + 1}`, description: "This option must not leak into the reply." },
        { label, description: `Deliberate answer for review decision ${index + 1}.` },
      ],
    })),
  }
  const detachedTitle =
    "Review this unusually long detached multi-question title without overflowing the narrow popup"
  const detachedRequest = {
    id: "que_question_detached_long_title",
    sessionID: targetID,
    detached: true,
    questions: [
      {
        question: "Choose the first detached action.",
        header: detachedTitle,
        custom: false,
        options: [{ label: "Keep first action", description: "Preserve the first detached action." }],
      },
      {
        question: "Choose the second detached action.",
        header: "Second detached action",
        custom: false,
        options: [{ label: "Keep second action", description: "Preserve the second detached action." }],
      },
    ],
  }
  let reviewEventSent = false
  let detachedEventSent = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    eventRetry: 256,
    questions: () => {
      if (replies.length === 0) return [request]
      if (replies.length === 1) return [detachedRequest]
      return []
    },
    events: () => {
      if (!reviewEventSent) {
        reviewEventSent = true
        return [
          {
            directory,
            payload: {
              id: "evt_question_32_review_sections",
              type: "surface.asked",
              properties: request,
            },
          },
        ]
      }
      if (replies.length !== 1 || detachedEventSent) return []
      detachedEventSent = true
      return [
        {
          directory,
          payload: {
            id: "evt_question_detached_long_title",
            type: "surface.asked",
            properties: detachedRequest,
          },
        },
      ]
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  const progressBar = popup.locator('[data-slot="question-progress"]')
  const progress = popup.locator('[data-slot="question-progress-segment"]')
  await expectAppVisible(popup)
  await expect.poll(async () => (await popup.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(670)
  await expect
    .poll(async () => {
      const popupBox = await popup.boundingBox()
      const dockBox = await popup.locator(':scope > [data-component="dock-prompt"][data-kind="question"]').boundingBox()
      return popupBox && dockBox ? popupBox.height - dockBox.height : Number.POSITIVE_INFINITY
    })
    .toBeLessThanOrEqual(120)
  await expect(progress).toHaveCount(selectedLabels.length)
  await popup.getByRole("button", { name: "Surface menu" }).click()
  await page.getByRole("menuitem", { name: "Im Vollbild öffnen" }).click()
  await expect(popup.locator('[data-component="dock-prompt"][data-fullscreen="true"]')).toHaveCount(1)

  for (const [index, label] of selectedLabels.entries()) {
    await expect(popup.locator('[data-slot="question-header-title"]')).toHaveText(
      `${index + 1} of ${selectedLabels.length} questions`,
    )
    await expectAppVisible(popup.getByText(`Review decision ${index + 1}?`, { exact: true }))
    await expect(progress.nth(index)).toHaveAttribute("data-active", "true")
    await expect(progress.nth(index)).toBeInViewport()

    const selected = popup.locator('[data-slot="question-option"]').filter({ hasText: label })
    await selected.click()
    await expect(selected).toHaveAttribute("data-picked", "true")
    await expect(progress.nth(index)).toHaveAttribute("data-answered", "true")

    if (index === 4) {
      await popup.getByRole("button", { name: "Back" }).click()
      await expect(popup.locator('[data-slot="question-header-title"]')).toHaveText(
        `4 of ${selectedLabels.length} questions`,
      )
      await expectAppVisible(popup.getByText("Review decision 4?", { exact: true }))
      await expect(
        popup.locator('[data-slot="question-option"]').filter({ hasText: selectedLabels[3] }),
      ).toHaveAttribute("data-picked", "true")
      await popup.getByRole("button", { name: "Next" }).click()
      await expect(popup.locator('[data-slot="question-header-title"]')).toHaveText(
        `5 of ${selectedLabels.length} questions`,
      )
      await expect(selected).toHaveAttribute("data-picked", "true")
    }

    if (index < selectedLabels.length - 1) {
      await expect(popup.getByRole("button", { name: "Submit" })).toHaveCount(0)
      await popup.getByRole("button", { name: "Next" }).click()
      continue
    }

    await expect(popup.getByRole("button", { name: "Next" })).toHaveCount(0)
    await popup.getByRole("button", { name: "Surface menu" }).click()
    await page.getByRole("menuitem", { name: "Vollbild verlassen" }).click()
    await expect(popup.locator('[data-component="dock-prompt"][data-fullscreen="true"]')).toHaveCount(0)
    await expect(progress.nth(index)).toBeInViewport()
    const titleBox = await popup.locator('[data-slot="question-header-title"]').boundingBox()
    expect(titleBox?.width).toBeGreaterThan(100)
    expect(titleBox?.height).toBeLessThanOrEqual(24)
    const segmentBox = await progress.nth(index).boundingBox()
    expect(segmentBox?.width).toBeGreaterThanOrEqual(16)
    await expect(progress.nth(index)).toBeInViewport()
    await page.screenshot({ path: screenshotPath("question-popup-32-review-sections.png"), fullPage: true })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => (await popup.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(818)
    await expect
      .poll(async () => {
        const popupBox = await popup.boundingBox()
        const dockBox = await popup.locator(':scope > [data-component="dock-prompt"][data-kind="question"]').boundingBox()
        return popupBox && dockBox ? popupBox.height - dockBox.height : Number.POSITIVE_INFINITY
      })
      .toBeLessThanOrEqual(120)
    const mobileTitleBox = await popup.locator('[data-slot="question-header-title"]').boundingBox()
    expect(mobileTitleBox?.width).toBeGreaterThan(100)
    expect(mobileTitleBox?.height).toBeLessThanOrEqual(24)
    await expect.poll(() => progressBar.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(true)
    await expect(progress.nth(index)).toBeInViewport()
    await progress.nth(28).click()
    const mobileSegmentBox = await progress.nth(28).boundingBox()
    expect(mobileSegmentBox?.width).toBeGreaterThanOrEqual(16)
    for (let target = 29; target < selectedLabels.length; target++) {
      await popup.getByRole("button", { name: "Next" }).click()
      await expect(popup.locator('[data-slot="question-header-title"]')).toHaveText(
        `${target + 1} of ${selectedLabels.length} questions`,
      )
      await expect(progress.nth(target)).toBeInViewport()
    }
    await page.screenshot({ path: screenshotPath("question-popup-32-review-sections-mobile.png"), fullPage: true })
    await popup.getByRole("button", { name: "Submit" }).click()
  }

  await expect.poll(() => replies).toHaveLength(1)
  expect(replies[0]).toEqual({
    requestID: request.id,
    body: { answers: selectedLabels.map((label) => [label]) },
  })

  const detachedTitleElement = popup.locator('[data-slot="question-header-title"]')
  await expectAppVisible(detachedTitleElement.getByText(detachedTitle, { exact: true }))
  await expect(detachedTitleElement).not.toHaveAttribute("data-progress-title", "true")
  await expect.poll(() => popup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: screenshotPath("question-popup-detached-long-title-mobile.png"), fullPage: true })
  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Keep first action" }).click()
  await popup.getByRole("button", { name: "Next" }).click()
  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Keep second action" }).click()
  await popup.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replies).toHaveLength(2)
  expect(replies[1]).toEqual({
    requestID: detachedRequest.id,
    body: { answers: [["Keep first action"], ["Keep second action"]] },
  })
  await expect(popup).toHaveCount(0)
  await expect(page.locator('[data-component="dock-prompt"][data-kind="question"]')).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("keeps an out-of-session popup visible while an answer request is in flight", async ({ page }) => {
  test.setTimeout(45_000)
  const errors = trackPageErrors(page)

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [questionRequest()],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked",
          type: "surface.asked",
          properties: questionRequest(),
        },
      },
    ],
  })

  let replyAttempts = 0
  await page.route("**/surface/**/reply", async (route) => {
    replyAttempts++
    if (replyAttempts === 1) return route.abort("failed")
    await new Promise((resolve) => setTimeout(resolve, 20_000))
    return route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)

  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await popup.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replyAttempts).toBeGreaterThan(0)
  await expectAppVisible(popup)
  await page.screenshot({ path: screenshotPath("question-popup-retrying.png"), fullPage: true })
  expect(errors.filter((error) => error !== "Failed to load resource: net::ERR_FAILED")).toEqual([])
})

test("rejects an out-of-session question before dismissing its popup", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const rejects: string[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [questionRequest()],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked",
          type: "surface.asked",
          properties: questionRequest(),
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
    onQuestionReject: (reply) => {
      rejects.push(reply.requestID)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)

  await popup.getByRole("button", { name: "Dismiss" }).click()

  await expect(popup).toHaveCount(0)
  expect(replies).toEqual([])
  expect(rejects).toEqual([questionRequest().id])
  await page.screenshot({ path: screenshotPath("question-popup-local-dismiss-mobile.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps settling dismiss session-owned after its rejected event unmounts the question", async ({ page }) => {
  const errors = trackPageErrors(page)
  const request = { ...questionRequest(), id: "que_question_dismiss_fresh_turn", sessionID: sourceID }
  const rejects: string[] = []
  const prompts: unknown[] = []
  let activityAvailable = false
  let pending = true
  const events: unknown[] = [
    {
      directory,
      payload: { id: "evt_question_dismiss_fresh_turn", type: "surface.asked", properties: request },
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source")],
    pageMessages: () => ({ items: [] }),
    questions: () => (pending ? [request] : []),
    eventRetry: 10,
    events: () => events.splice(0),
    onQuestionReject: async (input) => {
      rejects.push(input.requestID)
      pending = false
      events.push({
        directory,
        payload: {
          id: "evt_question_dismiss_fresh_turn_rejected",
          type: "surface.dismissed",
          properties: { sessionID: sourceID, requestID: request.id },
        },
      })
      return { status: "settling", activityID: "act_question_dismiss_fresh_turn" }
    },
    onSessionActivity: () =>
      activityAvailable
        ? { data: { type: "idle" } }
        : { data: { type: "unknown" } },
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_after_dismiss", admittedSeq: 2 } }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const questionDock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock)
  await questionDock.getByRole("button", { name: "Dismiss" }).click()
  await expect.poll(() => rejects).toEqual([request.id])
  await expect(questionDock).toHaveCount(0)
  await expect(page.locator('[data-component="session-composer"]')).toHaveCount(0)
  expect(prompts).toEqual([])

  const settlement = page.locator('[data-component="question-settlement-status"]')
  await expectAppVisible(settlement)
  await expect(settlement.getByRole("button", { name: "Retry" })).toBeVisible()
  expect(prompts).toEqual([])

  activityAvailable = true
  await settlement.getByRole("button", { name: "Retry" }).click()
  await expect(settlement).toHaveCount(0)
  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  await composer.locator('[data-component="prompt-input"]').fill("Fresh message after dismiss")
  await composer.locator('[data-action="prompt-submit"]').last().click()

  await expect.poll(() => prompts.length).toBe(1)
  expect(prompts[0]).toMatchObject({
    sessionID: sourceID,
    body: { prompt: { text: "Fresh message after dismiss" } },
  })
  expectNoSmokeErrors(errors, [], [])
})

test("does not dismiss a click-triggered blocking form twice after its action commits", async ({ page }) => {
  const errors = trackPageErrors(page)
  const form = directFormQuestionRequest()
  const request = {
    ...form,
    id: "que_question_form_reject_reconcile",
    sessionID: sourceID,
    detached: false,
    questions: form.questions.map((question) => ({
      ...question,
      form: {
        ...question.form,
        layout: undefined,
        fields: [...question.form.fields, { id: "dismiss-now", type: "button", label: "Dismiss now" }],
        actions: [
          {
            id: "dismiss-now",
            trigger: { event: "click", source: "dismiss-now" },
            steps: [{ type: "dismiss" }],
          },
        ],
      },
    })),
  }
  const actions: unknown[] = []
  const rejects: string[] = []
  const prompts: unknown[] = []
  let pending = true
  let releaseAction!: () => void
  const actionGate = new Promise<void>((resolve) => {
    releaseAction = resolve
  })
  const events: unknown[] = [
    {
      directory,
      payload: { id: "evt_question_form_reject_reconcile", type: "surface.asked", properties: request },
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source")],
    pageMessages: () => ({ items: [] }),
    questions: () => (pending ? [request] : []),
    eventRetry: 10,
    events: () => events.splice(0),
    onAppFormAction: async (body) => {
      actions.push(body)
      pending = false
      events.push(
        {
          directory,
          payload: {
            id: "evt_question_form_reject_reconcile_rejected",
            type: "surface.dismissed",
            properties: { sessionID: sourceID, requestID: request.id },
          },
        },
        {
          directory,
          payload: {
            id: "evt_question_form_reject_reconcile_replayed_asked",
            type: "surface.asked",
            properties: request,
          },
        },
      )
      await actionGate
      return { ok: true, action: "dismiss" }
    },
    onQuestionReject: async (input) => {
      rejects.push(input.requestID)
      return { status: 503, body: { error: "Response lost after commit" } }
    },
    onSessionPrompt: (input) => {
      prompts.push(input)
      return { data: { sessionID: input.sessionID, messageID: "msg_after_form_dismiss", admittedSeq: 2 } }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const questionDock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock)
  await questionDock.getByRole("button", { name: "Dismiss now" }).click()

  await expect.poll(() => actions.length).toBe(1)
  await expect(questionDock).toHaveCount(0)
  expect(actions).toHaveLength(1)
  releaseAction()

  await expect(page.locator('[data-component="question-settlement-status"]')).toHaveCount(0)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  expect(actions).toHaveLength(1)
  expect(rejects).toEqual([])
  expect(prompts).toEqual([])
  expectNoSmokeErrors(errors, [], [])
})

test("retries a blocking form action only after the server confirms it did not start", async ({ page }) => {
  const errors = trackPageErrors(page)
  const form = directFormQuestionRequest()
  const request = {
    ...form,
    id: "que_question_form_safe_retry",
    sessionID: sourceID,
    detached: false,
    questions: form.questions.map((question) => ({
      ...question,
      form: {
        ...question.form,
        layout: undefined,
        fields: [...question.form.fields, { id: "dismiss-now", type: "button", label: "Dismiss now" }],
        actions: [
          {
            id: "dismiss-now",
            trigger: { event: "click", source: "dismiss-now" },
            steps: [{ type: "dismiss" }],
          },
        ],
      },
    })),
  }
  const actions: unknown[] = []
  const rejects: string[] = []
  let pending = true
  const events: unknown[] = [
    {
      directory,
      payload: { id: "evt_question_form_safe_retry", type: "surface.asked", properties: request },
    },
  ]

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source")],
    pageMessages: () => ({ items: [] }),
    questions: () => (pending ? [request] : []),
    eventRetry: 10,
    events: () => events.splice(0),
    onAppFormAction: (body) => {
      actions.push(body)
      if (actions.length === 1)
        return {
          status: 503,
          body: { error: "Host action was unavailable before execution", retry: "safe" },
        }
      pending = false
      events.push({
        directory,
        payload: {
          id: "evt_question_form_safe_retry_rejected",
          type: "surface.dismissed",
          properties: { sessionID: sourceID, requestID: request.id },
        },
      })
      return { ok: true, action: "dismiss" }
    },
    onQuestionReject: (input) => {
      rejects.push(input.requestID)
      return { status: "settled" }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const questionDock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock)
  await questionDock.getByRole("button", { name: "Dismiss now" }).click()

  await expect.poll(() => actions.length).toBe(1)
  const settlement = page.locator('[data-component="question-settlement-status"]')
  await expectAppVisible(settlement)
  await expect(settlement.getByRole("button", { name: "Retry" })).toBeVisible()
  await expect(page.locator('[data-component="session-composer"]')).toHaveCount(0)
  expect(rejects).toEqual([])

  await settlement.getByRole("button", { name: "Retry" }).click()
  await expect.poll(() => actions.length).toBe(2)
  await expect.poll(() => rejects.length).toBe(1)
  await expect(settlement).toHaveCount(0)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  expect(actions).toHaveLength(2)
  expect(rejects).toEqual([request.id])
  await page.screenshot({ path: screenshotPath("question-form-safe-retry.png"), fullPage: true })
  expectNoSmokeErrors(errors.filter((error) => !error.includes("503 (Service Unavailable)")), [], [])
})

test("shows one FIFO question per session, advances after settlement, and never reopens an answered request", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const first = questionRequest()
  const second = secondQuestionRequest()
  let requests = [first, second]
  let initialEventsSent = false
  let lateAnsweredEvent = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    sessionStatus: { [targetID]: { type: "busy" } },
    questions: () => requests,
    eventRetry: 10,
    onQuestionReply: (reply) => {
      replies.push(reply)
      requests = requests.filter((request) => request.id !== reply.requestID)
      if (reply.requestID === first.id) lateAnsweredEvent = true
      return true
    },
    onQuestionReject: (reply) => {
      requests = requests.filter((request) => request.id !== reply.requestID)
      return true
    },
    events: () => {
      if (!initialEventsSent) {
        initialEventsSent = true
        return [first, second].map((request, index) => ({
          directory,
          payload: {
            id: `evt_question_asked_${index}`,
            type: "surface.asked",
            properties: request,
          },
        }))
      }
      if (!lateAnsweredEvent) return []
      lateAnsweredEvent = false
      return [
        {
          directory,
          payload: {
            id: "evt_question_answered_late",
            type: "surface.asked",
            properties: first,
          },
        },
      ]
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const activeTab = page.locator(`[data-dock-tab][data-session-id="${targetID}"]`)
  const avatar = activeTab.locator('[data-component="project-avatar-v2"]')
  const questionDot = activeTab.locator('[data-slot="project-avatar-unread-dot"][data-status="question"]')
  const questionDock = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(avatar)
  await expectAppVisible(questionDot)
  await expectAppVisible(questionDock.getByText("1 of 2 pending questions"))
  await expectAppVisible(page.getByText("Answer this from the popup?"))
  await expect(questionDock.getByRole("button", { name: "Next" })).toHaveCount(0)
  await expect(page.getByText("Second pending question?")).toHaveCount(0)

  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replies).toEqual([{ requestID: first.id, body: { answers: [["Yes"]] } }])
  await expectAppVisible(questionDock.getByText("1 of 1 questions"))
  await expectAppVisible(page.getByText("Second pending question?"))
  await expect(page.getByText("Answer this from the popup?")).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-session-queue.png"), fullPage: true })

  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Now" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replies).toEqual([
    { requestID: first.id, body: { answers: [["Yes"]] } },
    { requestID: second.id, body: { answers: [["Now"]] } },
  ])
  await expect(questionDock).toHaveCount(0)
  await page.waitForTimeout(100)
  await expect(questionDock).toHaveCount(0)
  await expect(page.getByText("Answer this from the popup?")).toHaveCount(0)
  await expect(questionDot).toHaveCount(0)
  await expectAppVisible(avatar)
  await page.screenshot({ path: screenshotPath("question-session-completed-badge-cleared.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps an accepted question reply alive after its server event removes the dock", async ({ page }) => {
  const errors = trackPageErrors(page)
  const request = { ...questionRequest(), id: "que_question_reply_event_race", sessionID: sourceID }
  const replies: { requestID: string; body: unknown }[] = []
  const replyRequests: string[] = []
  const replyStatuses: number[] = []
  let accepted = false

  // Chromium reports a route-fulfilled 204 as net::ERR_ABORTED on Windows even when the request was not cancelled.
  // Track the actual fetch signal so this regression still fails if question-dock cleanup aborts an accepted reply.
  await page.addInitScript(
    ({ path }) => {
      const state = window as typeof window & { __questionReplySignals?: { seen: number; aborted: number } }
      state.__questionReplySignals = { seen: 0, aborted: 0 }
      const fetch = window.fetch
      window.fetch = Object.assign((input: URL | RequestInfo, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (!new URL(url, window.location.href).pathname.endsWith(path)) return fetch(input, init)
        state.__questionReplySignals!.seen += 1
        init?.signal?.addEventListener("abort", () => {
          state.__questionReplySignals!.aborted += 1
        })
        return fetch(input, init)
      }, { preconnect: fetch.preconnect })
    },
    { path: `/api/session/${sourceID}/surface/${request.id}/reply` },
  )

  page.on("request", (candidate) => {
    if (new URL(candidate.url()).pathname.endsWith(`/api/session/${sourceID}/surface/${request.id}/reply`)) {
      replyRequests.push(candidate.url())
    }
  })
  page.on("response", (candidate) => {
    if (new URL(candidate.url()).pathname.endsWith(`/api/session/${sourceID}/surface/${request.id}/reply`)) {
      replyStatuses.push(candidate.status())
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source")],
    pageMessages: () => ({ items: [] }),
    questions: () => [],
    eventRetry: 10,
    events: () => [
      {
        directory,
        payload: {
          id: accepted ? "evt_question_v2_reply_event_race" : "evt_question_v2_ask_event_race",
          type: accepted ? "surface.replied" : "surface.asked",
          properties: accepted ? { sessionID: sourceID, requestID: request.id } : request,
        },
      },
    ],
    onQuestionReply: async (input) => {
      replies.push(input)
      accepted = true
      await new Promise((resolve) => setTimeout(resolve, 100))
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const questionDock = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock.getByText("Answer this from the popup?"))

  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replies).toEqual([{ requestID: request.id, body: { answers: [["Yes"]] } }])
  await expect(questionDock).toHaveCount(0)
  await expect.poll(() => replyStatuses).toEqual([204])
  expect(replyRequests).toHaveLength(1)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __questionReplySignals?: { seen: number; aborted: number } })
            .__questionReplySignals,
      ),
    )
    .toEqual({ seen: 1, aborted: 0 })
  expectNoSmokeErrors(errors, [], [])
})

test("reconciles an ambiguous reply transport failure before deciding whether to retry", async ({ page }) => {
  const request = { ...questionRequest(), id: "que_question_transport_reconcile" }
  let requests = [request]
  let replyAttempts = 0

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => requests,
  })

  await page.route(
    (url) => /\/api\/session\/[^/]+\/surface\/[^/]+\/reply$/.test(url.pathname),
    async (route) => {
      replyAttempts++
      requests = []
      await route.abort("connectionreset")
    },
  )

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const questionDock = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock.getByText("Answer this from the popup?"))

  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect(questionDock).toHaveCount(0)
  expect(replyAttempts).toBe(1)
})

test("reconciles 404 and 410 replies before retrying or treating them as settled", async ({ page }) => {
  const errors = trackPageErrors(page)
  const first = { ...questionRequest(), id: "que_question_stale_404" }
  const second = { ...secondQuestionRequest(), id: "que_question_stale_410" }
  const replyAttempts: string[] = []
  const replyStatuses: number[] = []
  let requests = [first, second]
  let firstAttempts = 0

  page.on("response", (response) => {
    if (/\/api\/session\/[^/]+\/surface\/[^/]+\/reply$/.test(new URL(response.url()).pathname)) {
      replyStatuses.push(response.status())
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => requests,
    onQuestionReply: ({ requestID }) => {
      replyAttempts.push(requestID)
      if (requestID === first.id && firstAttempts++ === 0) {
        return { status: 404, body: { error: "Question request not found" } }
      }
      requests = requests.filter((request) => request.id !== requestID)
      if (requestID === first.id) return true
      return { status: 410, body: { error: "Question request is gone" } }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const questionDock = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock.getByText("1 of 2 pending questions"))
  await expectAppVisible(questionDock.getByText("Answer this from the popup?"))

  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replyAttempts).toEqual([first.id, first.id])
  await expectAppVisible(questionDock.getByText("Second pending question?"))

  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Now" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replyAttempts).toEqual([first.id, first.id, second.id])
  await expect.poll(() => replyStatuses).toEqual([404, 204, 410])
  await expect(questionDock).toHaveCount(0)
  const expectedTerminalErrors = errors.filter((error) =>
    /Failed to load resource: the server responded with a status of (404|410)/.test(error),
  )
  expect(expectedTerminalErrors).toHaveLength(2)
  expectNoSmokeErrors(
    errors.filter((error) => !expectedTerminalErrors.includes(error)),
    [],
    [],
  )
})

test("keeps a conflicting duplicate answer visible and does not retry it", async ({ page }) => {
  const errors = trackPageErrors(page)
  const request = { ...questionRequest(), id: "que_question_conflict", sessionID: targetID }
  let replyAttempts = 0

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [request],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_conflict",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onQuestionReply: () => {
      replyAttempts++
      return { status: 409, body: { error: "Question already answered differently" } }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const questionDock = page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(questionDock.getByText("Answer this from the popup?"))
  await questionDock.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await questionDock.getByRole("button", { name: "Submit" }).click()

  await expect.poll(() => replyAttempts).toBe(1)
  await expectAppVisible(questionDock.getByText("Question already answered differently"))
  await page.waitForTimeout(100)
  expect(replyAttempts).toBe(1)
  await expectAppVisible(questionDock)
  const expectedConflictErrors = errors.filter((error) =>
    /Failed to load resource: the server responded with a status of 409/.test(error),
  )
  expect(expectedConflictErrors).toHaveLength(1)
  expectNoSmokeErrors(
    errors.filter((error) => !expectedConflictErrors.includes(error)),
    [],
    [],
  )
})

test("renders a form question, docks it, and submits JSON values", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const request = formQuestionRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (replies.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const inlineForm = page.locator('[data-component="session-prompt-dock"] [data-slot="question-form"]')
  await expectAppVisible(inlineForm.getByText("Email Composer"))
  const inlineRecipientRow = inlineForm
    .locator('[data-slot="question-form-stack"][data-direction="horizontal"]')
    .first()
  await expect.poll(() => noHorizontalOverflow(inlineForm)).toBe(true)
  await expect
    .poll(async () => {
      const fields = inlineRecipientRow.locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
      const an = await fields.nth(0).boundingBox()
      const cc = await fields.nth(1).boundingBox()
      const bcc = await fields.nth(2).boundingBox()
      return (
        !!an &&
        !!cc &&
        !!bcc &&
        Math.abs(an.y - cc.y) < 12 &&
        Math.abs(cc.y - bcc.y) < 12 &&
        an.x < cc.x &&
        cc.x < bcc.x
      )
    })
    .toBe(true)
  await page.screenshot({ path: screenshotPath("question-form-gmail-wide-desktop.png"), fullPage: true })

  await page.getByRole("button", { name: "Surface nach unten einklappen" }).click()
  const collapsed = page.locator('[data-component="question-collapsed-bar"]')
  await expectAppVisible(collapsed)
  await expect(collapsed).toHaveText("")
  await expect(collapsed).toHaveAccessibleName(/1 of 1 questions/)
  await page.screenshot({ path: screenshotPath("question-form-collapsed-without-text.png"), fullPage: true })
  await page.getByRole("button", { name: "Surface aufklappen" }).click()
  await expectAppVisible(inlineForm.getByText("Email Composer"))

  await page.getByRole("button", { name: "Surface menu" }).click()
  await page.getByRole("menuitem", { name: "right" }).click()

  const docked = page.locator('[data-dock-area="right"] [data-component="dock-prompt"][data-kind="question"]')
  await expectAppVisible(docked.getByText("Email Composer"))
  await expect(
    page.locator(
      '[data-component="session-prompt-dock"] > div > div > [data-component="dock-prompt"][data-kind="question"]',
    ),
  ).toHaveCount(0)

  await expect.poll(() => noHorizontalOverflow(docked)).toBe(true)
  const subjectField = docked
    .locator('[data-slot="question-form-field"][data-field-type="text"]')
    .filter({ hasText: "Subject" })
  const bodyField = docked.locator('[data-slot="question-form-field"][data-field-type="rich_text"]')
  await expect(subjectField).toHaveAttribute("data-field-layout", "inline")
  await expect(bodyField).toHaveAttribute("data-field-layout", "stacked")
  await expect
    .poll(async () => {
      const label = await subjectField.locator('[data-slot="question-form-label"]').boundingBox()
      const input = await subjectField.locator('[data-slot="question-form-input"]').boundingBox()
      return !!label && !!input && label.y + label.height <= input.y && Math.abs(label.x - input.x) < 8
    })
    .toBe(true)
  await expect
    .poll(async () => {
      const body = await docked.locator('[data-slot="question-body"]').boundingBox()
      const footer = await docked.locator('[data-slot="question-footer"]').boundingBox()
      return !!body && !!footer && body.y + body.height <= footer.y - 4
    })
    .toBe(true)
  await expect(docked.getByRole("button", { name: "Approve draft" })).toBeDisabled()

  await docked
    .locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
    .filter({ hasText: "An" })
    .locator("input")
    .fill("recipient@example.test")
  await docked
    .locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
    .filter({ hasText: "An" })
    .locator("input")
    .press("Enter")
  await docked
    .locator('[data-slot="question-form-field"][data-field-type="text"]')
    .locator("input")
    .fill("Form renderer check")
  await expect(bodyField.locator('div[data-slot="question-form-input"][contenteditable="true"]')).toHaveCount(1)
  await bodyField.locator('div[data-slot="question-form-input"][contenteditable="true"]').evaluate((element) => {
    element.innerHTML = "<strong>Hello</strong> from the form."
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
  })
  await docked
    .locator('[data-slot="question-form-field"][data-field-type="file_picker"]')
    .locator('[data-slot="question-form-input"]')
    .fill("C:\\Users\\Example\\Pictures\\sample.png")
  await docked
    .locator('[data-slot="question-form-field"][data-field-type="file_picker"]')
    .getByRole("button", { name: "Add" })
    .click()
  await expect(docked.getByRole("button", { name: "Approve draft" })).toBeEnabled()

  await page.screenshot({ path: screenshotPath("question-form-docked-desktop.png"), fullPage: true })
  await docked.getByRole("button", { name: "Approve draft" }).click()

  await expect.poll(() => replies.length).toBe(1)
  await expect(docked).toHaveCount(0)
  const body = replies[0]?.body as { answers?: string[][] }
  const answer = JSON.parse(body.answers?.[0]?.[0] ?? "{}")
  expect(answer).toEqual({
    version: 1,
    type: "opencode.form.answer",
    formID: "email-composer.v1",
    values: {
      to: ["recipient@example.test"],
      cc: [],
      bcc: [],
      subject: "Form renderer check",
      body: "<strong>Hello</strong> from the form.",
      attachments: ["C:\\Users\\Example\\Pictures\\sample.png"],
      action: "send",
    },
  })
  expectNoSmokeErrors(errors, [], [])
})

test("renders a PU card tweaker form with numeric tier controls", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const actions: unknown[] = []
  const promptRequests: unknown[] = []
  const request = puCardTweakerRequest()
  const mediaRequests: string[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === "/app/media") mediaRequests.push(url.search)
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (actions.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_pu_card_tweaker_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
    onAppFormAction: (body) => {
      actions.push(body)
      return { ok: true, action: "command", result: { ok: true, stdout: "{\"ok\":true}", stderr: "", code: 0 } }
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.locator('[data-slot="question-form-title"]').filter({ hasText: "PU Card Tweaker" }))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(
    page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]'),
  ).toHaveCount(0)
  await expect(
    popup.locator('[data-slot="question-form-field"][data-field-type="select"]').first().locator("select"),
  ).toHaveValue("CardFreia")
  const cardArtImage = popup.locator('[data-slot="question-form-image"]')
  await expectAppVisible(cardArtImage)
  await expect(cardArtImage).toHaveAttribute("src", /^blob:/)
  await expect.poll(() => cardArtImage.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  await expect.poll(() => noHorizontalOverflow(popup)).toBe(true)
  await expect.poll(() => noHorizontalStackOverlap(popup)).toBe(true)
  await popup.evaluate((element) => element.setAttribute("data-flicker-probe", "stable"))
  const initialCardArtSrc = await cardArtImage.getAttribute("src")
  const mediaRequestCount = mediaRequests.length

  const scoreField = popup
    .locator('[data-slot="question-form-field"][data-field-type="number"]')
    .filter({ hasText: "Score" })
  await expect(scoreField).toHaveAttribute("data-field-layout", "inline")
  await expect.poll(() => labelLeftAndCentered(scoreField)).toBe(true)
  await expect(scoreField).toHaveAttribute("title", "Target score after upgrade.")
  await expect(scoreField.locator("input")).toHaveAttribute("type", "number")
  await scoreField.locator("input").fill("11")
  const updatePreviewButton = popup
    .locator('[data-slot="question-form-field"][data-field-type="button"]')
    .filter({ hasText: "Update preview" })
    .locator('[data-slot="question-form-button"]')
  await expect(updatePreviewButton).toBeVisible()
  await expect.poll(() => buttonLooksClickable(updatePreviewButton)).toBe(true)
  const costRange = popup
    .locator('[data-slot="question-form-field"][data-field-type="number_range"]')
    .filter({ hasText: "Cost range" })
  await expect(costRange.locator('input[type="number"]')).toHaveCount(2)
  await expect(costRange.locator('input[type="range"]')).toHaveCount(2)
  await expectAppVisible(
    popup
      .locator('[data-slot="question-form-field"][data-field-type="file_picker"]')
      .filter({ hasText: "Art override" })
      .getByRole("button", { name: "Browse" }),
  )
  await expectAppVisible(
    popup
      .locator('[data-slot="question-form-field"][data-field-type="folder_picker"]')
      .filter({ hasText: "Asset folder" })
      .getByRole("button", { name: "Browse" }),
  )
  const effectInput = popup
    .locator('[data-slot="question-form-field"][data-field-type="text"]')
    .filter({ hasText: "Effect" })
    .locator("input")
  await effectInput.press("End")
  await effectInput.pressSequentially("Upgraded", { delay: 10 })
  await expect(popup).toHaveAttribute("data-flicker-probe", "stable")
  await expect(cardArtImage).toHaveAttribute("src", initialCardArtSrc ?? "")
  await expect.poll(() => mediaRequests.length).toBe(mediaRequestCount)
  const previewToggle = popup
    .locator('[data-slot="question-form-field"][data-field-type="checkbox"]')
    .filter({ hasText: "Render preview after change" })
    .locator('input[type="checkbox"]')
  await previewToggle.click()
  await expect(previewToggle).not.toBeChecked()
  await expect(popup).toHaveAttribute("data-flicker-probe", "stable")
  await expect(cardArtImage).toHaveAttribute("src", initialCardArtSrc ?? "")
  await expect.poll(() => mediaRequests.length).toBe(mediaRequestCount)
  await scrollQuestionBodyToTop(popup)
  await page.screenshot({ path: screenshotPath("question-form-pu-card-tweaker-desktop.png"), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await effectInput.evaluate((element) => element.scrollIntoView({ block: "center" }))
  await effectInput.press("End")
  await effectInput.pressSequentially("Mobile", { delay: 10 })
  await expect(popup).toHaveAttribute("data-flicker-probe", "stable")
  await expect(cardArtImage).toHaveAttribute("src", initialCardArtSrc ?? "")
  await expect.poll(() => mediaRequests.length).toBe(mediaRequestCount)
  await page.screenshot({ path: screenshotPath("question-form-pu-card-tweaker-mobile.png"), fullPage: true })

  await popup.getByRole("button", { name: "Run action" }).click()

  await expect.poll(() => actions.length).toBe(1)
  await expect(popup).toHaveCount(0)
  expect(replies).toHaveLength(0)
  expect(promptRequests).toHaveLength(0)
  const action = actions[0] as { action?: { id?: string; source?: string }; values?: Record<string, unknown> }
  expect(action.action).toEqual({ id: "preview" })
  expect(action.values).toMatchObject({
    card: "CardFreia",
    tier: "base",
    cost: 5,
    score: 11,
    effect: "EffectFreiaUpgradedMobile",
    render_preview: false,
    output: "preview",
    target_cost_range: { start: 4, end: 6 },
  })
  expectNoSmokeErrors(errors, [], [])
})

test("renders a VidMD cut preview form with media preview and cut controls", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const actions: unknown[] = []
  const promptRequests: unknown[] = []
  const request = vidmdCutPreviewRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (actions.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_vidmd_cut_preview_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
    onAppFormAction: (body) => {
      actions.push(body)
      return { ok: true, action: "command", result: { ok: true, stdout: "{\"ok\":true}", stderr: "", code: 0 } }
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      Object.assign(window, {
        __OPENCODE_TEST_PLATFORM__: {
          platform: "desktop",
          os: "windows",
          openLink: () => undefined,
          openDirectoryPickerDialog: async () => null,
          back: () => undefined,
          forward: () => undefined,
          restart: async () => undefined,
          notify: async () => undefined,
          webviewZoom: () => 1,
        },
      })
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.locator('[data-slot="question-form-title"]').filter({ hasText: "VidMD Cut Preview" }))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(
    page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]'),
  ).toHaveCount(0)
  await expectAppVisible(popup.locator('[data-slot="question-form-video"]'))
  const preview = popup.locator('[data-slot="question-form-video"]')
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(0)
  await preview.evaluate((video: HTMLVideoElement) => video.play())
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0)
  const fullscreenButton = popup.getByRole("button", { name: "Vollbild öffnen" })
  await expectAppVisible(fullscreenButton)
  await fullscreenButton.click()
  const fullscreenDialog = page.getByRole("dialog", { name: "Video im Vollbild" })
  await expectAppVisible(fullscreenDialog)
  await expect.poll(() => fullscreenDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true)
  await expect(page.locator("#root")).toHaveJSProperty("inert", true)
  const fullscreenPlayer = fullscreenDialog.locator('[data-slot="question-video-fullscreen-player"]')
  await expectAppVisible(fullscreenPlayer)
  await expect.poll(() => fullscreenPlayer.evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(0)
  const fullscreenClose = fullscreenDialog.getByRole("button", { name: "Vollbild schließen" })
  await expect
    .poll(() =>
      fullscreenClose.evaluate((button) => window.innerWidth - button.getBoundingClientRect().right >= 154),
    )
    .toBe(true)

  const installForeignQuestion = () =>
    page.evaluate(() => {
      const region = document.createElement("div")
      region.dataset.component = "question-popup-region"
      region.dataset.surface = "on-demand-popup-region"
      Object.assign(region.style, {
        position: "fixed",
        zIndex: "1001",
        top: "24px",
        right: "24px",
        bottom: "24px",
        width: "min(820px, calc(100vw - 48px))",
        pointerEvents: "none",
      })
      const popup = document.createElement("section")
      popup.dataset.component = "qa-foreign-question"
      popup.dataset.surface = "on-demand-popup"
      const control = document.createElement("button")
      control.type = "button"
      control.textContent = "Focus competing question"
      popup.append(control)
      Object.assign(popup.style, {
        position: "absolute",
        inset: "0",
        pointerEvents: "auto",
        background: "var(--background-base)",
      })
      region.append(popup)
      document.body.append(region)
      document.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Escape" || event.defaultPrevented || !region.contains(document.activeElement)) return
          event.preventDefault()
          document.documentElement.dataset.qaForeignEscapeCount = String(
            Number(document.documentElement.dataset.qaForeignEscapeCount ?? "0") + 1,
          )
          region.remove()
        },
        { once: true },
      )
    })

  const foreignQuestion = page.locator('[data-component="qa-foreign-question"]')
  await fullscreenClose.focus()
  await page.keyboard.press("Shift+Tab")
  await expect.poll(() => fullscreenDialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true)
  await fullscreenPlayer.focus()
  await page.keyboard.press("Tab")
  await expect.poll(() => fullscreenClose.evaluate((button) => document.activeElement === button)).toBe(true)
  await installForeignQuestion()
  await expectAppVisible(foreignQuestion)
  await expect.poll(() =>
    fullscreenClose.evaluate((button) => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit === button || button.contains(hit)
    }),
  ).toBe(true)
  await page.screenshot({ path: screenshotPath("question-form-video-fullscreen.png") })
  await fullscreenClose.click()
  await expect(fullscreenDialog).toHaveCount(0)
  await expect(page.locator("#root")).toHaveJSProperty("inert", false)
  await expectAppVisible(popup)
  await expectAppVisible(foreignQuestion)
  await expect.poll(() => fullscreenButton.evaluate((button) => document.activeElement === button)).toBe(true)
  await foreignQuestion.evaluate((element) => element.parentElement?.remove())

  await fullscreenButton.click()
  await expectAppVisible(fullscreenDialog)
  await installForeignQuestion()
  await foreignQuestion.getByRole("button", { name: "Focus competing question" }).focus()
  await page.keyboard.press("Escape")
  await expect(fullscreenDialog).toHaveCount(1)
  await expect(foreignQuestion).toHaveCount(0)
  await expect(page.locator("html")).toHaveAttribute("data-qa-foreign-escape-count", "1")
  await expectAppVisible(popup)

  await fullscreenButton.focus()
  await page.keyboard.press("Escape")
  await expect(fullscreenDialog).toHaveCount(0)
  await expect(page.locator("#root")).toHaveJSProperty("inert", false)
  await expectAppVisible(popup)
  await expect.poll(() => fullscreenButton.evaluate((button) => document.activeElement === button)).toBe(true)
  await expect.poll(() => noHorizontalOverflow(popup)).toBe(true)

  const cutRange = popup
    .locator('[data-slot="question-form-field"][data-field-type="duration_range"]')
    .filter({ hasText: "Cut range" })
  const cutInputs = cutRange.locator('input[type="number"]')
  await expect(cutInputs).toHaveCount(2)
  await setVideoCurrentTime(popup, "13.25")
  await popup.getByRole("button", { name: "Start hier" }).click()
  await expect(cutInputs.nth(0)).toHaveValue("13.25")
  await setVideoCurrentTime(popup, "19.75")
  await popup.getByRole("button", { name: "Ende hier" }).click()
  await expect(cutInputs.nth(1)).toHaveValue("19.75")
  await expectAppVisible(
    popup
      .locator('[data-slot="question-form-field"][data-field-type="file_picker"]')
      .filter({ hasText: "Source file" })
      .getByRole("button", { name: "Browse" }),
  )
  await expectAppVisible(
    popup
      .locator('[data-slot="question-form-field"][data-field-type="folder_picker"]')
      .filter({ hasText: "Project folder" })
      .getByRole("button", { name: "Browse" }),
  )
  await popup
    .locator('[data-slot="question-form-field"][data-field-type="textarea"]')
    .locator("textarea")
    .fill("Keep this sharper revised sentence and cut the hesitation.")
  await scrollQuestionBodyToTop(popup)
  await page.screenshot({ path: screenshotPath("question-form-vidmd-cut-preview-desktop.png"), fullPage: true })
  await popup.getByRole("button", { name: "Run action" }).click()

  await expect.poll(() => actions.length).toBe(1)
  await expect(popup).toHaveCount(0)
  expect(replies).toHaveLength(0)
  expect(promptRequests).toHaveLength(0)
  const action = actions[0] as { action?: { id?: string; source?: string }; values?: Record<string, unknown> }
  expect(action.action).toEqual({ id: "preview" })
  expect(action.values).toMatchObject({
    project_id: "will-glow-review",
    cut_range: { start: 13.25, end: 19.75 },
    transcript: "Keep this sharper revised sentence and cut the hesitation.",
    transition: "crossfade",
    action: "preview",
    render: true,
  })
  expectNoSmokeErrors(errors, [], [])
})

test("runs a detached direct Gmail form action without starting an agent turn", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const rejects: string[] = []
  const actions: unknown[] = []
  const promptRequests: unknown[] = []
  const request = directFormQuestionRequest()
  let releaseAction!: () => void
  const actionGate = new Promise<void>((resolve) => {
    releaseAction = resolve
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (actions.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_direct_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onAppFormAction: async (body) => {
      actions.push(body)
      await actionGate
      return { ok: true, action: "send", gmail: { messageID: "msg_direct" } }
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
    onQuestionReject: (input) => {
      rejects.push(input.requestID)
      return true
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Email Composer"))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(
    page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]'),
  ).toHaveCount(0)
  const toField = popup
    .locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
    .filter({ hasText: "An" })
  await toField.locator("input").fill("recipient@example.test")
  await toField.locator("input").press("Enter")
  await expect(toField.locator('[data-slot="question-form-chip"]')).toContainText("recipient@example.test")

  const bodyField = popup.locator('[data-slot="question-form-field"][data-field-type="rich_text"]')
  await popup
    .locator('[data-slot="question-form-field"][data-field-type="text"]')
    .locator("input")
    .fill("Direct form action")
  await fillRichTextPlain(page, bodyField, "Direct body.")

  await expect(popup.getByRole("button", { name: "Run action" })).toBeEnabled()
  await scrollQuestionBodyToTop(popup)
  await page.screenshot({ path: screenshotPath("question-form-gmail-detached-desktop.png"), fullPage: true })
  await popup.getByRole("button", { name: "Run action" }).click()

  await expect.poll(() => actions.length).toBe(1)
  await expectAppVisible(page.locator('[data-component="session-composer"]'))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  releaseAction()
  await expect(popup).toHaveCount(0)
  const receipt = page.locator('[data-component="toast"], [data-component="toast-v2"]').filter({ hasText: "Email sent" })
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText("ID: msg_direct")
  expect(replies).toHaveLength(0)
  expect(rejects).toEqual([])
  expect(promptRequests).toHaveLength(0)
  const action = actions[0] as {
    requestID?: string
    formID?: string
    action?: { id?: string; source?: string }
    values?: Record<string, unknown>
  }
  expect(action.requestID).toBe("que_question_form_direct")
  expect(action.formID).toBe("email-composer.v1")
  expect(action.action).toEqual({ id: "send" })
  expect(action.values?.to).toEqual(["recipient@example.test"])
  expect(action.values?.body).toBe("Direct body.")
  expectNoSmokeErrors(errors, [], [])
})

test("runs a direct Gmail draft form action without starting an agent turn", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const actions: unknown[] = []
  const promptRequests: unknown[] = []
  const request = directFormQuestionRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (actions.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_direct_draft_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onAppFormAction: (body) => {
      actions.push(body)
      return { ok: true, action: "draft", gmail: { draftID: "draft_direct" } }
    },
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Email Composer"))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(
    page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]'),
  ).toHaveCount(0)
  const toField = popup
    .locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
    .filter({ hasText: "An" })
  await toField.locator("input").fill("recipient@example.test")
  await toField.locator("input").press("Enter")
  await popup
    .locator('[data-slot="question-form-field"][data-field-type="text"]')
    .locator("input")
    .fill("Draft form action")
  await popup
    .locator('[data-slot="question-form-field"][data-field-type="rich_text"]')
    .evaluate((element) => element.scrollIntoView({ block: "center" }))
  await fillRichTextPlain(
    page,
    popup.locator('[data-slot="question-form-field"][data-field-type="rich_text"]'),
    "Save this as a draft.",
  )
  await popup
    .locator('[data-slot="question-form-field"][data-field-type="select"]')
    .filter({ hasText: "Action" })
    .locator("select")
    .selectOption("draft")

  await expect(popup.getByRole("button", { name: "Run action" })).toBeEnabled()
  await popup.getByRole("button", { name: "Run action" }).click()

  await expect.poll(() => actions.length).toBe(1)
  await expect(popup).toHaveCount(0)
  expect(replies).toHaveLength(0)
  expect(promptRequests).toHaveLength(0)
  const receipt = page.locator('[data-component="toast"], [data-component="toast-v2"]').filter({ hasText: "Gmail draft created" })
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText("Entwurf: draft_direct")
  const action = actions[0] as { action?: { id?: string; source?: string }; values?: Record<string, unknown> }
  expect(action.action).toEqual({ id: "draft" })
  expect(action.values?.to).toEqual(["recipient@example.test"])
  expect(action.values?.subject).toBe("Draft form action")
  expectNoSmokeErrors(errors, [], [])
})

test("runs a direct dismiss form action without requiring email fields", async ({ page }) => {
  const errors = trackPageErrors(page)
  const actions: unknown[] = []
  const promptRequests: unknown[] = []
  const request = directFormQuestionRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (actions.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_direct_dismiss_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onAppFormAction: (body) => {
      actions.push(body)
      return { ok: true, action: "dismiss" }
    },
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Email Composer"))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await expect(
    page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]'),
  ).toHaveCount(0)
  await popup
    .locator('[data-slot="question-form-field"][data-field-type="select"]')
    .filter({ hasText: "Action" })
    .locator("select")
    .selectOption("cancel")
  await expect(popup.getByRole("button", { name: "Run action" })).toBeEnabled()
  await popup.getByRole("button", { name: "Run action" }).click()

  await expect.poll(() => actions.length).toBe(1)
  await expect(popup).toHaveCount(0)
  const action = actions[0] as { action?: { id?: string; source?: string } }
  expect(action.action).toEqual({ id: "cancel" })
  expect(promptRequests).toHaveLength(0)
  expectNoSmokeErrors(errors, [], [])
})

test("dismisses a detached form popup completely while keeping the composer visible", async ({ page }) => {
  const errors = trackPageErrors(page)
  const promptRequests: unknown[] = []
  const request = directFormQuestionRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [request],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_direct_local_dismiss_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onSessionPrompt: (input) => {
      promptRequests.push(input)
      return {}
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Email Composer"))
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  await popup.getByRole("button", { name: "Dismiss" }).click()

  await expect(popup).toHaveCount(0)
  await expect(
    page.locator('[data-component="session-prompt-dock"] [data-component="dock-prompt"][data-kind="question"]'),
  ).toHaveCount(0)
  await expectAppVisible(page.locator('[data-component="prompt-input"]'))
  expect(promptRequests).toHaveLength(0)
  expectNoSmokeErrors(errors, [], [])
})

test("renders a form question on mobile", async ({ page }) => {
  const errors = trackPageErrors(page)
  const replies: { requestID: string; body: unknown }[] = []
  const request = formQuestionRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (replies.length ? [] : [request]),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_form_mobile_asked",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const form = page.locator('[data-slot="question-form"]')
  await expectAppVisible(form.getByText("Email Composer"))
  await expectAppVisible(form.locator('[data-slot="question-form-field"][data-field-type="rich_text"]'))
  await expect.poll(() => noHorizontalOverflow(form)).toBe(true)
  const subjectField = form
    .locator('[data-slot="question-form-field"][data-field-type="text"]')
    .filter({ hasText: "Subject" })
  await expect
    .poll(async () => {
      const label = await subjectField.locator('[data-slot="question-form-label"]').boundingBox()
      const input = await subjectField.locator('[data-slot="question-form-input"]').boundingBox()
      return !!label && !!input && label.y < input.y && Math.abs(label.x - input.x) < 8
    })
    .toBe(true)
  await expect
    .poll(async () => {
      const body = await page.locator('[data-slot="question-body"]').boundingBox()
      const footer = await page.locator('[data-slot="question-footer"]').boundingBox()
      return !!body && !!footer && body.y + body.height <= footer.y - 4
    })
    .toBe(true)
  await form
    .locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
    .filter({ hasText: "An" })
    .locator("input")
    .fill("recipient@example.test")
  await form
    .locator('[data-slot="question-form-field"][data-field-type="recipient_list"]')
    .filter({ hasText: "An" })
    .locator("input")
    .press("Enter")
  await subjectField.locator("input").fill("Mobile form check")
  await form
    .locator('[data-slot="question-form-field"][data-field-type="rich_text"]')
    .locator('div[data-slot="question-form-input"][contenteditable="true"]')
    .evaluate((element) => {
      element.innerHTML = "Mobile body spacing check."
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    })
  await expect(page.getByRole("button", { name: "Approve draft" })).toBeEnabled()
  await page.screenshot({ path: screenshotPath("question-form-mobile.png"), fullPage: true })
  await page.getByRole("button", { name: "Approve draft" }).click()

  await expect.poll(() => replies.length).toBe(1)
  await expect(form).toHaveCount(0)
  const body = replies[0]?.body as { answers?: string[][] }
  const answer = JSON.parse(body.answers?.[0]?.[0] ?? "{}")
  expect(answer.values).toMatchObject({
    to: ["recipient@example.test"],
    subject: "Mobile form check",
    body: "Mobile body spacing check.",
  })
  expectNoSmokeErrors(errors, [], [])
})

test("keeps overflowing popup controls scrollable with the mouse wheel", async ({ page }) => {
  const errors = trackPageErrors(page)
  const request = overflowingQuestionRequest()

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [request],
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked_overflow",
          type: "surface.asked",
          properties: request,
        },
      },
    ],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 390, height: 420 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="question-popup"]')
  const options = popup.locator('[data-slot="question-options"]')
  const content = popup.locator('[data-slot="question-content"]')
  await expectAppVisible(popup)
  await expectAppVisible(options)
  await expect.poll(() => content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await expect
    .poll(() => content.evaluate((el) => getComputedStyle(el).getPropertyValue("scrollbar-width")))
    .not.toBe("none")

  await content.evaluate((el) => {
    el.scrollTop = 0
  })
  const box = await content.boundingBox()
  if (!box) throw new Error("Expected question options to have a bounding box")
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(48, box.height / 2))
  await page.mouse.wheel(0, 500)

  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.screenshot({ path: screenshotPath("question-popup-overflow-scroll.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("hides stale out-of-session question popups after pending list recovery", async ({ page }) => {
  const errors = trackPageErrors(page)
  let eventSent = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => [],
    events: () => {
      if (eventSent) return []
      eventSent = true
      return [
        {
          directory,
          payload: {
            id: "evt_question_asked",
            type: "surface.asked",
            properties: questionRequest(),
          },
        },
      ]
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await page.waitForTimeout(500)
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("recovers an on-demand question from the V2 pending list after returning to a visible tab", async ({ page }) => {
  const errors = trackPageErrors(page)
  const request = {
    ...questionRequest(),
    id: "que_question_on_demand_visibility_recovery",
    detached: true,
    questions: [
      {
        type: "show_options",
        question: "Recovered on-demand question?",
        header: "Recovery check",
        options: [{ label: "Recovered", description: "The V2 pending list restored this question" }],
      },
    ],
  }
  let pending = false

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (pending ? [request] : []),
    events: () => [],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)

  pending = true
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))

  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Recovered on-demand question?"))
  await expectAppVisible(popup.locator('[data-slot="question-option"]').filter({ hasText: "Recovered" }))
  expectNoSmokeErrors(errors, [], [])
})

test("restores a persistently viewed pending popup while respecting transient closure and settlement", async ({
  page,
}) => {
  const errors = trackPageErrors(page)
  const request = {
    ...questionRequest(),
    id: "que_question_viewed_pending_recovery",
    detached: true,
    questions: [
      {
        type: "show_options",
        question: "Recover the still-pending popup?",
        header: "Pending recovery",
        options: [{ label: "Recovered", description: "The authoritative pending request remains active" }],
      },
    ],
  }
  let pending = true

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "cursor",
          name: "Cursor",
          models: {
            "gpt-5.6-sol": { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["cursor"],
      default: { providerID: "cursor", modelID: "gpt-5.6-sol" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (pending ? [request] : []),
    events: () => [],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID, targetID, requestID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:layout.page",
        JSON.stringify({
          viewedQuestionPopups: {
            [`${directory.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase()}:${targetID}:${requestID}`]: true,
          },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    {
      directory,
      dirBase64: base64Encode(directory),
      sourceID,
      targetID,
      requestID: request.id,
    },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup.getByText("Recover the still-pending popup?"))

  await popup.getByRole("button", { name: "Minimize" }).click()
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(popup).toHaveCount(0)

  await page.reload()
  await expectAppVisible(popup.getByText("Recover the still-pending popup?"))

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await expectAppVisible(popup.getByText("Recover the still-pending popup?"))

  await popup.getByRole("button", { name: "Dismiss" }).click()
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(popup).toHaveCount(0)

  pending = false
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))
  await expect(popup).toHaveCount(0)
  await page.reload()
  await expect(popup).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("does not show optional implementation-complete follow-up questions as popups", async ({ page }) => {
  const errors = trackPageErrors(page)

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    events: () => [
      {
        directory,
        payload: {
          id: "evt_question_asked",
          type: "surface.asked",
          properties: {
            id: requestID,
            sessionID: targetID,
            phase: "implementation_complete_followup",
            questions: [
              {
                question: "Anything else before I stop?",
                header: "Done",
                options: [{ label: "No", description: "No follow-up needed" }],
              },
            ],
          },
        },
      },
    ],
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)
  await expectAppVisible(page.getByRole("heading", { name: "Question source" }))
  await page.waitForTimeout(500)
  await expect(page.locator('[data-component="question-popup"]')).toHaveCount(0)
  await expect(page.getByText("Implementation complete")).toHaveCount(0)
  expectNoSmokeErrors(errors, [], [])
})

test("surfaces a nested child session control panel as a popup and docks it only on request", async ({ page }) => {
  const errors = trackPageErrors(page)
  const childID = "ses_control_panel_child"
  const childMessageID = "msg_control_panel_child"
  const childControlID = "child-control-panel"
  const livePublishes: { directory: string; body: unknown }[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question parent"), session(childID, "Question child", sourceID)],
    pageMessages: () => ({ items: [] }),
    eventDelay: 250,
    events: () => [
      {
        directory,
        payload: {
          id: "evt_child_control_panel_message",
          type: "message.updated",
          properties: {
            info: {
              id: childMessageID,
              sessionID: childID,
              role: "assistant",
              time: { created: 1700000001000, completed: 1700000002000 },
            },
          },
        },
      },
      {
        directory,
        payload: {
          id: "evt_child_control_panel_part",
          type: "message.part.updated",
          properties: {
            part: {
              id: "prt_child_control_panel",
              sessionID: childID,
              messageID: childMessageID,
              type: "custom",
              kind: "opencode/control-panel",
              title: "Child Control Panel",
              data: {
                version: 1,
                controlID: childControlID,
                title: "Child Control Panel",
                controls: [{ id: "enabled", type: "toggle", label: "Enabled", value: true }],
                actions: [
                  {
                    id: "publish_enabled",
                    trigger: { event: "change", source: "enabled" },
                    steps: [{ type: "livePublish", topic: "child.bridge", debounceMs: 0 }],
                  },
                ],
              },
            },
          },
        },
      },
    ],
    onControlLivePublish: (input) => {
      livePublishes.push(input)
      return { ok: true }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`)

  const popup = page.locator('[data-component="control-panel-popup"]')
  await expectAppVisible(popup)
  await expect(popup.getByText("Erwartet: Enabled")).toBeVisible()
  await expect(page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Child Control Panel" })).toHaveCount(0)

  const enabledToggle = popup
    .locator('[data-slot="control-panel-row"][data-control-type="toggle"]')
    .locator('[data-slot="control-panel-toggle"]')
  await expect(enabledToggle).toHaveAttribute("data-on", "true")
  await enabledToggle.click()

  await expect.poll(() => livePublishes.at(-1)?.body).toMatchObject({
    controlID: childControlID,
    control: "enabled",
    bridge: "session",
    topic: "child.bridge",
    value: false,
  })
  await popup.getByRole("button", { name: "In Session-Dock" }).click()
  await expect(popup).toHaveCount(0)
  const childTab = page.locator('[data-dock-area="middle"]').getByRole("tab", { name: "Child Control Panel" })
  await expectAppVisible(childTab)
  await childTab.click()
  await expectAppVisible(page.locator('[data-component="control-panel-dock-pane"][data-control-id="child-control-panel"]'))
  await page.screenshot({ path: screenshotPath("question-popup-child-control-panel.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})

test("pins an interactive Surface as a project tool and restores it after reload", async ({ page }) => {
  const errors = trackPageErrors(page)
  const pins: unknown[] = []
  const stateUpdates: unknown[] = []
  const visibilityUpdates: unknown[] = []
  const removals: string[] = []
  let pending = true
  let pinned = false
  let removed = false
  const surface = {
    version: 1 as const,
    controlID: "persistent-surface",
    title: "Persistent Surface",
    controls: [{ id: "enabled", type: "toggle", label: "Enabled" }],
    values: { enabled: true },
  }
  const request = {
    id: "que_persistent_surface",
    sessionID: targetID,
    mode: "interactive" as const,
    revision: 1,
    actions: [],
    surface,
  }
  let tool = {
    id: "sft_persistent_surface",
    scope: "project" as const,
    projectID,
    directory,
    origin: { requestID: request.id, sessionID: targetID, revision: 1 },
    mode: "interactive" as const,
    revision: 1,
    actions: [],
    surface,
    state: { version: 1 as const, revision: 1, values: { enabled: true } as Record<string, unknown> },
    hidden: false,
    time: { created: 1700000000000, updated: 1700000000000 },
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (pending ? [request] : []),
    surfaceTools: () => (pinned && !removed ? [tool] : []),
    events: () =>
      pending
        ? [{ directory, payload: { id: "evt_persistent_surface", type: "surface.asked", properties: request } }]
        : [],
    onSurfacePin: ({ body }) => {
      pins.push(body)
      pinned = true
      return tool
    },
    onQuestionReject: () => {
      pending = false
      return true
    },
    onSurfaceToolState: ({ body }) => {
      stateUpdates.push(body)
      const input = body as { values: Record<string, unknown> }
      tool = { ...tool, state: { ...tool.state, revision: tool.state.revision + 1, values: input.values } }
      return tool
    },
    onSurfaceToolVisibility: ({ body }) => {
      visibilityUpdates.push(body)
      const input = body as { hidden: boolean }
      tool = { ...tool, hidden: input.hidden }
      return tool
    },
    onSurfaceToolRemove: ({ toolID }) => {
      removals.push(toolID)
      removed = true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const popup = page.locator('[data-component="control-panel-popup"]')
  await expectAppVisible(popup.getByText("Persistent Surface"))
  await expect(popup.getByRole("button", { name: "App-weit anheften" })).toHaveCount(0)
  await popup.getByRole("button", { name: "Als Projektwerkzeug anheften" }).click()
  await expect(popup).toHaveCount(0)
  const pinnedTab = page.getByRole("tab", { name: "Persistent Surface" })
  await expectAppVisible(pinnedTab)
  await pinnedTab.click()
  await expectAppVisible(page.locator('[data-component="control-panel-dock-pane"][data-control-id="persistent-surface"]'))
  expect(pins).toEqual([{ scope: "project", expectedRevision: 1 }])

  await page.reload()
  const restored = page.getByRole("tab", { name: "Persistent Surface" })
  await expectAppVisible(restored)
  await restored.click()
  const toolPane = page.locator('[data-component="control-panel-dock-pane"][data-control-id="persistent-surface"]')
  await expectAppVisible(toolPane)
  await page.screenshot({ path: screenshotPath("surface-tool-restored-desktop.png"), fullPage: true })

  await toolPane.getByRole("button", { name: "Enabled" }).click()
  await expect.poll(() => stateUpdates.length).toBe(1)
  expect(stateUpdates).toEqual([{ expectedRevision: 1, values: { enabled: false } }])
  await restored.click()
  await expectAppVisible(toolPane)

  await toolPane.getByRole("button", { name: "Ausblenden" }).click()
  await expect(toolPane).toHaveCount(0)
  await expect.poll(() => visibilityUpdates.length).toBe(1)
  expect(visibilityUpdates[0]).toEqual({ hidden: true })

  await page.getByRole("button", { name: "Add dock item to middle" }).click()
  const addMenu = page.locator('[data-component="dock-add-menu"]')
  await addMenu.getByRole("button", { name: /Persistent Surface/ }).click()
  await expect.poll(() => visibilityUpdates.length).toBe(2)
  expect(visibilityUpdates[1]).toEqual({ hidden: false })
  await restored.click()
  await expectAppVisible(toolPane)

  await toolPane.getByRole("button", { name: "Entfernen" }).click()
  await expect(toolPane).toHaveCount(0)
  await expect.poll(() => removals).toEqual(["sft_persistent_surface"])
  expectNoSmokeErrors(errors, [], [])
})

test("runs a persistent Surface tool form action against the tool revision", async ({ page }) => {
  const errors = trackPageErrors(page)
  const actions: unknown[] = []
  const formAction = {
    id: "run",
    trigger: { event: "submit" as const },
    steps: [{ type: "command" as const, command: "echo", arguments: ["persistent"] }],
  }
  const tool = {
    id: "sft_persistent_action",
    scope: "project" as const,
    projectID,
    directory,
    origin: { requestID: "que_persistent_action", sessionID: targetID, revision: 4 },
    mode: "interactive" as const,
    revision: 4,
    actions: [formAction],
    surface: {
      version: 1 as const,
      controlID: "persistent-action",
      title: "Persistent Action",
      controls: [
        {
          id: "runner",
          type: "form",
          label: "Run persistent action",
          form: {
            version: 1 as const,
            id: "persistent-action.v1",
            submitLabel: "Run action",
            actions: [formAction],
            fields: [{ id: "message", type: "text", label: "Message" }],
          },
        },
      ],
    },
    state: { version: 1 as const, revision: 2, values: { message: "Saved value" } },
    hidden: false,
    time: { created: 1700000000000, updated: 1700000000000 },
  }

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    surfaceTools: () => [tool],
    onAppFormAction: (body) => {
      actions.push(body)
      return { ok: true, result: {} }
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, targetID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: targetID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), targetID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${targetID}`)
  const toolTab = page.getByRole("tab", { name: "Persistent Action" })
  await expectAppVisible(toolTab)
  await toolTab.click()
  const toolPane = page.locator('[data-component="control-panel-dock-pane"][data-control-id="persistent-action"]')
  await expectAppVisible(toolPane)
  await expect(
    toolPane.locator('[data-slot="question-form-field"][data-field-type="text"]').getByRole("textbox"),
  ).toHaveValue("Saved value")
  await toolPane.getByRole("button", { name: "Run action" }).click()
  await expect.poll(() => actions.length).toBe(1)
  expect(actions[0]).toMatchObject({
    requestID: "que_surface_tool_sft_persistent_action",
    revision: 4,
    target: { kind: "tool", id: "sft_persistent_action", revision: 4 },
    directory,
    formID: "persistent-action.v1",
    values: { message: "Saved value" },
    action: { id: "run" },
  })
  expect((actions[0] as { invocationID?: unknown }).invocationID).toEqual(expect.any(String))
  await expectAppVisible(toolPane)
  expectNoSmokeErrors(errors, [], [])
})

function session(id: string, title: string, parentID?: string) {
  return {
    id,
    slug: id,
    parentID,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

async function mockNavigatorPlugin(page: Page, sessions: Array<ReturnType<typeof session>>) {
  const body = await fs.readFile(path.resolve("../../.opencode/plugins/session-navigator-app/index.js"), "utf8")
  await page.route("**/experimental/session**", (route) => {
    const url = new URL(route.request().url())
    const selectedDirectory = url.searchParams.get("directory")
    const cursor = Number(url.searchParams.get("cursor") ?? 0)
    const limit = Number(url.searchParams.get("limit") ?? 50)
    const rows = sessions
      .filter((item) => !selectedDirectory || item.directory === selectedDirectory)
      .filter((item) => !cursor || item.time.updated < cursor)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .slice(0, limit)
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(rows),
    })
  })
  await page.route("**/app/plugins**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        plugins: [
          {
            id: "session-navigator-app",
            spec: "session-navigator-app",
            version: "1",
            module: "/app/plugin/session-navigator-app/1/app.js",
            hash: "navigator",
          },
        ],
      }),
    }),
  )
  await page.route("**/app/plugin/session-navigator-app/1/app.js**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "access-control-allow-origin": "*" },
      body,
    }),
  )
}

async function noHorizontalOverflow(locator: Locator) {
  return locator.evaluate((element) => {
    const nodes = [
      element,
      ...Array.from(
        element.querySelectorAll(
          '[data-slot="question-form"], [data-slot="question-form-stack"], [data-slot="question-form-node"], [data-slot="question-form-field"], [data-slot="question-form-display"], [data-slot="question-form-control"], [data-slot="question-form-input"], [data-slot="question-form-button"], [data-slot="question-form-list-field"], [data-slot="question-form-list-input-row"], [data-slot="question-form-range"], [data-slot="question-form-range-inputs"]',
        ),
      ),
    ]
    return nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)
  })
}

async function noHorizontalStackOverlap(locator: Locator) {
  return locator.evaluate((element) => {
    const overlap = (a: DOMRect, b: DOMRect) =>
      a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
    return Array.from(element.querySelectorAll('[data-slot="question-form-stack"][data-direction="horizontal"]')).every((stack) => {
      const nodes = Array.from(stack.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.getAttribute("data-slot") === "question-form-node" && child.getClientRects().length > 0,
      )
      return nodes.every((node, index) =>
        nodes.slice(index + 1).every((other) => !overlap(node.getBoundingClientRect(), other.getBoundingClientRect())),
      )
    })
  })
}

async function labelLeftAndCentered(field: Locator) {
  return field.evaluate((element) => {
    const label = element.querySelector('[data-slot="question-form-label"]')
    const control = element.querySelector('[data-slot="question-form-control"]')
    if (!(label instanceof HTMLElement) || !(control instanceof HTMLElement)) return false
    const labelRect = label.getBoundingClientRect()
    const controlRect = control.getBoundingClientRect()
    return labelRect.left < controlRect.left && Math.abs(labelRect.top + labelRect.height / 2 - (controlRect.top + controlRect.height / 2)) < 8
  })
}

async function buttonLooksClickable(button: Locator) {
  return button.evaluate((element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return (
      style.cursor === "pointer" &&
      style.borderTopStyle !== "none" &&
      style.borderTopWidth !== "0px" &&
      style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      rect.height >= 36 &&
      rect.width >= 96
    )
  })
}

async function fillRichTextPlain(_page: Page, field: Locator, text: string) {
  const input = field.locator('div[data-slot="question-form-input"][contenteditable="true"]')
  await input.fill(text)
  await expect(input).toContainText(text)
}

async function scrollQuestionBodyToTop(root: Locator) {
  await root.locator('[data-slot="question-body"], [data-slot="question-form"]').evaluateAll((elements) => {
    elements.forEach((element) => {
      element.scrollTop = 0
    })
  })
}

async function setVideoCurrentTime(root: Locator, seconds: string) {
  await root.locator('[data-slot="question-form-video"]').evaluate((element, value) => {
    const windowWithVideoTime = window as Window & { __questionVideoTime?: number; __questionVideoPatched?: boolean }
    windowWithVideoTime.__questionVideoTime = Number(value)
    if (!windowWithVideoTime.__questionVideoPatched) {
      windowWithVideoTime.__questionVideoPatched = true
      Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
        configurable: true,
        get() {
          return windowWithVideoTime.__questionVideoTime ?? 0
        },
        set(next) {
          windowWithVideoTime.__questionVideoTime = Number(next)
        },
      })
    }
    element.dispatchEvent(new Event("timeupdate", { bubbles: true }))
  }, seconds)
}
test("finalizeRemaining button answers every open question and submits the whole request", async ({ page }) => {
  const errors = trackPageErrors(page)
  const finalizeRequestID = "que_question_finalize"
  const finalizeQuestionRequest = () => ({
    id: finalizeRequestID,
    sessionID: targetID,
    mode: "blocking" as const,
    revision: 1,
    actions: [],
    questions: ["First", "Second", "Third"].map((label) => ({
      question: `${label} review item?`,
      header: `Item ${label}`,
      options: [
        { id: "yes", label: "Yes", description: "Accept this item" },
        { id: "done", label: "Enough for today", description: "Skip the rest", finalizeRemaining: true },
      ],
    })),
  })
  const replies: { requestID: string; body: unknown }[] = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-popup",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [session(sourceID, "Question source"), session(targetID, "Question target")],
    pageMessages: () => ({ items: [] }),
    questions: () => (replies.length ? [] : [finalizeQuestionRequest()]),
    events: () => (replies.length ? [] : [{
      directory,
      payload: {
        id: "evt_question_finalize",
        type: "surface.asked",
        properties: finalizeQuestionRequest(),
      },
    }]),
    onQuestionReply: (reply) => {
      replies.push(reply)
      return true
    },
  })

  await page.addInitScript(
    ({ directory, dirBase64, sourceID }) => {
      localStorage.setItem("settings.v3", JSON.stringify({}))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:tabs",
        JSON.stringify([{ type: "session", dirBase64, sessionId: sourceID }]),
      )
    },
    { directory, dirBase64: base64Encode(directory), sourceID },
  )

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/${base64Encode(directory)}/session/${sourceID}`, { waitUntil: "commit" })
  const popup = page.locator('[data-component="question-popup"]')
  await expectAppVisible(popup)

  await expect(popup.locator('[data-slot="question-option"]').filter({ hasText: "Enough for today" })).toHaveCount(0)
  await popup.locator('[data-slot="question-option"]').filter({ hasText: "Yes" }).click()
  await popup.getByRole("button", { name: "Next" }).click()
  await expectAppVisible(popup.getByText("Second review item?"))

  const finalizeButton = popup.locator('[data-slot="question-finalize-remaining"]')
  await expectAppVisible(finalizeButton)
  await expect(finalizeButton).toContainText("Enough for today")
  await finalizeButton.click()

  await expect.poll(() => replies).toEqual([
    {
      requestID: finalizeRequestID,
      body: { answers: [["Yes"], ["Enough for today"], ["Enough for today"]] },
    },
  ])
  await expect(popup).toHaveCount(0)
  await page.screenshot({ path: screenshotPath("question-finalize-remaining-submitted.png"), fullPage: true })
  expectNoSmokeErrors(errors, [], [])
})
