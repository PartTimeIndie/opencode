import path from "node:path"
import type { MediaAdapters, MediaProvider } from "@opencode-ai/plugin/media"

export function createMediaRegistry() {
  const entries = new Map<string, Map<string, MediaAdapters>>()
  const key = (directory: string) => process.platform === "win32" ? path.resolve(directory).toLowerCase() : path.resolve(directory)
  return {
    list(directory: string) { return [...(entries.get(key(directory))?.values() ?? [])] },
    register(directory: string, adapters: MediaAdapters) {
      const scope = key(directory)
      const registered = entries.get(scope) ?? new Map<string, MediaAdapters>()
      if (!adapters.providerID.trim() || (!adapters.speech && !adapters.transcription)) throw new Error("Invalid media registration")
      if (registered.has(adapters.providerID)) throw new Error(`Media adapters already registered for ${adapters.providerID}`)
      const controller = new AbortController()
      const signal = (input?: AbortSignal) => {
        controller.signal.throwIfAborted()
        return input ? AbortSignal.any([controller.signal, input]) : controller.signal
      }
      const provider = (input: MediaProvider): MediaProvider => {
        if (input.id !== adapters.providerID) throw new Error("Media adapter provider identity mismatch")
        return {id:input.id,key:input.key,options:input.options}
      }
      const bound: MediaAdapters = {
        providerID: adapters.providerID,
        ...(adapters.speech ? { speech: { supports: (modelID) => adapters.speech!.supports(modelID),
          ...(adapters.speech.capabilities ? {capabilities: (modelID: string) => adapters.speech!.capabilities!(modelID)} : {}), speak: async (input) => {
          const abort = signal(input.signal)
          const supplied = provider(input.provider)
          const result = await invoke(abort,() => adapters.speech!.speak({provider:supplied,modelID:input.modelID,text:input.text,voice:input.voice,format:input.format,speed:input.speed,signal:abort}), (late) => { void late.stream.cancel().catch(() => {}) })
          if (result.providerID !== supplied.id || result.modelID !== input.modelID) {
            void result.stream.cancel().catch(() => {})
            throw new Error("Media adapter returned another provider or model")
          }
          return {...result,stream:cancelStream(result.stream,abort)}
        } } } : {}),
        ...(adapters.transcription ? { transcription: { supports: (modelID) => adapters.transcription!.supports(modelID), transcribe: async (input) => {
          const abort = signal(input.signal)
          const supplied = provider(input.provider)
          const result = await invoke(abort,() => adapters.transcription!.transcribe({provider:supplied,modelID:input.modelID,audio:input.audio,mimeType:input.mimeType,language:input.language,context:input.context,timeoutMs:input.timeoutMs,signal:abort}))
          if (result.providerID !== supplied.id || result.modelID !== input.modelID) throw new Error("Media adapter returned another provider or model")
          return result
        } } } : {}),
      }
      registered.set(adapters.providerID, bound)
      entries.set(scope, registered)
      return () => {
        if (registered.get(adapters.providerID) !== bound) return
        controller.abort()
        registered.delete(adapters.providerID)
        if (!registered.size) entries.delete(scope)
      }
    },
  }
}

export const mediaRegistry = createMediaRegistry()

function invoke<A>(signal: AbortSignal, run: () => Promise<A>, late?: (value: A) => void): Promise<A> {
  return new Promise((resolve,reject) => {
    const abort = () => reject(new DOMException("Media operation was cancelled","AbortError"))
    if (signal.aborted) return abort()
    signal.addEventListener("abort",abort,{once:true})
    Promise.resolve().then(() => {signal.throwIfAborted();return run()}).then((value) => {
      if (signal.aborted) {late?.(value);return}
      resolve(value)
    },reject).finally(() => signal.removeEventListener("abort",abort))
  })
}

function cancelStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = stream.getReader()
  let ended = false
  let abort = () => {}
  return new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (ended) return
        ended = true
        controller.error(new DOMException("Media stream was cancelled","AbortError"))
        void reader.cancel().catch(() => {})
        signal.removeEventListener("abort",abort)
      }
      signal.addEventListener("abort",abort,{once:true})
      if (signal.aborted) abort()
    },
    async pull(controller) {
      if (ended) return
      try {
        const next = await reader.read()
        if (ended) return
        if (!next.done) {controller.enqueue(next.value);return}
        ended = true
        signal.removeEventListener("abort",abort)
        controller.close()
      } catch (error) {
        if (ended) return
        ended = true
        signal.removeEventListener("abort",abort)
        controller.error(error)
      }
    },
    cancel(reason) {
      ended = true
      signal.removeEventListener("abort",abort)
      return reader.cancel(reason)
    },
  })
}
