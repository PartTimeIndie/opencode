import {
  VOICE_TIMING,
  advanceVoiceTurn,
  createPermissionQueue,
  drainSpeechSentences,
  matchReleasePhrase,
  mergeSamples,
  pcm16le,
  prepareVoiceTurn,
  resolveModelTargetRequest,
  rms,
  shouldFlushVoiceSegment,
  wavBlob,
  voicePrompt,
} from "./core.js"

const ICON = new URL("./assets/voice-conversation.svg", import.meta.url).href

export default {
  id: "voice-conversation-app",
  app(api) {
    const open = createConversationOpener(api)
    if (api.settings.get("voiceOverrides", undefined) === undefined) {
      const legacy = api.settings.get("voices", {})
      api.settings.set("voiceOverrides", Object.entries(legacy && typeof legacy === "object" ? legacy : {})
        .filter(([, voice]) => typeof voice === "string" && voice.trim())
        .map(([model, voice]) => ({ model, voice })))
    }

    api.settings.register({
      id: "voiceConversationSettings",
      title: "Voice conversation",
      searchTerms: ["voice", "speech", "read aloud", "Sprachausgabe", "vorlesen", "TTS"],
      sections: [
        {
          title: "Conversation",
          fields: [
            {
              key: "moderatorTarget",
              type: "model-target",
              label: "Moderator model or chain",
              description: "Pinned when a conversation starts and used for its durable moderator session.",
              default: "default",
              required: true,
              autoSelectDefault: true,
            },
            {
              key: "transcriptionTarget",
              type: "model-target",
              label: "Transcription model or chain",
              description: "Audio-capable model or fallback chain used for live previews and final turns.",
              default: "",
              filter: { inputModalities: ["audio"], purpose: "transcription" },
              required: true,
              autoSelectSingle: true,
            },
            {
              key: "speechTarget",
              type: "model-target",
              label: "Speech model or chain",
              description: "Speech-capable model or fallback chain used for assistant playback.",
              default: "",
              filter: { purpose: "speech" },
              required: true,
              autoSelectSingle: true,
            },
            {
              key: "voice",
              type: "text",
              label: "Voice",
              description: "Preferred voice. Each model uses a supported default when this voice is unavailable.",
              default: "",
            },
            {
              key: "voiceOverrides",
              type: "list",
              label: "Voices by model",
              description: "Optional voices for individual speech models. Unsupported voices fall back to a supported voice for that model.",
              default: [],
              fields: [
                { key: "model", type: "text", label: "Model", description: "Full provider/model identifier, for example openrouter/microsoft/mai-voice-2.", default: "" },
                { key: "voice", type: "text", label: "Voice", description: "Voice identifier supported by this model.", default: "" },
              ],
            },
            {
              key: "speed",
              type: "number",
              label: "Speech speed",
              description: "Playback generation speed from 0.5 to 2.0.",
              min: 0.5,
              max: 2,
              default: 1,
            },
            { key: "releasePhrase", type: "text", label: "Voice permission phrase", description: "Approves exactly one pending worker permission. The phrase stays local and is never spoken or logged by the moderator.", default: "OpenCode Freigabe Jetzt" },
          ],
        },
        {
          title: "Turn detection",
          fields: [
            {
              key: "silenceMs",
              type: "number",
              label: "End-of-turn silence (ms)",
              description: "How long silence must last before the current utterance is submitted.",
              min: 300,
              max: 2000,
              default: 675,
            },
            {
              key: "vadThreshold",
              type: "number",
              label: "Voice threshold",
              description: "RMS audio level that starts or continues an utterance.",
              min: 0.002,
              max: 0.2,
              default: 0.015,
            },
            {
              key: "previewTranscription",
              type: "boolean",
              label: "Show live transcription previews",
              description: "Sends overlapping 1.5-second windows. Preview text is transient and never sent as a turn.",
              default: true,
            },
            {
              key: "language",
              type: "text",
              label: "Language hint",
              description: "Optional BCP-47 language hint for transcription, such as de or en.",
              default: "",
            },
          ],
        },
      ],
    })

    api.toolbar.register({
      id: "voiceConversation",
      title: "Voice conversation",
      tooltip: "Open live voice conversation",
      placement: "composer",
      align: "right",
      order: Number.MAX_SAFE_INTEGER - 2,
      mobile: "visible",
      defaultVisible: true,
      icon: { src: ICON, alt: "Voice conversation", size: "normal" },
      enabled: (context) => !!context.directory,
      run(context) {
        return open(context)
      },
    })

    api.commands.register({
      id: "voice-conversation.open",
      title: "Open voice conversation",
      description: "Open the voice session linked to the current worker. Listening starts explicitly.",
      category: "Voice",
      run() {
        return open()
      },
    })
  },
}

async function conversationLink(api, operation, request) {
  const model = operation === "start" ? api.ui.models.resolve(request.modelTarget) : undefined
  if (operation === "start" && !model) return { ok: false, error: "Voice session model target is unavailable" }
  const response = await api.services.call({
    pluginID: "voice-conversation-app", serviceID: "session-links", version: 1, directory: request.directory,
    input: operation === "start"
      ? { operation, sourceSessionID: request.sourceSessionID, targetSessionID: request.targetSessionID, model }
      : { operation, sessionID: request.sessionID },
  })
  if (!response.ok) return response
  return { ok: true, pair: response.data.link, model: response.data.model }
}

export function createConversationOpener(api) {
  const pending = new Map()
  return (navigation = api.host.navigation.current()) => {
    const { directory, sessionID } = navigation
    if (!directory) return Promise.resolve()
    const key = JSON.stringify([directory, sessionID ?? "new"])
    if (pending.has(key)) return pending.get(key)
    const request = (async () => {
      const created = sessionID ? undefined : await api.host.sessions.create({ directory, modelTarget: "default", agent: "build" })
      if (created && !created.ok) throw new Error(created.error)
      const targetSessionID = sessionID ?? created?.sessionID
      if (!targetSessionID) throw new Error("Worker session was not created")
      const existing = await conversationLink(api, "get", { directory, sessionID: targetSessionID })
      if (!existing.ok) throw new Error(existing.error)
      const retryKey = `voice-start.v1:${key}`
      const result = existing.pair ? existing : await (async () => {
        // Only a retry token lives in KV. Links, role, placement and pinned model
        // always come from the server, never from the old global conversation KV.
        const saved = api.kv.get(retryKey)
        const voiceSessionID = typeof saved === "string" && saved.startsWith("ses_")
          ? saved : `ses_${crypto.randomUUID().replaceAll("-", "")}`
        api.kv.set(retryKey, voiceSessionID)
        return conversationLink(api, "start", {
          directory, targetSessionID, sourceSessionID: voiceSessionID,
          modelTarget: api.settings.get("moderatorTarget", "default"),
        })
      })()
      if (!result.ok) throw new Error(result.error)
      if (!result.pair || !result.model) throw new Error("Voice session pair has no pinned model")
      api.kv.delete(retryKey)
      const current = api.host.navigation.current()
      const ids = [result.pair.targetSessionID, result.pair.sourceSessionID]
      // A late network response must never pull the user back into the pair.
      if (current.directory !== directory || (sessionID && !ids.includes(current.sessionID))) return
      api.host.navigation.openSession({ directory, sessionID: result.pair.sourceSessionID })
      return api.ui.floating.open({
        id: "conversation", title: "Voice conversation", ariaLabel: "Live voice conversation",
        sessions: { directory, ids },
        mount: (context) => mountConversation(api, context, directory, { ...result, firstQuestion: !sessionID }),
      })
    })().catch((error) => {
      const current = api.host.navigation.current()
      if (!sessionID || current.directory !== directory || current.sessionID !== sessionID) return
      return api.ui.floating.open({
        id: "conversation-error", title: "Voice conversation", sessions: { directory, ids: [sessionID] },
        mount({ element }) {
          element.setAttribute("role", "alert")
          element.textContent = error instanceof Error ? error.message : "Voice session could not be opened"
        },
      })
    }).finally(() => pending.delete(key))
    pending.set(key, request)
    return request
  }
}

export function mountConversation(api, context, directory, linked) {
  const replayKey = `speech-observed:${JSON.stringify([directory, linked.pair.sourceSessionID])}`
  const preferenceKey = `voice-controls:${JSON.stringify([directory, linked.pair.sourceSessionID])}`
  const saved = api.kv.get(replayKey, [])
  const preferences = api.kv.get(preferenceKey, {})
  const observed = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [])
  const config = snapshotConfig(api)
  const storedSpeed = Number(preferences?.speed)
  if (Number.isFinite(storedSpeed)) config.speed = Math.max(0.5, Math.min(2, storedSpeed))
  const state = {
    directory,
    sessionID: linked.pair.sourceSessionID,
    workerSessionID: linked.pair.targetSessionID,
    model: linked.model,
    config,
    verbosity: preferences?.verbosity === "detailed" ? "detailed" : "concise",
    speedOverride: Number.isFinite(storedSpeed) ? config.speed : undefined,
    messages: [],
    assistantMessages: new Map(),
    historicalMessages: new Set(observed),
    rememberMessage(id) {
      if (observed.has(id)) return
      observed.add(id)
      api.kv.set(replayKey, [...observed])
    },
    phase: "paused",
    status: directory ? "Ready to start" : "Open a project before starting a voice conversation",
    preview: "",
    permissions: createPermissionQueue(),
    queued: 0,
    muted: false,
    playbackError: "",
    controller: new AbortController(),
    captureController: new AbortController(),
    previewController: undefined,
    unsubscribe: () => {},
    stream: undefined,
    audioLease: undefined,
    audioContext: undefined,
    source: undefined,
    processor: undefined,
    silentGain: undefined,
    preRoll: [],
    preRollSamples: 0,
    speechOnsetSamples: 0,
    speaking: false,
    utterance: [],
    utteranceSamples: 0,
    utteranceSegments: [],
    utteranceUserOnset: true,
    silenceSamples: 0,
    nextPreviewAt: 0,
    previewSequence: 0,
    playbackGeneration: 0,
    playbackAbort: undefined,
    playbackSources: new Set(),
    nextPlaybackAt: 0,
    speechQueue: Promise.resolve(),
    transcriptionQueue: Promise.resolve(),
  }

  const view = conversationView(context.element)
  const render = () => renderConversation(state, view)
  const persistControls = () => api.kv.set(preferenceKey, { verbosity: state.verbosity, speed: state.config.speed })
  const stopPlayback = () => {
    state.playbackGeneration++
    state.speechQueue = Promise.resolve()
    state.playbackAbort?.abort()
    state.playbackAbort = undefined
    state.nextPlaybackAt = 0
    for (const source of state.playbackSources) {
      try {
        source.stop()
      } catch {}
    }
    state.playbackSources.clear()
  }
  const releaseAudio = () => {
    const lease = state.audioLease
    state.audioLease = undefined
    lease?.release()
    state.captureController.abort()
    state.transcriptionQueue = Promise.resolve()
    state.preRoll = []
    state.preRollSamples = 0
    state.speechOnsetSamples = 0
    state.previewController?.abort()
    state.previewController = undefined
    stopPlayback()
    state.processor?.disconnect()
    state.source?.disconnect()
    state.silentGain?.disconnect()
    state.processor = undefined
    state.source = undefined
    state.silentGain = undefined
    state.stream = undefined
    if (state.audioContext && state.audioContext.state !== "closed") void state.audioContext.close()
    state.audioContext = undefined
    state.speaking = false
    state.utterance = []
    state.utteranceSamples = 0
    state.utteranceSegments = []
    state.silenceSamples = 0
    state.preview = ""
  }
  const setStatus = (status, phase = state.phase) => {
    state.status = status
    state.phase = phase
    render()
  }
  const subscribe = () => {
    state.unsubscribe()
    if (!state.sessionID || !state.directory) return
    state.unsubscribe = api.host.sessions.subscribeEvents(
      { directory: state.directory, sessionID: state.sessionID, relatedSession: async () => {
        const result = await conversationLink(api, "get", { directory: state.directory, sessionID: state.sessionID })
        return result.ok && result.pair?.sourceSessionID === state.sessionID ? result.pair.targetSessionID : undefined
      } },
      (event) => onSessionEvent(event, state, render, enqueueSpeech, setStatus),
    )
  }
  const loadHistory = async () => {
    if (!state.sessionID || !state.directory) return
    const sessionID = state.sessionID
    const messages = (
      await api.host.sessions.messages({
        directory: state.directory,
        sessionID: state.sessionID,
        limit: 60,
      })
    ).toReversed()
    if (state.controller.signal.aborted || sessionID !== state.sessionID) return
    state.messages = messages
    for (const message of messages) {
      if (!state.assistantMessages.has(message.id)) state.historicalMessages.add(message.id)
    }
    render()
  }
  const ensureSession = async (signal) => {
    resolveModelTargetRequest(state.config.transcriptionTarget, "Configure a transcription model or chain")
    resolveModelTargetRequest(state.config.speechTarget, "Configure a speech model or chain")
    const current = await conversationLink(api, "get", { directory: state.directory, sessionID: state.sessionID })
    if (signal.aborted) return false
    if (!current.ok) throw new Error(current.error)
    if (current.pair?.sourceSessionID !== state.sessionID || current.pair.targetSessionID !== state.workerSessionID)
      throw new Error("This voice session pair has ended. Open voice again from the worker.")
    return true
  }
  const transcribe = async (audio, preview, signal, continuation = "") => {
    const request = resolveModelTargetRequest(
      state.config.transcriptionTarget,
      "Configure a transcription model or chain",
    )
    const result = await api.host.stt.transcribe({
      directory: state.directory,
      ...request,
      audio,
      mimeType: "audio/wav",
      language: state.config.language || undefined,
      context: recentTranscript(state.messages),
      signal,
    })
    if (!result.ok || typeof result.text !== "string") throw new Error(result.error || "Transcription failed")
    if (preview) return result.text.trim()
    return result.text.trim()
  }
  const previewUtterance = async () => {
    if (!state.config.previewTranscription || !state.audioContext || !state.speaking) return
    const samples = mergeSamples(state.utterance)
    const windowSize = Math.round((VOICE_TIMING.previewWindowMs / 1000) * state.audioContext.sampleRate)
    const sequence = ++state.previewSequence
    state.previewController?.abort()
    const controller = new AbortController()
    state.previewController = controller
    const signal = AbortSignal.any([state.controller.signal, controller.signal])
    const text = await transcribe(
      wavBlob(samples.slice(-windowSize), state.audioContext.sampleRate),
      true,
      signal,
    ).catch(() => "")
    if (!controller.signal.aborted && sequence === state.previewSequence && state.speaking) {
      state.preview = text
      render()
    }
  }
  const submitUtterance = async (chunks, sampleRate, signal, userOnset) => {
    if (signal.aborted) return
    state.previewController?.abort()
    state.previewController = undefined
    state.preview = "Transcribing…"
    render()
    const text = await transcribe(wavBlob(mergeSamples(chunks), sampleRate), false, signal).catch(
      (error) => {
        if (signal.aborted) return ""
        setStatus(error instanceof Error ? error.message : "Transcription failed", "listening")
        return ""
      },
    )
    if (signal.aborted) return
    state.preview = ""
    if (!text || !state.sessionID || !state.model) return render()
    const releasePhraseSpoken = matchReleasePhrase({ transcript: text, phrase: state.config.releasePhrase, pending: true, userOnset: true, playbackActive: false })
    if (releasePhraseSpoken) {
      if (!userOnset) return setStatus("Voice permission phrase ignored during assistant playback", "attention")
      const permission = state.permissions.current
      if (!permission) return setStatus("No worker permission is waiting for approval", "listening")
      const result = await replyPermission("once")
      if (!result.ok) return
      const auditKey = `permission-audit:${JSON.stringify([state.directory, state.sessionID])}`
      const audit = api.kv.get(auditKey, [])
      api.kv.set(auditKey, [...(Array.isArray(audit) ? audit : []).slice(-49), { sessionID: permission.sessionID, requestID: permission.requestID, approvedAt: Date.now(), method: "voice" }])
      setStatus("Freigabe erteilt.", "listening")
      await enqueueSpeech("Freigabe erteilt.")
      return
    }
    const turn = prepareVoiceTurn(text)
    if (turn.verbosity) state.verbosity = turn.verbosity
    if (turn.speedDelta) { state.config.speed = Math.max(0.5, Math.min(2, Number(state.config.speed) + turn.speedDelta)); state.speedOverride = state.config.speed }
    if (turn.verbosity || turn.speedDelta) persistControls()
    for (const confirmation of turn.confirmations) await enqueueSpeech(confirmation)
    if (!turn.text) return setStatus("Listening — conversation preferences updated", "listening")
    state.messages.push({ id: `local-${Date.now()}`, role: "user", text: turn.text, createdAt: Date.now() })
    state.queued++
    render()
    const result = await api.host.sessions.prompt({
      directory: state.directory,
      sessionID: state.sessionID,
      text: voicePrompt(turn.text, state.verbosity),
      model: state.model,
      agent: "voice-moderator",
      delivery: "queue",
    })
    if (!result.ok) {
      state.queued = Math.max(0, state.queued - 1)
      setStatus(result.error || "The spoken turn could not be queued", "listening")
    }
  }
  const finishUtterance = () => {
    if (!state.speaking || !state.audioContext) return
    const chunks = state.utterance
    const sampleRate = state.audioContext.sampleRate
    const signal = state.captureController.signal
    const userOnset = state.utteranceUserOnset
    state.speaking = false
    state.utterance = []
    state.utteranceSamples = 0
    state.silenceSamples = 0
    state.nextPreviewAt = 0
    state.preview = ""
    setStatus("Listening while your turn is transcribed", "listening")
    state.transcriptionQueue = state.transcriptionQueue
      .catch(() => undefined)
      .then(() => submitUtterance(chunks, sampleRate, signal, userOnset))
  }
  const processAudio = (samples) => {
    if (!state.audioContext || state.controller.signal.aborted) return
    const level = rms(samples)
    const threshold = Number(state.config.vadThreshold) || 0.015
    const playback = !!state.playbackAbort || state.playbackSources.size > 0
    state.speechOnsetSamples = level >= threshold ? state.speechOnsetSamples + samples.length : 0
    // In addition to browser echo cancellation, reject isolated playback/noise peaks.
    const onset = !playback || state.speechOnsetSamples >= state.audioContext.sampleRate * 0.18
    if (!state.speaking && level >= threshold && onset) {
      // Microphone activity alone must not suppress a future answer or cancel durable work.
      if (state.playbackAbort || state.playbackSources.size) stopPlayback()
      state.speaking = true
      state.utteranceUserOnset = !playback
      state.utterance = [...state.preRoll, samples.slice()]
      state.utteranceSamples = state.utterance.reduce((total, chunk) => total + chunk.length, 0)
      state.preRoll = []
      state.preRollSamples = 0
      state.silenceSamples = 0
      state.nextPreviewAt = Math.round((VOICE_TIMING.previewWindowMs / 1000) * state.audioContext.sampleRate)
      state.preview = "Listening…"
      setStatus("Listening to your turn", "speaking")
      return
    }
    if (!state.speaking) {
      state.preRoll.push(samples.slice())
      state.preRollSamples += samples.length
      const max = Math.round(0.25 * state.audioContext.sampleRate)
      while (state.preRollSamples > max && state.preRoll.length > 1)
        state.preRollSamples -= state.preRoll.shift().length
      return
    }
    state.utterance.push(samples.slice())
    state.utteranceSamples += samples.length
    const turn = advanceVoiceTurn(
      state,
      samples,
      threshold,
      Math.round(((Number(state.config.silenceMs) || 675) / 1000) * state.audioContext.sampleRate),
    )
    state.silenceSamples = turn.silenceSamples
    if (state.utteranceSamples >= state.nextPreviewAt) {
      state.nextPreviewAt += Math.round(
        ((VOICE_TIMING.previewWindowMs - VOICE_TIMING.previewOverlapMs) / 1000) * state.audioContext.sampleRate,
      )
      void previewUtterance()
    }
    if (turn.shouldFinish) finishUtterance()
  }
  const start = async (firstQuestion = "") => {
    if (state.phase === "starting" || state.stream || state.controller.signal.aborted) return
    if (!state.directory) return setStatus("Open a project before starting a voice conversation", "error")
    const selected = snapshotConfig(api)
    state.config = { ...selected, speed: state.speedOverride ?? selected.speed }
    state.captureController = new AbortController()
    const signal = state.captureController.signal
    setStatus("Preparing microphone and moderator session…", "starting")
    const AudioContext = window.AudioContext ?? window.webkitAudioContext
    if (!AudioContext) return setStatus("This browser does not support live audio", "error")
    state.audioContext = state.audioContext ?? new AudioContext()
    try {
      await state.audioContext.resume()
      if (signal.aborted || !(await ensureSession(signal))) return
      if (signal.aborted) return
      subscribe()
      await loadHistory()
      if (signal.aborted) return
      if (!api.host.audio) throw new Error("Live voice requires a host with exclusive audio capture support")
      const lease = await api.host.audio.acquire({ priority: 0, interruptible: true, signal })
      if (signal.aborted) {
        if (lease.ok) lease.release()
        return
      }
      if (!lease.ok) throw new Error(lease.error)
      if (lease.signal.aborted) {
        releaseAudio()
        return setStatus("Microphone released — resume explicitly", "paused")
      }
      state.audioLease = lease
      lease.signal.addEventListener("abort", () => {
        if (state.audioLease !== lease) return
        releaseAudio()
        setStatus("Microphone released — resume voice explicitly after dictation or device recovery", "paused")
      }, { once: true })
      state.stream = lease.stream
      state.source = state.audioContext.createMediaStreamSource(state.stream)
      state.processor = state.audioContext.createScriptProcessor(4096, 1, 1)
      state.silentGain = state.audioContext.createGain()
      state.silentGain.gain.value = 0
      state.processor.onaudioprocess = (event) => processAudio(event.inputBuffer.getChannelData(0))
      state.source.connect(state.processor)
      state.processor.connect(state.silentGain)
      state.silentGain.connect(state.audioContext.destination)
      if (firstQuestion) { setStatus(firstQuestion, "responding"); await enqueueSpeech(firstQuestion); if (signal.aborted) return }
      setStatus("Listening — speak naturally", "listening")
    } catch (error) {
      if (signal.aborted) return
      releaseAudio()
      setStatus(error instanceof Error ? error.message : "Voice conversation could not start", "error")
    }
  }
  const pause = () => {
    releaseAudio()
    setStatus("Paused — the session and transcript are preserved", "paused")
  }
  const end = async () => {
    releaseAudio()
    const result = await conversationLink(api, "end", { directory: state.directory, sessionID: state.sessionID })
      .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : "Could not end voice pair" }))
    if (state.controller.signal.aborted) return
    if (!result.ok) return setStatus(result.error, "error")
    setStatus("Conversation ended. Both sessions and worker work are preserved.", "ended")
    context.close()
  }
  function enqueueSpeech(sentence) {
    if (!sentence) return Promise.resolve()
    const generation = state.playbackGeneration
    state.speechQueue = state.speechQueue
      .catch(() => undefined)
      .then(async () => {
        if (
          generation !== state.playbackGeneration ||
          state.muted ||
          !state.stream ||
          !state.audioContext ||
          !state.config
        )
          return
        const controller = new AbortController()
        state.playbackAbort = controller
        const signal = AbortSignal.any([state.controller.signal, controller.signal])
        const timeout = setTimeout(() => {
          if (generation !== state.playbackGeneration) return
          stopPlayback()
          state.playbackError = "Playback stopped: speech request timed out"
          render()
        }, VOICE_TIMING.playbackTimeoutMs)
        const clearDeadline = () => clearTimeout(timeout)
        signal.addEventListener("abort", clearDeadline, { once: true })
        const request = resolveModelTargetRequest(state.config.speechTarget, "Configure a speech model or chain")
        try {
          const result = await api.host.tts.speak({
            directory: state.directory,
            ...request,
            text: sentence,
            voice: state.config.voice,
            voices: state.config.voices,
            speed: Number(state.config.speed) || 1,
            signal,
          })
          if (!result.ok) throw new Error(result.error)
          await playSpeechStream(result, state, generation, signal)
          if (!signal.aborted && generation === state.playbackGeneration) {
            state.playbackError = ""
            render()
          }
        } finally {
          clearTimeout(timeout)
          signal.removeEventListener("abort", clearDeadline)
          if (state.playbackAbort === controller) state.playbackAbort = undefined
        }
      })
    state.speechQueue = state.speechQueue.catch((error) => {
      if (generation !== state.playbackGeneration) return
      stopPlayback()
      state.playbackError = error instanceof Error ? `Playback stopped: ${error.message}` : "Playback stopped"
      render()
    })
    return state.speechQueue
  }

  view.start.addEventListener("click", () => void start())
  view.dismissPlaybackError.addEventListener("click", () => {
    state.playbackError = ""
    render()
  })
  view.pause.addEventListener("click", pause)
  view.end.addEventListener("click", () => void end())
  view.mute.addEventListener("click", () => {
    state.muted = !state.muted
    if (state.muted) stopPlayback()
    render()
  })
  const replyPermission = async (reply) => {
    const result = await state.permissions.reply(reply, (request) => api.host.sessions.replyPermission({
      directory: state.directory,
      ...request,
    })).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : "Permission reply failed" }))
    render()
    if (!result.ok) setStatus(result.error || "The confirmation could not be sent", "error")
    return result
  }
  view.allowOnce.addEventListener("click", () => void replyPermission("once"))
  view.reject.addEventListener("click", () => void replyPermission("reject"))
  view.openSession.addEventListener("click", () => {
    if (state.sessionID && state.directory)
      api.host.navigation.openSession({ directory: state.directory, sessionID: state.sessionID })
  })
  view.openWorker.addEventListener("click", () => {
    api.host.navigation.openSession({ directory: state.directory, sessionID: state.workerSessionID })
  })

  if (state.sessionID) {
    state.status = "Paused — restored from session history"
    subscribe()
    void loadHistory().catch((error) => {
      if (!state.controller.signal.aborted) setStatus(error instanceof Error ? error.message : "History unavailable", "error")
    })
  }
  render()
  if (linked.firstQuestion) void start("Was möchtest du?")
  const abort = () => {
    state.controller.abort()
    state.unsubscribe()
    releaseAudio()
  }
  context.signal.addEventListener("abort", abort, { once: true })
  return abort
}

function onSessionEvent(event, state, render, enqueueSpeech, setStatus) {
  if (event.type === "activity.started") {
    state.phase = state.speaking ? "speaking" : "responding"
    state.status = state.speaking ? "Listening while the assistant works" : "Assistant is responding"
    return render()
  }
  if (event.type === "text.delta" || event.type === "text.ended") {
    if (state.historicalMessages.has(event.messageID)) return
    // Persist before queueing audio: reopening or reloading cannot replay an
    // already observed answer, including one interrupted halfway through.
    state.rememberMessage(event.messageID)
    const message = state.assistantMessages.get(event.messageID) ?? {
      id: event.messageID,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      parts: new Map(),
      generation: state.stream && !state.muted ? state.playbackGeneration : -1,
    }
    const part = message.parts.get(event.textID) ?? {
      text: "",
      consumed: 0,
      ended: false,
      generation: message.generation,
    }
    if (part.ended) return
    const previous = part.text
    part.text = event.type === "text.delta" ? part.text + event.delta : event.text
    part.ended = event.type === "text.ended"
    message.parts.set(event.textID, part)
    message.text = [...message.parts.values()].map((item) => item.text).join("")
    state.assistantMessages.set(event.messageID, message)
    if (!state.messages.some((item) => item.id === message.id)) state.messages.push(message)
    // Final snapshots may repair missing deltas. Never replay an already consumed prefix,
    // a paused generation, or text whose previously spoken prefix was rewritten.
    if (
      state.stream && state.audioContext && !state.muted &&
      part.generation === state.playbackGeneration &&
      part.text.startsWith(previous.slice(0, part.consumed))
    ) {
      const drained = drainSpeechSentences(part.text.slice(part.consumed), part.ended)
      part.consumed = part.text.length - drained.remainder.length
      for (const sentence of drained.sentences) void enqueueSpeech(sentence)
    } else {
      part.consumed = part.text.length
    }
    return render()
  }
  if (event.type === "permission.asked") {
    if (event.sessionID !== state.workerSessionID) return
    state.permissions.ask(event)
    return setStatus(`Confirm ${event.action} below or use the configured voice permission phrase`, "attention")
  }
  if (event.type === "permission.replied") {
    state.permissions.replied(event.requestID)
    return render()
  }
  if (event.type === "activity.completed") {
    state.queued = Math.max(0, state.queued - 1)
    return setStatus(state.stream ? "Listening — speak naturally" : "Paused", state.stream ? "listening" : "paused")
  }
  if (event.type === "activity.interrupted") {
    state.queued = Math.max(0, state.queued - 1)
    return setStatus("Assistant work was interrupted", state.phase)
  }
  if (event.type === "activity.failed") {
    state.queued = Math.max(0, state.queued - 1)
    return setStatus(event.error, "error")
  }
}

function snapshotConfig(api) {
  const overrides = api.settings.get("voiceOverrides", undefined)
  return {
    moderatorTarget: api.settings.get("moderatorTarget", "default"),
    transcriptionTarget: api.settings.get("transcriptionTarget", ""),
    speechTarget: api.settings.get("speechTarget", ""),
    voice: api.settings.get("voice", ""),
    voices: overrides === undefined ? api.settings.get("voices", {}) :
      Object.fromEntries((Array.isArray(overrides) ? overrides : []).flatMap((row) =>
        row && typeof row.model === "string" && row.model.trim() && typeof row.voice === "string" && row.voice.trim()
          ? [[row.model.trim(), row.voice.trim()]] : [],
      )),
    speed: api.settings.get("speed", 1),
    releasePhrase: api.settings.get("releasePhrase", "OpenCode Freigabe Jetzt"),
    silenceMs: api.settings.get("silenceMs", 675),
    vadThreshold: api.settings.get("vadThreshold", 0.015),
    previewTranscription: api.settings.get("previewTranscription", true),
    language: api.settings.get("language", ""),
  }
}

function recentTranscript(messages) {
  return messages
    .slice(-6)
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n")
    .slice(-4000)
}

async function playSpeechStream(result, state, generation, signal) {
  if (signal.aborted || !state.audioContext || generation !== state.playbackGeneration) return result.stream.cancel()
  const reader = result.stream.getReader()
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", cancel, { once: true })
  const encoded = []
  let carry = new Uint8Array()
  let size = 0
  try {
    if (result.format !== "pcm" && result.format !== "mp3") throw new Error("Unsupported speech audio format")
    if (result.format === "pcm" && (
      !Number.isInteger(result.sampleRate) || result.sampleRate < 8000 || result.sampleRate > 192000 ||
      !Number.isInteger(result.channels) || result.channels < 1 || result.channels > 8
    )) throw new Error("Speech provider returned PCM without valid sample rate and channels")
    if (state.audioContext.state === "suspended") await state.audioContext.resume()
    if (signal.aborted || generation !== state.playbackGeneration || !state.audioContext) return
    if (state.audioContext.state !== "running") throw new Error("Audio playback is paused. Resume listening to enable sound.")
    while (true) {
      const next = await reader.read()
      if (signal.aborted || generation !== state.playbackGeneration || !state.audioContext) return
      if (next.done) break
      size += next.value.length
      if (size > 64 * 1024 * 1024) throw new Error("Speech audio exceeds the playback limit")
      if (result.format !== "pcm") {
        encoded.push(next.value)
        continue
      }
      const bytes = new Uint8Array(carry.length + next.value.length)
      bytes.set(carry)
      bytes.set(next.value, carry.length)
      const even = bytes.length - (bytes.length % (2 * result.channels))
      carry = bytes.slice(even)
      if (!even) continue
      const samples = pcm16le(bytes.slice(0, even))
      const buffer = state.audioContext.createBuffer(result.channels, samples.length / result.channels, result.sampleRate)
      for (let channel = 0; channel < result.channels; channel++) {
        buffer.copyToChannel(samples.filter((_, index) => index % result.channels === channel), channel)
      }
      scheduleAudioBuffer(buffer, state)
    }
    if (!size) throw new Error("Speech provider returned empty audio")
    if (carry.length) throw new Error("Speech provider returned truncated PCM audio")
    if (result.format === "pcm") return
    const buffer = await state.audioContext.decodeAudioData(await new Blob(encoded).arrayBuffer())
    if (signal.aborted || generation !== state.playbackGeneration || !state.audioContext) return
    scheduleAudioBuffer(buffer, state)
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

function scheduleAudioBuffer(buffer, state) {
  const context = state.audioContext
  if (!context) return
  const source = context.createBufferSource()
  source.buffer = buffer
  source.connect(context.destination)
  const start = Math.max(context.currentTime + 0.025, state.nextPlaybackAt || 0)
  state.nextPlaybackAt = start + buffer.duration
  state.playbackSources.add(source)
  source.onended = () => state.playbackSources.delete(source)
  source.start(start)
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (key === "className") node.className = value
    else if (key === "text") node.textContent = value
    else if (key === "hidden") node.hidden = !!value
    else node.setAttribute(key, value === true ? "true" : String(value))
  }
  for (const child of children) if (child) node.append(child)
  return node
}

function conversationView(element) {
  const root = h("section", { className: "oc-voice" })
  const style = h("style", {
    text: `.oc-voice{display:grid;gap:16px;font:14px/1.45 system-ui,sans-serif;color:inherit}
      .oc-voice__hero{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px;border:1px solid var(--border-base,#383838);border-radius:13px;background:var(--background-stronger,rgba(255,255,255,.035))}
      .oc-voice__state{display:flex;align-items:center;gap:10px;min-width:0}
      .oc-voice__pulse{width:12px;height:12px;border-radius:50%;background:#7d8590;box-shadow:0 0 0 0 rgba(54,190,120,.35)}
      .oc-voice[data-phase=listening] .oc-voice__pulse,.oc-voice[data-phase=speaking] .oc-voice__pulse{background:#36be78;animation:oc-voice-pulse 1.6s infinite}
      .oc-voice[data-phase=responding] .oc-voice__pulse{background:#58a6ff}
      .oc-voice[data-phase=attention] .oc-voice__pulse,.oc-voice[data-phase=error] .oc-voice__pulse{background:#e3a008}
      @keyframes oc-voice-pulse{70%{box-shadow:0 0 0 8px rgba(54,190,120,0)}}
      .oc-voice__status{font-weight:600;overflow-wrap:anywhere}.oc-voice__meta{font-size:12px;color:var(--text-muted,#aaa);margin-top:3px}
      .oc-voice__preview{min-height:22px;color:var(--text-muted,#aaa);font-style:italic}
      .oc-voice__permission{display:grid;gap:8px;padding:12px;border:1px solid #e3a008;border-radius:11px;background:rgba(227,160,8,.08)}.oc-voice__permission[hidden]{display:none}.oc-voice__permission-actions{display:flex;gap:8px;flex-wrap:wrap}.oc-voice__permission-resource{color:var(--text-muted,#aaa);font-size:12px;overflow-wrap:anywhere}
      .oc-voice__controls{display:flex;gap:8px;flex-wrap:wrap}.oc-voice button{border:1px solid var(--border-base,#555);border-radius:9px;padding:8px 12px;background:var(--background-stronger,#292929);color:inherit;cursor:pointer}.oc-voice button[data-primary=true]{background:var(--button-primary-base,#171717);border-color:transparent;color:var(--icon-invert-base,#fff)}.oc-voice button:disabled{opacity:.45;cursor:not-allowed}
      @media(max-width:600px){.oc-voice__hero{align-items:flex-start;flex-direction:column}.oc-voice__controls button{flex:1 1 42%}}`,
  })
  const pulse = h("span", { className: "oc-voice__pulse", "aria-hidden": "true" })
  const status = h("div", { className: "oc-voice__status", role: "status", "aria-live": "polite" })
  const heroMeta = h("div", { className: "oc-voice__meta" })
  const hero = h("div", { className: "oc-voice__hero" }, [
    h("div", { className: "oc-voice__state" }, [pulse, h("div", {}, [status, heroMeta])]),
  ])
  const openSession = h("button", { type: "button", "data-action": "open-session", text: "Conversation" })
  const openWorker = h("button", { type: "button", "data-action": "open-worker", text: "Worker" })
  const sessionNav = h("nav", { className: "oc-voice__controls", "aria-label": "Session view" }, [openSession, openWorker])
  const viewMeta = h("div", {
    className: "oc-voice__meta",
    text: "View only — speech always goes to the conversation. Full histories stay in the normal session tabs.",
  })
  const preview = h("div", { className: "oc-voice__preview", "aria-live": "polite" })
  const playbackErrorText = h("span", { "data-playback-error": "" })
  const dismissPlaybackError = h("button", { type: "button", "data-action": "dismiss-playback-error", text: "Dismiss" })
  const playbackError = h("div", { className: "oc-voice__playback-error", role: "alert", hidden: true }, [
    playbackErrorText,
    document.createTextNode(" "),
    dismissPlaybackError,
  ])
  const permissionAction = h("div", { "data-permission-action": "" })
  const permissionResources = h("div", { className: "oc-voice__permission-resource", "data-permission-resources": "" })
  const allowOnce = h("button", { type: "button", "data-action": "allow-once", "data-primary": "true", text: "Allow once" })
  const reject = h("button", { type: "button", "data-action": "reject", text: "Reject" })
  const permission = h("div", { className: "oc-voice__permission", role: "group", "aria-label": "Permission confirmation", hidden: true }, [
    h("strong", { text: "Confirmation required" }),
    permissionAction,
    permissionResources,
    h("div", { className: "oc-voice__permission-actions" }, [allowOnce, reject]),
  ])
  const start = h("button", { type: "button", "data-action": "start", "data-primary": "true", text: "Start listening" })
  const pause = h("button", { type: "button", "data-action": "pause", text: "Pause" })
  const mute = h("button", { type: "button", "data-action": "mute", text: "Mute voice" })
  const end = h("button", { type: "button", "data-action": "end", text: "End" })
  const controls = h("div", { className: "oc-voice__controls" }, [start, pause, mute, end])
  root.append(style, hero, sessionNav, viewMeta, preview, playbackError, permission, controls)
  element.replaceChildren(root)
  return {
    root,
    status,
    meta: heroMeta,
    preview,
    playbackError,
    playbackErrorText,
    dismissPlaybackError,
    permission,
    permissionAction,
    permissionResources,
    allowOnce,
    reject,
    start,
    pause,
    mute,
    end,
    openSession,
    openWorker,
  }
}


function renderConversation(state, view) {
  view.root.dataset.phase = state.phase
  view.status.textContent = state.status
  view.playbackError.hidden = !state.playbackError
  view.playbackErrorText.textContent = state.playbackError
  view.meta.textContent = `${state.sessionID ? "Durable session" : "No session yet"} · ${state.verbosity === "detailed" ? "Ausführlich" : "Kurz"} · ${Number(state.config.speed).toFixed(2)}×${state.queued ? ` · ${state.queued} turn${state.queued === 1 ? "" : "s"} queued` : ""}`
  view.preview.textContent = state.preview
  const permission = state.permissions.current
  view.permission.hidden = !permission
  view.permissionAction.textContent = permission?.action ?? ""
  view.permissionResources.textContent = permission?.resources.length
    ? permission.resources.join(" · ")
    : "No resource details"
  view.start.disabled = state.phase === "starting" || !!state.stream
  view.pause.disabled = !state.stream
  view.end.disabled = !state.sessionID
  view.openSession.disabled = !state.sessionID
  view.mute.textContent = state.muted ? "Unmute voice" : "Mute voice"
}
