import type { AppHostAudioCaptureInput, AppHostAudioCaptureResult } from "@opencode-ai/plugin/app"
import { abortPluginWork } from "./abort"

export type AudioCaptureInput = AppHostAudioCaptureInput
export type AudioCaptureResult = AppHostAudioCaptureResult

// One broker per host runtime, not per composer mount. Revoked owners never
// resume automatically when their replacement releases the microphone.
export function createAudioCaptureBroker(capture: (constraints: MediaStreamConstraints) => Promise<MediaStream>) {
  let current: { priority: number; interruptible: boolean; release(): void } | undefined
  let disposed = false
  return {
    async acquire(input: AudioCaptureInput): Promise<AudioCaptureResult> {
      if (disposed) return { ok: false, error: "Microphone capture is unavailable" }
      if (!Number.isFinite(input.priority) || typeof input.interruptible !== "boolean")
        return { ok: false, error: "Microphone priority must be finite and interruptible must be a boolean" }
      if (input.signal?.aborted) return { ok: false, error: "Microphone request cancelled" }
      if (current && (!current.interruptible || input.priority <= current.priority))
        return { ok: false, error: "Microphone is already in use" }
      const previous = current
      const controller = new AbortController()
      const cancelled = Promise.withResolvers<AudioCaptureResult>()
      let stream: MediaStream | undefined
      const lease = {
        priority: input.priority,
        interruptible: input.interruptible,
        release() {
          if (controller.signal.aborted) return
          if (current === lease) current = undefined
          input.signal?.removeEventListener("abort", lease.release)
          stream?.getTracks().forEach((track) => {
            track.removeEventListener("ended", lease.release)
            track.stop()
          })
          abortPluginWork(controller)
          cancelled.resolve({ ok: false, error: "Microphone request cancelled" })
        },
      }
      current = lease
      input.signal?.addEventListener("abort", lease.release, { once: true })
      previous?.release()
      // getUserMedia itself cannot be aborted. Stop a late stream even after the
      // caller has already settled, without releasing a newer owner's lease.
      const acquired = Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) return
          return capture({
            audio: {
              ...(input.deviceID ? { deviceId: { exact: input.deviceID } } : {}),
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          })
        })
        .then((value): AudioCaptureResult => {
          if (!value) return { ok: false, error: "Microphone request cancelled" }
          if (controller.signal.aborted) {
            value.getTracks().forEach((track) => track.stop())
            return { ok: false, error: "Microphone request cancelled" }
          }
          stream = value
          stream.getTracks().forEach((track) => track.addEventListener("ended", lease.release, { once: true }))
          return { ok: true, stream, signal: controller.signal, release: lease.release }
        })
        .catch((error: unknown): AudioCaptureResult => {
          const result = {
            ok: false as const,
            error: error instanceof Error ? error.message : "Microphone capture failed",
            code: error instanceof Error ? error.name : undefined,
          }
          cancelled.resolve(result)
          lease.release()
          return result
        })
      return Promise.race([acquired, cancelled.promise])
    },
    dispose() {
      disposed = true
      current?.release()
    },
  }
}
