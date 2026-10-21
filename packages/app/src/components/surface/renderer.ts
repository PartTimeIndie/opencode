export * as SurfaceRenderer from "./renderer"

import { SurfaceSchema } from "@opencode-ai/core/surface/schema"
import { SessionFailure } from "@opencode-ai/core/session/failure"
import { SessionFailureCard } from "@opencode-ai/core/session/failure-card"

const remediationLabel: Record<string, string> = {
  retry: "Retry",
  resume: "Resume",
  report: "Report",
  continue: "Continue",
}

export type RenderedWidget = {
  readonly type: SurfaceSchema.HostComponent
  readonly title?: string
  readonly text: string
  readonly action?: string
}

export type RenderedSurface = {
  readonly id: string
  readonly kind: SurfaceSchema.Kind
  readonly title?: string
  readonly blocking: boolean
  readonly widgets: readonly RenderedWidget[]
}

export function render(surface: SurfaceSchema.Surface): RenderedSurface {
  return {
    id: surface.id,
    kind: surface.kind,
    blocking: surface.blocking === true,
    ...(surface.title !== undefined ? { title: surface.title } : {}),
    widgets: surface.body.map(renderWidget),
  }
}

export function renderErrorCard(card: SessionFailureCard.Card, id = "error"): RenderedSurface {
  return render(SurfaceSchema.errorCard(id, card))
}

export function renderObservedFailure(input: {
  readonly code?: string
  readonly message: string
  readonly remediation?: string
}): RenderedSurface | undefined {
  if (!SessionFailure.codes.includes(input.code as SessionFailure.Code)) return
  const remediation = SessionFailure.Remediation.literals.find((value) => value === input.remediation)
  return renderErrorCard(
    SessionFailureCard.fromFailure(
      SessionFailure.make(input.code as SessionFailure.Code, {
        message: input.message,
        ...(remediation !== undefined ? { remediation } : {}),
      }),
    ),
  )
}

function renderWidget(widget: SurfaceSchema.Widget): RenderedWidget {
  if (widget.type === "error_card") {
    const code = stringProp(widget.props, "code") ?? "internal.defect"
    const message = stringProp(widget.props, "message") ?? ""
    const remediation = stringProp(widget.props, "remediation")
    return {
      type: "error_card",
      title: code,
      text: message,
      ...(remediation !== undefined ? { action: remediationLabel[remediation] ?? remediation } : {}),
    }
  }
  const text = stringProp(widget.props, "text") ?? stringProp(widget.props, "value") ?? ""
  return { type: widget.type, text }
}

function stringProp(props: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = props?.[key]
  return typeof value === "string" ? value : undefined
}
