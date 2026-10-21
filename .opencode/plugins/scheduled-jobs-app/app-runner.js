import {
  isCompletedScheduledJobRun,
  shouldReuseScheduledJobSession,
  scheduledJobPollingState,
  scheduledJobMessageID,
  scheduledJobSessionID,
  scheduledJobModelSelection,
  scheduledJobTaskPrompt,
  scheduledJobPrompt,
} from "./app-runner-helpers.js"
import { resultContractMarker } from "./result-contract.js"
export function createScheduledAppRunner(api, request, showToast) {
  const errorMessage = (error, fallback) => error?.data?.message || (error instanceof Error ? error.message : fallback)
  const sessionClient = (directory) => {
    const http = async (path, method = "GET", body) => {
      const result = await api.host.http.request({
        path,
        method,
        query: { directory },
        body,
        signal: api.lifecycle.signal,
      })
      if (!result.ok)
        throw Object.assign(new Error(result.body?.message || result.text || result.statusText), {
          status: result.status,
        })
      return result.body
    }
    return {
      session: { get: async ({ sessionID }) => ({ data: await http(`/session/${encodeURIComponent(sessionID)}`) }) },
      v2: {
        session: {
          create: async (input) => ({ data: await http("/api/session", "POST", input) }),
          prompt: async ({ sessionID, ...input }) =>
            http(`/api/session/${encodeURIComponent(sessionID)}/prompt`, "POST", input),
        },
      },
    }
  }
  const recordValue = (value) => (value && typeof value === "object" ? value : undefined)
  const stringValue = (value, key) => {
    const item = value?.[key]
    return typeof item === "string" && item.trim() ? item : undefined
  }
  const scheduledAccessControlProfile = (run) => {
    const accessControl = recordValue(run?.accessControl)
    const mode = stringValue(accessControl, "mode")
    if (!accessControl || (mode !== "ask" && mode !== "approve_for_me" && mode !== "full_access")) {
      return
    }
    return { mode }
  }
  const bindScheduledJobRun = (link) => ({ ...link })
  const schedulerRequest = async (path, init) => {
    const url = new URL(path, "http://plugin.invalid")
    return request({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method: init?.method ?? "GET",
      ...(init?.directory ? { directory: init.directory } : {}),
      ...(init?.body ? { body: JSON.parse(init.body) } : {}),
    })
  }
  const schedulerState = (link, body) =>
    schedulerRequest(`/scheduler/jobs/${encodeURIComponent(link.slug)}/state`, {
      directory: link.directory,
      method: "POST",
      body: JSON.stringify({ ...body, scopeId: link.scopeId, runId: link.runId }),
    })
  const schedulerStateResult = async (link, body) => {
    const response = recordValue(await schedulerState(link, body))
    const data = recordValue(response?.data)
    if (data?.ignored === true) return "ignored"
    const resultContract = stringValue(body, "resultContract")
    if (resultContract && stringValue(recordValue(data?.job), "lastRunResultContract") !== resultContract)
      return "unsupported"
    return "accepted"
  }
  const schedulerOutcome = async (link) => {
    const response = recordValue(
      await schedulerRequest(
        `/scheduler/jobs/${encodeURIComponent(link.slug)}/outcome?scopeId=${encodeURIComponent(link.scopeId)}&runId=${encodeURIComponent(link.runId)}`,
        { directory: link.directory },
      ),
    )
    const outcome = recordValue(response?.data)
    if (!outcome) throw new Error("Scheduled app job outcome could not be loaded.")
    return outcome
  }
  const schedulerJob = async (link) => {
    const body = recordValue(
      await schedulerRequest(
        `/scheduler/jobs/${encodeURIComponent(link.slug)}?scopeId=${encodeURIComponent(link.scopeId)}&workdir=${encodeURIComponent(link.directory)}`,
        { directory: link.directory },
      ),
    )
    const job = recordValue(recordValue(body?.data)?.job)
    if (!job) throw new Error("Scheduled job could not be loaded.")
    return job
  }
  const schedulerErrorStatus = (error) => {
    const value = recordValue(error)
    const data = recordValue(value?.data)
    const cause = recordValue(value?.cause)
    const response = recordValue(value?.response)
    const causeResponse = recordValue(cause?.response)
    const nestedCause = recordValue(cause?.cause)
    return [value, data, cause, response, causeResponse, nestedCause]
      .flatMap((item) => {
        if (typeof item?.status === "number") return [item.status]
        if (typeof item?.statusCode === "number") return [item.statusCode]
        return []
      })
      .at(0)
  }
  const isRetryableScheduledJobSubmissionError = (error) => {
    const status = schedulerErrorStatus(error)
    if (status !== undefined) return status === 408 || status === 425 || status === 429 || status >= 500
    const value = recordValue(error)
    const cause = recordValue(value?.cause)
    const candidates = [error, value?.data, value?.cause, value?.response, cause?.cause, cause?.response]
    const codes = new Set(["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ENETDOWN", "ENETUNREACH", "ETIMEDOUT"])
    return candidates.some((candidate) => {
      const item = recordValue(candidate)
      if (codes.has(stringValue(item, "code") ?? "")) return true
      // A truncated HTTP response cannot prove whether the idempotent prompt was admitted.
      if (candidate instanceof SyntaxError && /Failed to execute ['"]json['"] on ['"]Response['"]/.test(candidate.message)) return true
      return candidate instanceof TypeError && /fetch|network|load failed/i.test(candidate.message)
    })
  }
  const isDefinitiveSchedulerAdmissionError = (error) => {
    if (isRetryableScheduledJobSubmissionError(error)) return false
    const status = schedulerErrorStatus(error)
    return status === undefined || (status >= 400 && status < 500)
  }
  const applyScheduledSessionAccessControlProfile = async (directory, session, profile) => {
    if (!profile) return
    await api.host.sessions.accessControl.set({ directory, sessionID: session.id, mode: profile.mode })
  }
  const createScheduledSession = async (directory, sessionID, profile) => {
    const client = sessionClient(directory)
    const created = await client.v2.session
      .create({
        id: sessionID,
        location: { directory },
      })
      .then((x) => x.data?.data)
    if (!created?.id) throw new Error("Scheduled app session could not be created.")
    await applyScheduledSessionAccessControlProfile(directory, created, profile)
    return created.id
  }
  const navigateToExistingScheduledSession = async (link, directory, sessionID) => {
    const found = await sessionClient(directory)
      .session.get({ sessionID })
      .then((x) => x.data)
      .catch((error) => {
        if (schedulerErrorStatus(error) === 404) return
        throw error
      })
    if (found?.id !== sessionID) return
    api.host.navigation.openSession({ directory, sessionID })
  }
  const scheduledAppSessionStrategy = (run) => {
    if (run?.appSessionStrategy === "current") return "current"
    if (run?.appSessionStrategy === "job") return "job"
    return "new"
  }
  const scheduledSessionID = async (link, directory, job, profile) => {
    const run = recordValue(job.run)
    const strategy = scheduledAppSessionStrategy(run)
    const client = sessionClient(directory)
    const existing = stringValue(run, "appSessionID")
    if (strategy === "current") {
      if (!existing) throw new Error("Scheduled current-session job is missing its target session.")
      const found = await client.session
        .get({ sessionID: existing })
        .then((x) => x.data)
        .catch((error) => {
          if (schedulerErrorStatus(error) === 404) return
          throw error
        })
      if (!found?.id) throw new Error("Scheduled current-session job target no longer exists.")
      await applyScheduledSessionAccessControlProfile(directory, found, profile)
      return { sessionID: existing, recreated: false }
    }
    const reusable = shouldReuseScheduledJobSession({
      strategy,
      existing,
      resetHistory: run?.appResetHistory === true,
    })
    if (reusable && existing) {
      const found = await client.session
        .get({ sessionID: existing })
        .then((x) => x.data)
        .catch((error) => {
          if (schedulerErrorStatus(error) === 404) return
          throw error
        })
      if (found?.id) {
        await applyScheduledSessionAccessControlProfile(directory, found, profile)
        return { sessionID: existing, recreated: false }
      }
    }
    return {
      sessionID: await createScheduledSession(
        directory,
        await scheduledJobSessionID(link),
        profile ?? (await api.host.sessions.accessControl.get({ directory })),
      ),
      recreated: reusable,
    }
  }
  const scheduledRunKey = (link) => `${link.scopeId}\x00${link.slug}\x00${link.runId}`
  const submittedScheduledJobRuns = new Set()
  const scheduledJobSubmissionAttempts = new Map()
  const scheduledJobRetryGeneration = new Map()
  const scheduledJobSubmissionTargets = new Map()
  const trackedScheduledJobRuns = new Set()
  let scheduledJobTrackingActive = !api.lifecycle.signal.aborted
  const scheduledJobWaits = new Map()
  const waitForScheduledJobOutcome = (delay) => {
    if (!scheduledJobTrackingActive) return Promise.resolve()
    return new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer)
        scheduledJobWaits.delete(timer)
        resolve()
      }
      const timer = window.setTimeout(done, delay)
      scheduledJobWaits.set(timer, done)
    })
  }
  const stopTracking = () => {
    scheduledJobTrackingActive = false
    scheduledJobRetryGeneration.clear()
    for (const done of scheduledJobWaits.values()) done()
  }
  api.lifecycle.signal.addEventListener("abort", stopTracking, { once: true })
  api.lifecycle.onDispose(() => {
    stopTracking()
    api.lifecycle.signal.removeEventListener("abort", stopTracking)
  })
  const trackScheduledJobRun = async (input) => {
    const key = scheduledRunKey(input)
    if (trackedScheduledJobRuns.has(key)) return
    trackedScheduledJobRuns.add(key)
    let activityID
    let pollAttempt = 0
    let requestFailures = 0
    try {
      while (scheduledJobTrackingActive) {
        const result = await schedulerOutcome(input)
          .then((outcome) => ({ outcome }))
          .catch((error) => ({ error }))
        if (!scheduledJobTrackingActive) break
        if ("error" in result) {
          if (schedulerErrorStatus(result.error) === 404) break
          requestFailures += 1
          if (requestFailures === 10) {
            showToast({
              title: "Scheduled app job is still running",
              description: "Outcome checks are temporarily unavailable and will continue at a lower frequency.",
            })
          }
          await waitForScheduledJobOutcome(Math.min(300000, 1000 * 2 ** Math.min(requestFailures, 8)))
          continue
        }
        requestFailures = 0
        const outcome = result.outcome
        const status = stringValue(outcome, "status")
        const phase = stringValue(outcome, "phase")
        const nextActivityID = stringValue(outcome, "activityID")
        const polling = scheduledJobPollingState(status, nextActivityID, activityID)
        if (status === "superseded") break
        if (polling) {
          const state = await schedulerStateResult(input, {
            status: polling.status,
            appSessionID: input.sessionID,
            messageID: input.messageID,
            activityID: polling.activityID,
          }).catch(() => {
            return
          })
          if (!scheduledJobTrackingActive) break
          if (state === "ignored") break
          if (state === "accepted" && nextActivityID) activityID = nextActivityID
        }
        if (polling?.continuePolling) {
          if (status === "pending" && phase === "admission_missing") {
            const retry = await input.admit()
            if (!scheduledJobTrackingActive) break
            if (!retry.admitted && isDefinitiveSchedulerAdmissionError(retry.error)) {
              const message = errorMessage(retry.error, "Scheduled app job prompt admission failed.")
              const state = await schedulerStateResult(input, {
                status: "failed",
                appSessionID: input.sessionID,
                messageID: input.messageID,
                error: message,
              }).catch(() => {
                return
              })
              if (!scheduledJobTrackingActive) break
              if (state === "accepted") showToast({ title: "Scheduled app job failed", description: message })
              if (state === "accepted" || state === "ignored") break
            }
            if (retry.admitted) pollAttempt = 0
          }
          const delays = [1000, 2000, 5000, 1e4, 30000, 60000]
          await waitForScheduledJobOutcome(delays[Math.min(pollAttempt, delays.length - 1)])
          pollAttempt += 1
          continue
        }
        if (status === "success") {
          const state = await schedulerStateResult(input, {
            status: "success",
            appSessionID: input.sessionID,
            messageID: input.messageID,
            activityID: nextActivityID ?? activityID,
          }).catch(() => {
            return
          })
          if (!scheduledJobTrackingActive) break
          if (state === "ignored" || state === "accepted") break
          await waitForScheduledJobOutcome(2000)
          continue
        }
        if (status === "dismissed") {
          const state = await schedulerStateResult(input, {
            status: "success",
            resolution: "dismissed",
            appSessionID: input.sessionID,
            messageID: input.messageID,
            activityID: nextActivityID ?? activityID,
          }).catch(() => {
            return
          })
          if (!scheduledJobTrackingActive) break
          if (state === "ignored" || state === "accepted") break
          await waitForScheduledJobOutcome(2000)
          continue
        }
        if (status === "failed") {
          const message = stringValue(outcome, "error") ?? "Scheduled app job failed."
          const state = await schedulerStateResult(input, {
            status: "failed",
            appSessionID: input.sessionID,
            messageID: input.messageID,
            activityID: nextActivityID ?? activityID,
            error: message,
          }).catch(() => {
            return
          })
          if (!scheduledJobTrackingActive) break
          if (state === "ignored") break
          if (state === "accepted") {
            showToast({ title: "Scheduled app job failed", description: message })
            break
          }
          await waitForScheduledJobOutcome(2000)
          continue
        }
        requestFailures += 1
        await waitForScheduledJobOutcome(Math.min(300000, 1000 * 2 ** Math.min(requestFailures, 8)))
      }
    } finally {
      trackedScheduledJobRuns.delete(key)
    }
  }
  const submitScheduledJobRun = async (link) => {
    if (!scheduledJobTrackingActive) return
    const key = scheduledRunKey(link)
    let sessionID
    let messageID
    let recreatedSession = false
    try {
      const job = await schedulerJob(link)
      if (!scheduledJobTrackingActive) return
      const run = recordValue(job.run)
      const directory = stringValue(job, "workdir") ?? link.directory
      const currentRunID = stringValue(job, "lastRunRunId")
      const lastRunStatus = stringValue(job, "lastRunStatus")
      if (currentRunID !== link.runId) return
      const terminal =
        isCompletedScheduledJobRun({
          runID: link.runId,
          lastRunID: stringValue(job, "lastRunRunId"),
          lastRunStatus: stringValue(job, "lastRunStatus"),
        }) || lastRunStatus === "failed"
      if (terminal) {
        const existing = stringValue(run, "appSessionID")
        if (existing) await navigateToExistingScheduledSession(link, directory, existing)
        return
      }
      if (lastRunStatus !== "running") return
      const prompt = scheduledJobTaskPrompt(job)
      if (!prompt) throw new Error("Scheduled app job has no prompt.")
      api.host.projects.open(directory)
      const client = sessionClient(directory)
      const persistedSessionID = stringValue(job, "lastRunSessionID")
      const persistedMessageID = stringValue(job, "lastRunMessageID")
      const persistedResultContract = stringValue(job, "lastRunResultContract")
      if (!!persistedSessionID !== !!persistedMessageID) {
        throw new Error("Scheduled app job has incomplete recovery metadata.")
      }
      if (persistedResultContract && persistedResultContract !== resultContractMarker) {
        throw new Error(`Unsupported scheduled job result contract: ${persistedResultContract}`)
      }
      if (persistedSessionID && persistedMessageID) {
        const found = await client.session
          .get({ sessionID: persistedSessionID })
          .then((x) => x.data)
          .catch((error) => {
            if (schedulerErrorStatus(error) === 404) return
            throw error
          })
        if (!found?.id) {
          if (scheduledAppSessionStrategy(run) !== "job") {
            throw new Error("Scheduled app job target session no longer exists.")
          }
          await createScheduledSession(
            directory,
            persistedSessionID,
            scheduledAccessControlProfile(run) ?? (await api.host.sessions.accessControl.get({ directory })),
          )
          recreatedSession = true
        }
        if (found?.id) {
          await applyScheduledSessionAccessControlProfile(directory, found, scheduledAccessControlProfile(run))
        }
        sessionID = persistedSessionID
        messageID = persistedMessageID
      } else if (scheduledJobSubmissionTargets.has(key)) {
        const target = scheduledJobSubmissionTargets.get(key)
        sessionID = target.sessionID
        messageID = target.messageID
      } else {
        const target = await scheduledSessionID(link, directory, job, scheduledAccessControlProfile(run))
        sessionID = target.sessionID
        recreatedSession = target.recreated
        messageID = await scheduledJobMessageID(link)
        scheduledJobSubmissionTargets.set(key, { sessionID, messageID })
      }
      const model = scheduledJobModelSelection(run, api.ui.models.resolve)
      if (!sessionID || !messageID) throw new Error("Scheduled app job recovery metadata is incomplete.")
      if (!scheduledJobTrackingActive) return
      const targetSessionID = sessionID
      const targetMessageID = messageID
      const resultContract = persistedSessionID && !persistedResultContract ? undefined : resultContractMarker
      const state = await schedulerStateResult(link, {
        status: "running",
        appSessionID: targetSessionID,
        messageID: targetMessageID,
        submittedAt: Date.now(),
        ...(resultContract ? { resultContract } : {}),
      })
      if (!scheduledJobTrackingActive) return
      if (state === "ignored") return
      if (state === "unsupported") {
        throw new Error("Connected OpenCode server does not support reliable scheduled job results.")
      }
      if (recreatedSession) {
        showToast({
          title: "Scheduled app session recreated",
          description: `${stringValue(job, "name") ?? link.slug} lost its target session. A replacement session was created.`,
        })
      }
      scheduledJobSubmissionTargets.delete(key)
      const admit = () =>
        client.v2.session
          .prompt({
            sessionID: targetSessionID,
            id: targetMessageID,
            agent: stringValue(run, "agent"),
            model,
            delivery: "steer",
            prompt: { text: resultContract ? scheduledJobPrompt(prompt) : prompt },
          })
          .then(() => ({ admitted: true }))
          .catch((error) => ({ admitted: false, error }))
      const promptResult = await admit()
      if (!scheduledJobTrackingActive) return
      api.host.navigation.openSession({ directory, sessionID: targetSessionID })
      if (!promptResult.admitted && isDefinitiveSchedulerAdmissionError(promptResult.error)) {
        const message = errorMessage(promptResult.error, "Scheduled app job prompt admission failed.")
        const failed = await schedulerStateResult(link, {
          status: "failed",
          appSessionID: targetSessionID,
          messageID: targetMessageID,
          error: message,
        }).catch(() => {
          return
        })
        if (!scheduledJobTrackingActive) return
        if (failed === "ignored") return
        if (failed === "accepted") {
          showToast({ title: "Scheduled app job failed", description: message })
          return
        }
      }
      trackScheduledJobRun({
        ...link,
        directory,
        sessionID: targetSessionID,
        messageID: targetMessageID,
        admit,
      })
    } catch (error) {
      if (!scheduledJobTrackingActive) return
      if (isRetryableScheduledJobSubmissionError(error)) return "retry"
      const message = errorMessage(error, "Scheduled app job failed.")
      const result = await schedulerStateResult(link, {
        status: "failed",
        appSessionID: sessionID,
        messageID,
        error: message,
      })
        .then((state) => ({ state }))
        .catch((stateError) => ({ stateError }))
      if ("stateError" in result) {
        if (!scheduledJobTrackingActive) return
        if (isRetryableScheduledJobSubmissionError(result.stateError)) return "retry"
        return
      }
      if (!scheduledJobTrackingActive) return
      if (result.state === undefined) return "retry"
      if (result.state === "accepted") showToast({ title: "Scheduled app job failed", description: message })
    }
  }
  const enqueueScheduledJobRun = (link) => {
    if (!scheduledJobTrackingActive) return
    const key = scheduledRunKey(link)
    if (submittedScheduledJobRuns.has(key) || trackedScheduledJobRuns.has(key)) return
    const generation = (scheduledJobRetryGeneration.get(key) ?? 0) + 1
    scheduledJobRetryGeneration.set(key, generation)
    submittedScheduledJobRuns.add(key)
    submitScheduledJobRun(link)
      .then((result) => {
        if (result !== "retry") {
          scheduledJobSubmissionAttempts.delete(key)
          scheduledJobSubmissionTargets.delete(key)
          scheduledJobRetryGeneration.delete(key)
          return
        }
        const attempts = (scheduledJobSubmissionAttempts.get(key) ?? 0) + 1
        scheduledJobSubmissionAttempts.set(key, attempts)
        waitForScheduledJobOutcome(Math.min(300000, 1000 * 2 ** Math.min(attempts - 1, 8))).then(() => {
          if (scheduledJobTrackingActive && scheduledJobRetryGeneration.get(key) === generation)
            enqueueScheduledJobRun(link)
        })
      })
      .finally(() => {
        submittedScheduledJobRuns.delete(key)
      })
  }
  const resumeScheduledJobRuns = async () => {
    const response = recordValue(await schedulerRequest("/scheduler/jobs?allScopes=true&includeLegacy=false"))
    if (!scheduledJobTrackingActive) return
    const jobs = recordValue(response?.data)?.jobs
    if (!Array.isArray(jobs)) return
    for (const value of jobs) {
      const job = recordValue(value)
      const run = recordValue(job?.run)
      if (!job || !run || job.lastRunStatus !== "running" || run.runTarget !== "app") continue
      const directory = stringValue(job, "workdir")
      const scopeId = stringValue(job, "scopeId")
      const slug = stringValue(job, "slug")
      const runId = stringValue(job, "lastRunRunId")
      if (!directory || !scopeId || !slug || !runId) continue
      enqueueScheduledJobRun(bindScheduledJobRun({ directory, scopeId, slug, runId }))
    }
  }
  const reconcileScheduledJobRuns = async () => {
    let attempt = 0
    while (scheduledJobTrackingActive) {
      const result = await resumeScheduledJobRuns()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error }))
      if (result.ok || !isRetryableScheduledJobSubmissionError(result.error)) return
      await waitForScheduledJobOutcome(Math.min(300000, 1000 * 2 ** Math.min(attempt, 8)))
      attempt += 1
    }
  }
  return {
    async handle(context) {
      const data = context.payload
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.scopeId !== "string" ||
        !data.scopeId ||
        typeof data.slug !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(data.slug) ||
        typeof data.runId !== "string" ||
        !/^[a-z0-9_-]{1,128}$/i.test(data.runId)
      )
        throw new Error("Invalid scheduled app handoff")
      enqueueScheduledJobRun(
        bindScheduledJobRun({
          directory: context.directory,
          scopeId: data.scopeId,
          slug: data.slug,
          runId: data.runId,
        }),
      )
    },
    resume: reconcileScheduledJobRuns,
  }
}
