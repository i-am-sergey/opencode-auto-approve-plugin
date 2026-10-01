import { Plugin } from "@opencode/plugin"
import type { PermissionRequest } from "@opencode/client"
import { abstainCategory, captureReviewInput, createTrace, errorCategory, resolutionCategory } from "./diagnostics.ts"
import type { PermissionReviewRequest } from "./policy.ts"
import { AutoApproveNotifications } from "./rpc.ts"
import { PromptCache, MAX_USER_PROMPT_BYTES } from "./policy.ts"
import {
  buildReviewPrompt,
  isEligible,
  parseOptions,
  parseReviewDecision,
  reviewInputWithinLimit,
  reviewInputWithinLimitWithContext,
  verifiedExternalReadTarget,
} from "./policy.ts"

type RequestRef = { sessionID: string; requestID: string }
type PromptSnapshot = { messageID: string; text: string }
type Job = RequestRef & { controller: AbortController; state: "queued" | "running"; snapshot: PromptSnapshot }

const MAX_QUEUED_REQUESTS = 128
const MAX_HANDLED_REQUESTS = 4_096
const MAX_REPLY_MARKERS = 4_096
const MAX_SESSION_ID_LENGTH = 256
const RECONNECT_DELAY_MS = 1_000
const RETRY_COUNT = 1

function requestKey(ref: RequestRef): string {
  return `${ref.sessionID}\u0000${ref.requestID}`
}

function sameReviewedRequest(current: PermissionRequest, reviewed: PermissionRequest): boolean {
  return current.id === reviewed.id
    && current.sessionID === reviewed.sessionID
    && current.action === reviewed.action
    && JSON.stringify(current.resources) === JSON.stringify(reviewed.resources)
    && JSON.stringify(current.source) === JSON.stringify(reviewed.source)
}

function requestFromUnknown(value: unknown): PermissionReviewRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const request = value as Record<string, unknown>
  if (typeof request.id !== "string"
    || typeof request.sessionID !== "string"
    || typeof request.action !== "string"
    || request.id.length === 0
    || request.id.length > 256
    || request.sessionID.length === 0
    || request.sessionID.length > MAX_SESSION_ID_LENGTH
    || request.action.length === 0
    || request.action.length > 100
    || !Array.isArray(request.resources)
    || request.resources.length === 0
    || request.resources.length > 64
    || !request.resources.every((resource) => typeof resource === "string" && resource.length <= 4_096)) return undefined
  return {
    id: request.id,
    sessionID: request.sessionID,
    action: request.action,
    resources: request.resources,
  }
}

// Validate a user prompt snapshot (both messageID and text must be valid)
function isValidUserSnapshot(snapshot: { messageID: string; text: string }): boolean {
  if (typeof snapshot.messageID !== "string" || snapshot.messageID.length === 0) return false
  if (typeof snapshot.text !== "string") return false
  if (snapshot.text.trim().length === 0) return false
  const byteLength = Buffer.byteLength(snapshot.text, "utf8")
  return byteLength > 0 && byteLength <= 2_048
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

export default Plugin.define({
  id: "opencode-auto-approve",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const trace = createTrace(options.diagnostics)
    const traceSession = (sessionID: string) => ({ session: trace.session(sessionID) })
    const traceRequest = (ref: RequestRef) => ({
      session: trace.session(ref.sessionID),
      request: trace.request(ref.sessionID, ref.requestID),
    })
    if (!options.enabled) {
      trace.record("setup", "disabled")
      console.info("[auto-approve] disabled; no permission requests will be reviewed")
      return
    }
    if (!options.model || options.actions.size === 0) {
      trace.record("setup", "configuration")
      console.warn("[auto-approve] enabled without a valid reviewer model and explicit action allowlist; staying disabled")
      return
    }
    trace.record("setup")

    let notifications: { events: { emit: (name: "status", data: { sessionID: string; status: "reviewing" | "approved" | "abstained" | "external-resolution" }) => Promise<void> }; dispose: () => Promise<void> } | undefined
    try {
      notifications = await ctx.rpc.register(AutoApproveNotifications, {})
    } catch {
      // Permission review works even when RPC registration is unavailable.
    }
    const notify = (sessionID: string, status: "reviewing" | "approved" | "abstained" | "external-resolution") => {
      // Notifications are best-effort and must never hold up or change permission handling.
      try {
        void notifications?.events.emit("status", { sessionID, status }).catch(() => {})
      } catch {
        // An unavailable TUI/event stream must not affect the reviewer.
      }
    }

    console.info(
      `[auto-approve] active; model=${options.model.providerID}/${options.model.id}; actions=${options.actions.size}; wildcard=${options.actions.has("*")}`,
    )

    const lifetime = new AbortController()
    const jobs = new Map<string, Job>()
    const handled = new Set<string>()
    const replying = new Set<string>()
    const repliedByPlugin = new Set<string>()
    const replyEventDuringCall = new Set<string>()
    const generating = new Set<string>()
    const queue: Job[] = []
    let workers = 0

    // Create a per-plugin-instance prompt cache (bounded).
    const promptCache = new PromptCache()

    // NOTE: We NO LONGER persist/load known sessions or perform reconciliation.
    // Reason: Permission requests have no messageID, so we cannot safely bind
    // them to a prompt snapshot. Reconciliation would use the current cache snapshot
    // which may differ from what was active when the permission was actually asked.
    // All requests must come from live permission.asked events where we capture
    // the snapshot at that moment. Requests found via reconciliation remain manual.

    const currentRequest = async (ref: RequestRef) => {
      try {
        return await ctx.permission.get(ref)
      } catch {
        trace.record("skipped", "unavailable", traceRequest(ref))
        return undefined
      }
    }

    const generateWithTimeout = async (prompt: string, job: Job) => {
      const controller = new AbortController()
      const abortFromJob = () => controller.abort()
      job.controller.signal.addEventListener("abort", abortFromJob, { once: true })
      const timer = setTimeout(() => controller.abort(), options.timeoutMs)
      let abortReview: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        abortReview = () => reject(new Error("Review aborted"))
        if (controller.signal.aborted) abortReview()
        else controller.signal.addEventListener("abort", abortReview, { once: true })
      })
      try {
        const result = await Promise.race([
          ctx.generate.text({ prompt, model: options.model }, { signal: controller.signal }),
          aborted,
        ])
        if (controller.signal.aborted) throw new Error("Review aborted")
        return result
      } finally {
        clearTimeout(timer)
        job.controller.signal.removeEventListener("abort", abortFromJob)
        if (abortReview) controller.signal.removeEventListener("abort", abortReview)
      }
    }

    const review = async (job: Job) => {
      const ref = { sessionID: job.sessionID, requestID: job.requestID }
      const correlation = traceRequest(ref)
      const first = await currentRequest(ref)
      if (!first || first.id !== job.requestID || first.sessionID !== job.sessionID) {
        trace.record("skipped", "resolved", correlation)
        return
      }
      trace.record("request-found", undefined, correlation)
      const reviewRequest = {
        id: first.id,
        sessionID: first.sessionID,
        action: first.action,
        resources: first.resources,
      }
      if (!isEligible(reviewRequest, options)) {
        trace.record("skipped", "ineligible", correlation)
        return
      }

      // The snapshot is stored directly on the job from enqueue time
      // This is an immutable snapshot that was captured when the request was queued
      const expectedSnapshot = job.snapshot

      // Verify the cached snapshot still matches the expected snapshot
      // Both messageID and text must match exactly
      const cached = promptCache.getSnapshot(job.sessionID)
      if (!cached || cached.messageID !== expectedSnapshot.messageID || cached.text !== expectedSnapshot.text) {
        trace.record("skipped", "changed", correlation)
        console.warn("[auto-approve] prompt snapshot changed after enqueue; context invalid", ref.sessionID, ref.requestID)
        return
      }

      const cachedText = cached.text
      let verifiedReadTarget: string | undefined
      if (first.action === "external_directory") {
        try {
          verifiedReadTarget = verifiedExternalReadTarget(first, await ctx.session.context({ sessionID: ref.sessionID }))
        } catch {
          // The missing session context cannot establish which file caused this boundary check.
        }
        if (!verifiedReadTarget) {
          trace.record("skipped", "unavailable", correlation)
          console.info("[auto-approve] external directory request has no verified running read target; remains pending", ref.sessionID, ref.requestID)
          return
        }
        trace.record("tool-verified", undefined, correlation)
      }
      if (!reviewInputWithinLimitWithContext(reviewRequest, options.maxInputBytes, cachedText, verifiedReadTarget)) {
        trace.record("skipped", "oversized", correlation)
        console.warn("[auto-approve] request with context exceeds review input limit; remains pending", ref.sessionID, ref.requestID)
        return
      }

      const reviewerPrompt = buildReviewPrompt(reviewRequest, cachedText, verifiedReadTarget)
      let result: Awaited<ReturnType<typeof ctx.generate.text>> | undefined
      for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
        if (job.controller.signal.aborted) {
          trace.record("skipped", "aborted", correlation)
          return
        }
        try {
          if (attempt === 0 && await captureReviewInput(options.captureReviewerInput, reviewerPrompt)) {
            trace.record("review-input-captured", undefined, correlation)
          }
          trace.record("generate", undefined, correlation)
          if (attempt === 0) notify(ref.sessionID, "reviewing")
          generating.add(requestKey(ref))
          try {
            result = await generateWithTimeout(reviewerPrompt, job)
          } finally {
            generating.delete(requestKey(ref))
          }
          break
        } catch (error) {
          trace.record("generate-error", errorCategory(error), correlation)
          if (job.controller.signal.aborted || attempt === RETRY_COUNT) {
            console.warn("[auto-approve] reviewer unavailable or timed out; request remains pending", ref.sessionID, ref.requestID)
            return
          }
          // Before retry, verify context hasn't changed (newer prompt sent)
          const newCached = promptCache.getSnapshot(job.sessionID)
          if (!newCached) {
            trace.record("skipped", "unavailable", correlation)
            console.info("[auto-approve] prompt context cleared during review; skipping reply", ref.sessionID, ref.requestID)
            return
          }
          // Verify messageID and text haven't changed
          if (newCached.messageID !== expectedSnapshot.messageID || newCached.text !== expectedSnapshot.text) {
            trace.record("skipped", "changed", correlation)
            console.info("[auto-approve] prompt context changed during review; skipping reply", ref.sessionID, ref.requestID)
            return
          }
          const stillPending = await currentRequest(ref)
          if (!stillPending || !sameReviewedRequest(stillPending, first)) {
            trace.record("skipped", "resolved", correlation)
            return
          }
          await sleep(options.retryDelayMs, job.controller.signal)
        }
      }
      if (!result || job.controller.signal.aborted) {
        trace.record("skipped", "aborted", correlation)
        return
      }

      // Immediately before reply, verify context still matches exactly
      const finalCached = promptCache.getSnapshot(job.sessionID)
      if (!finalCached) {
        trace.record("skipped", "unavailable", correlation)
        console.info("[auto-approve] prompt context unavailable before reply; skipping approval", ref.sessionID, ref.requestID)
        return
      }
      if (finalCached.messageID !== expectedSnapshot.messageID || finalCached.text !== expectedSnapshot.text) {
        trace.record("skipped", "changed", correlation)
        console.info("[auto-approve] prompt context changed before reply; skipping approval", ref.sessionID, ref.requestID)
        return
      }

      const decision = parseReviewDecision(result.text)
      if (!decision) {
        trace.record("decision-invalid", undefined, correlation)
        console.warn("[auto-approve] invalid reviewer response; request remains pending", ref.sessionID, ref.requestID)
        return
      }
      if (decision.decision !== "approve") {
        trace.record("decision-abstain", undefined, {
          ...correlation,
          abstain: abstainCategory(decision.justification),
          reviewerJustification: decision.justification,
        })
        console.info("[auto-approve] reviewer abstained; request remains pending", ref.sessionID, ref.requestID)
        notify(ref.sessionID, "abstained")
        return
      }
      trace.record("decision-approve", undefined, correlation)

      const current = await currentRequest(ref)
      if (!current || !sameReviewedRequest(current, first) || job.controller.signal.aborted) {
        trace.record("skipped", "resolved", correlation)
        console.info("[auto-approve] request changed or resolved during review; skipping reply", ref.sessionID, ref.requestID)
        return
      }
      if (verifiedReadTarget) {
        try {
          if (verifiedExternalReadTarget(current, await ctx.session.context({ sessionID: ref.sessionID })) !== verifiedReadTarget) {
            trace.record("skipped", "changed", correlation)
            return
          }
        } catch {
          trace.record("skipped", "unavailable", correlation)
          return
        }
      }
      try {
        const key = requestKey(ref)
        replying.add(key)
        await ctx.permission.reply({ ...ref, decision: "once" })
        // Retain the successful reply only if its event has not arrived yet.
        if (!replyEventDuringCall.has(key)) {
          repliedByPlugin.add(key)
          if (repliedByPlugin.size > MAX_REPLY_MARKERS) {
            const oldest = repliedByPlugin.values().next().value
            if (oldest !== undefined) repliedByPlugin.delete(oldest)
          }
        }
        trace.record("reply-once", undefined, correlation)
        notify(ref.sessionID, "approved")
        console.info("[auto-approve] approved request once", ref.sessionID, ref.requestID)
      } catch {
        trace.record("reply-error", undefined, correlation)
        console.warn("[auto-approve] permission reply failed; request remains for manual handling", ref.sessionID, ref.requestID)
      } finally {
        const key = requestKey(ref)
        replying.delete(key)
        replyEventDuringCall.delete(key)
      }
    }

    function pump() {
      while (!lifetime.signal.aborted && workers < options.maxConcurrentReviews && queue.length > 0) {
        const job = queue.shift()!
        if (job.controller.signal.aborted || jobs.get(requestKey(job)) !== job) continue
        job.state = "running"
        workers++
        void review(job).catch(() => {
          trace.record("skipped", "other", traceRequest(job))
          console.warn("[auto-approve] unexpected review error; request remains pending", job.sessionID, job.requestID)
        }).finally(() => {
          workers--
          if (jobs.get(requestKey(job)) === job) jobs.delete(requestKey(job))
          pump()
        })
      }
    }

    const stopJob = (sessionID: string, requestID: string) => {
      const key = requestKey({ sessionID, requestID })
      handled.delete(key)
      const job = jobs.get(key)
      if (!job) return
      if (job.state === "running" && generating.has(key)) {
        trace.record("review-canceled", resolutionCategory(repliedByPlugin.has(key), replying.has(key)), traceRequest(job))
        if (!replying.has(key) && !repliedByPlugin.has(key)) notify(sessionID, "external-resolution")
      }
      job.controller.abort()
      jobs.delete(key)
      if (job.state === "queued") {
        const index = queue.indexOf(job)
        if (index >= 0) queue.splice(index, 1)
      }
    }

    // Enqueue a request with its captured prompt snapshot.
    // The snapshot is captured at permission.asked time and stored immutably on the Job.
    // This function requires a snapshot argument - it does NOT look up the snapshot itself.
    const enqueue = (request: PermissionReviewRequest, snapshot: PromptSnapshot) => {
      const correlation = traceRequest({ sessionID: request.sessionID, requestID: request.id })
      if (!isEligible(request, options)) {
        trace.record("skipped", "ineligible", correlation)
        return
      }
      if (!reviewInputWithinLimit(request, options.maxInputBytes)) {
        trace.record("skipped", "oversized", correlation)
        console.warn("[auto-approve] request exceeds review input limit; remains pending", request.sessionID, request.id)
        return
      }
      const ref = { sessionID: request.sessionID, requestID: request.id }
      const key = requestKey(ref)
      if (jobs.has(key) || handled.has(key)) {
        trace.record("skipped", "duplicate", correlation)
        return
      }
      if (queue.length >= MAX_QUEUED_REQUESTS) {
        trace.record("skipped", "queue-full", correlation)
        console.warn("[auto-approve] review queue full; request remains pending", ref.sessionID, ref.requestID)
        return
      }
      if (handled.size >= MAX_HANDLED_REQUESTS) {
        trace.record("skipped", "queue-full", correlation)
        console.warn("[auto-approve] handled-request limit reached; request remains pending", ref.sessionID, ref.requestID)
        return
      }

      // Validate the snapshot is valid and within limits
      if (!isValidUserSnapshot(snapshot)) {
        trace.record("skipped", "unavailable", correlation)
        console.warn("[auto-approve] snapshot invalid; leaving ask pending", ref.sessionID)
        return
      }

      // Validate the full prompt budget including user text before queuing
      if (!reviewInputWithinLimitWithContext(request, options.maxInputBytes, snapshot.text)) {
        trace.record("skipped", "oversized", correlation)
        console.warn("[auto-approve] request with context exceeds review input limit; remains pending", ref.sessionID, ref.requestID)
        return
      }

      const job: Job = { ...ref, controller: new AbortController(), state: "queued", snapshot }
      jobs.set(key, job)
      handled.add(key)
      queue.push(job)
      trace.record("queued", undefined, correlation)

      pump()
    }

    const consume = async () => {
      let backoff = RECONNECT_DELAY_MS
      while (!lifetime.signal.aborted) {
        let sawConnected = false
        try {
          trace.record("subscribe")
          console.info("[auto-approve] subscribing to server events")
          for await (const event of ctx.event.subscribe({ signal: lifetime.signal })) {
            if (event.type === "server.connected") {
              if (sawConnected) continue
              sawConnected = true
              backoff = RECONNECT_DELAY_MS
              // No reconciliation - only live events
            } else if (event.type === "permission.asked") {
              const data = event.data
              const correlation = data !== null && typeof data === "object"
                && typeof data.sessionID === "string" && typeof data.id === "string"
                ? traceRequest({ sessionID: data.sessionID, requestID: data.id }) : undefined
              trace.record("ask", undefined, correlation)
              console.info("[auto-approve] received permission.asked")
              const request = requestFromUnknown(event.data)
              if (!request) {
                trace.record("ask-invalid", undefined, correlation)
                console.warn("[auto-approve] malformed permission event; leaving request for manual approval")
                continue
              }
              console.info(`[auto-approve] permission action=${request.action}`)
              // Capture the snapshot from cache at the exact moment the permission is asked
              const snapshot = promptCache.getSnapshot(request.sessionID)
              if (!snapshot || !isValidUserSnapshot(snapshot)) {
                trace.record("context-missing", undefined, correlation)
                console.warn("[auto-approve] permission.asked: no valid snapshot for session; request remains manual", request.sessionID, request.id)
                continue
              }

              // Enqueue with the captured snapshot - this binds the request to the prompt at ask time
              enqueue(request, snapshot)
            } else if (event.type === "permission.replied") {
              const { sessionID, requestID } = event.data
              if (typeof sessionID === "string" && sessionID.length > 0 && sessionID.length <= MAX_SESSION_ID_LENGTH
                && typeof requestID === "string" && requestID.length > 0 && requestID.length <= 256) {
                const ref = { sessionID, requestID }
                // The event does not identify the actor. Without an in-flight reply from
                // this plugin, we can say only that another actor resolved the request.
                const key = requestKey(ref)
                if (replying.has(key)) replyEventDuringCall.add(key)
                trace.record("resolution", resolutionCategory(repliedByPlugin.has(key), replying.has(key)), traceRequest(ref))
                repliedByPlugin.delete(key)
                stopJob(sessionID, requestID)
              }
            }
          }

        } catch {
          if (!lifetime.signal.aborted) trace.record("stream-error")
          if (!lifetime.signal.aborted) console.warn("[auto-approve] event stream ended; reconnecting")
        }
        if (lifetime.signal.aborted) break
        await sleep(backoff, lifetime.signal)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }

    // Register prompt hook to capture user intent BEFORE event consumption begins
    // Uses ctx.session.hook("prompt", callback) which provides SessionPrompt
    // We capture ONLY the text, sessionID, and messageID - ignore all other content
    const promptHookRegistration = ctx.session.hook("prompt", async (input) => {
      // input: SessionPrompt contains sessionID, messageID, prompt (with text), files, metadata, delivery
      // We capture ONLY prompt.text
      if (!input.prompt || typeof input.prompt.text !== "string") {
        trace.record("prompt-invalid", "unavailable", traceSession(input.sessionID))
        // No valid prompt text - invalidate any existing snapshot for this session
        promptCache.invalidateSession(input.sessionID)
        return
      }

      const text = input.prompt.text
      const byteLength = Buffer.byteLength(text, "utf8")

      // Validate: non-blank and within byte limit
      if (byteLength === 0 || byteLength > MAX_USER_PROMPT_BYTES) {
        trace.record("prompt-invalid", byteLength > MAX_USER_PROMPT_BYTES ? "oversized" : "blank", traceSession(input.sessionID))
        // Invalid text: overwrite/invalidate prior snapshot for this session
        promptCache.invalidateSession(input.sessionID)
        console.warn("[auto-approve] user prompt exceeds 2048 byte limit; context invalidated", input.sessionID, input.messageID)
        return
      }

      // Store the new snapshot (overwrites any prior snapshot for this session)
      if (!promptCache.storeSnapshot(input.sessionID, input.messageID, text)) {
        trace.record("prompt-invalid", text.trim().length === 0 ? "blank" : "unavailable", traceSession(input.sessionID))
        console.warn("[auto-approve] prompt cache full; context not captured", input.sessionID, input.messageID)
        return
      }

      console.debug("[auto-approve] captured prompt context", input.sessionID, input.messageID, `bytes=${byteLength}`)
      trace.record("prompt-valid", undefined, traceSession(input.sessionID))
    })

    // Wait for prompt hook registration to complete before starting event consumption
    // This ensures we don't miss any prompts before the hook is active
    const promptRegistration = await promptHookRegistration
    trace.record("hook-ready")

    void consume()
    return async () => {
      trace.record("cleanup")
      lifetime.abort()
      try {
        await notifications?.dispose()
      } catch {
        // Still dispose the prompt hook and abort jobs when RPC cleanup fails.
      }
      // Await hook registration and dispose its returned Registration
      try {
        if (promptRegistration && typeof promptRegistration.dispose === "function") {
          await promptRegistration.dispose()
        }
      } catch {
        // Ignore dispose errors - still proceed with cleanup
      }
      // Clear the prompt cache
      promptCache.clear()
      for (const job of jobs.values()) job.controller.abort()
      jobs.clear()
      handled.clear()
      replying.clear()
      repliedByPlugin.clear()
      replyEventDuringCall.clear()
      generating.clear()
      queue.length = 0
      await trace.flush()
    }
  },
})
