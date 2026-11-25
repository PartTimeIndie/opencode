export const MAX_AUDIO_BYTES = 16 * 1024 * 1024

export function pcmSamples(bytes, channels) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8 || bytes.length % (channels * 2)) throw new Error("Unvollständige PCM-Audiodaten.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: channels }, (_, channel) => Float32Array.from({ length: bytes.length / channels / 2 }, (_, frame) => view.getInt16((frame * channels + channel) * 2, true) / 32768))
}

export async function collectAudio(stream, signal, maxBytes = MAX_AUDIO_BYTES) {
  if (signal.aborted) { await stream.cancel(); throw new Error("Abgebrochen") }
  const reader = stream.getReader()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (signal.aborted) throw new Error("Abgebrochen")
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) throw new Error("Sprachausgabe überschreitet das Audiolimit.")
      chunks.push(next.value)
    }
    if (!size) throw new Error("Der Sprachdienst hat leere Audiodaten geliefert.")
    const bytes = new Uint8Array(size)
    chunks.reduce((offset, chunk) => { bytes.set(chunk, offset); return offset + chunk.length }, 0)
    return bytes
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function createPlayer(factory = () => new AudioContext()) {
  let context
  let source
  let rejectPlayback
  const stop = () => {
    const previous = source
    source = undefined
    rejectPlayback?.(new Error("Abgebrochen"))
    rejectPlayback = undefined
    if (previous) { previous.onended = null; previous.stop(); previous.disconnect() }
  }
  return {
    async unlock() {
      context = context ?? factory()
      if (context.state === "suspended") await context.resume()
      if (context.state !== "running") throw new Error("Audio ist blockiert – bitte per Klick erneut anhören.")
    },
    async decode(speech, signal) {
      const bytes = await collectAudio(speech.stream, signal)
      if (signal.aborted || !context) throw new Error("Abgebrochen")
      if (speech.format === "mp3") {
        const buffer = await context.decodeAudioData(bytes.buffer)
        if (signal.aborted) throw new Error("Abgebrochen")
        if (buffer.duration > 90 || buffer.length * buffer.numberOfChannels * 4 > MAX_AUDIO_BYTES) throw new Error("Dekodierte Sprachausgabe überschreitet das Audiolimit.")
        return buffer
      }
      if (speech.format !== "pcm") throw new Error("Nicht unterstütztes Audioformat.")
      if (!Number.isInteger(speech.sampleRate) || speech.sampleRate < 8000 || speech.sampleRate > 192000) throw new Error("Ungültige PCM-Samplerate.")
      const samples = pcmSamples(bytes, speech.channels)
      if (samples[0].length * samples.length * 4 > MAX_AUDIO_BYTES || samples[0].length / speech.sampleRate > 90) throw new Error("Dekodierte Sprachausgabe überschreitet das Audiolimit.")
      const buffer = context.createBuffer(samples.length, samples[0].length, speech.sampleRate)
      samples.forEach((channel, index) => buffer.copyToChannel(channel, index))
      return buffer
    },
    playBuffer(buffer, signal) {
      if (signal.aborted || !context || context.state !== "running") return Promise.reject(new Error("Audio ist gestoppt oder blockiert."))
      stop()
      return new Promise((resolve, reject) => {
        const node = context.createBufferSource()
        const abort = () => stop()
        const cleanup = () => { signal.removeEventListener("abort", abort); node.disconnect(); if (source === node) { source = undefined; rejectPlayback = undefined } }
        source = node
        rejectPlayback = (error) => { cleanup(); reject(error) }
        node.buffer = buffer
        node.connect(context.destination)
        node.onended = () => { cleanup(); resolve() }
        signal.addEventListener("abort", abort, { once: true })
        node.start()
      })
    },
    stop,
    dispose() { stop(); if (context && context.state !== "closed") void context.close(); context = undefined },
  }
}
