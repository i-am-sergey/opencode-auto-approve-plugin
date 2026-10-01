import { constants } from "node:fs"
import { createHmac, randomBytes } from "node:crypto"
import { mkdir, open } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const TRACE_PATH = join(homedir(), ".local", "share", "opencode", "auto-approve-trace.jsonl")
export const REVIEW_INPUT_PATH = join(homedir(), ".local", "share", "opencode", "auto-approve-review-input.json")
const MAX_TRACE_BYTES = 65_536
const MAX_REVIEW_INPUT_BYTES = 32_768
const MAX_REVIEWER_REASON_BYTES = 240

// Callers supply only static stage names and controlled categories. The only
// untrusted text accepted here is a parsed reviewer justification, sanitized below.
// Never pass requests, prompts, IDs, resources, or raw model responses.
export type TraceStage =
  | "setup" | "hook-ready" | "prompt-valid" | "prompt-invalid"
  | "subscribe" | "stream-error" | "ask" | "ask-invalid" | "context-missing"
  | "queued" | "skipped" | "request-found" | "tool-verified" | "generate" | "generate-error"
  | "decision-approve" | "decision-abstain" | "decision-invalid"
  | "reply-once" | "reply-error" | "resolution" | "review-canceled" | "review-input-captured" | "cleanup"

export type TraceReason =
  | "disabled" | "configuration" | "oversized" | "blank" | "unavailable"
  | "ineligible" | "changed" | "resolved" | "queue-full" | "duplicate"
  | "aborted" | "timeout" | "model-selection" | "external-resolution" | "self-resolution" | "origin-unknown" | "other"

export type AbstainCategory = "safety" | "insufficient-context" | "uncertain" | "scope" | "other"
declare const traceTokenBrand: unique symbol
type TraceToken = string & { readonly [traceTokenBrand]: true }

// Heuristic only; this is not the reviewer's actual explanation.
export function abstainCategory(justification: string): AbstainCategory {
  const text = justification.toLowerCase()
  if (/\b(?:unsafe|dangerous|destructive|harmful|risky|risk)\b/.test(text)) return "safety"
  if (/\b(?:insufficient|missing|lack(?:ing)?|not enough)\b.*\b(?:context|information|details|evidence)\b/.test(text)
    || /\b(?:context|information|details|evidence)\b.*\b(?:insufficient|missing|lack(?:ing)?)\b/.test(text)) return "insufficient-context"
  if (/\b(?:uncertain|unclear|ambiguous|cannot determine|can't determine|not clearly safe)\b/.test(text)) return "uncertain"
  if (/\b(?:scope|permission|authorization|broader|too broad)\b/.test(text)) return "scope"
  return "other"
}

// A short diagnostic excerpt, not a lossless copy of the reviewer response.
// Free text cannot be proven free of secrets; redact common echoes and keep it
// exclusively in the opt-in, owner-only trace. Never log the full model response.
export function reviewerReason(justification: string): string {
  const redacted = justification
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/(?:https?:\/\/|file:\/\/|www\.)[^\s,;)}\]]+/gi, "[url]")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/(?:"(?:[^"\\]|\\.)*"|`[^`]*`|'[^']*')/g, "[quoted]")
    .replace(/\b((?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(?:\b[A-Za-z]:\\|~\/|(?<![\w/])\/)[^\s,;)}\]]+/g, "[path]")
    .replace(/\b(?:sk-|gh[pousr]_|AKIA)[A-Za-z0-9_/-]+\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_+/-]{24,}={0,2}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
  let excerpt = ""
  for (const character of redacted) {
    if (Buffer.byteLength(excerpt + character, "utf8") > MAX_REVIEWER_REASON_BYTES) break
    excerpt += character
  }
  return excerpt || "[redacted]"
}

export function errorCategory(error: unknown): TraceReason {
  if (!(error instanceof Error)) return "other"
  if (error.name === "Generate.ModelSelectionError") return "model-selection"
  if (error.name === "AbortError" || error.message === "Review aborted") return "aborted"
  return "other"
}

// OpenCode does not identify the actor on permission.replied. A successful
// reply from us is attributable to this instance; an in-flight call is not.
export function resolutionCategory(replySucceeded: boolean, replyInFlight: boolean): TraceReason {
  return replySucceeded ? "self-resolution" : replyInFlight ? "origin-unknown" : "external-resolution"
}

// Deliberately separate from the routine trace: this is the exact, potentially
// sensitive prompt sent to the reviewer. An explicit additional opt-in captures
// at most one bounded input, never appending or replacing an existing capture.
export async function captureReviewInput(enabled: boolean, prompt: string, path = REVIEW_INPUT_PATH): Promise<boolean> {
  if (!enabled || typeof prompt !== "string") return false
  const line = JSON.stringify({ at: new Date().toISOString(), input: prompt }) + "\n"
  if (Buffer.byteLength(line, "utf8") > MAX_REVIEW_INPUT_BYTES) return false
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const stats = await file.stat()
      if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid?.()
        || (stats.mode & 0o077) !== 0) return false
      await file.writeFile(line)
      return true
    } finally {
      await file.close()
    }
  } catch {
    // Capture is best-effort and must never change permission handling.
    return false
  }
}

export function createTrace(enabled: boolean, path = TRACE_PATH) {
  let pending = Promise.resolve()
  const key = enabled ? randomBytes(32) : undefined
  const instance = enabled ? randomBytes(8).toString("hex") : undefined
  const token = (kind: "session" | "request", value: string): TraceToken | undefined => key
    ? createHmac("sha256", key).update(kind).update("\0").update(value).digest("hex").slice(0, 16) as TraceToken
    : undefined
  const session = (sessionID: string) => token("session", sessionID)
  const request = (sessionID: string, requestID: string) => token("request", `${sessionID.length}:${sessionID}${requestID}`)
  const record = (stage: TraceStage, reason?: TraceReason, ids?: {
    session?: TraceToken; request?: TraceToken; abstain?: AbstainCategory; reviewerJustification?: string
  }) => {
    if (!enabled) return
    // Tokens are generated by this trace instance, not copied from an event payload.
    const line = JSON.stringify({ at: new Date().toISOString(), instance, stage,
      ...(reason ? { reason } : {}), ...(ids?.session ? { session: ids.session } : {}),
      ...(ids?.request ? { request: ids.request } : {}),
      ...(ids?.abstain ? { abstain: ids.abstain } : {}),
      ...(stage === "decision-abstain" && ids?.reviewerJustification
        ? { reviewerReason: reviewerReason(ids.reviewerJustification) } : {}),
    }) + "\n"
    pending = pending.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
        try {
          const stats = await file.stat()
          if (!stats.isFile() || stats.nlink !== 1 || stats.uid !== process.getuid?.()
            || (stats.mode & 0o077) !== 0 || stats.size + Buffer.byteLength(line) > MAX_TRACE_BYTES) return
          await file.writeFile(line)
        } finally {
          await file.close()
        }
      } catch {
        // Diagnostics are best-effort and must never change permission handling.
      }
    }).catch(() => {})
  }
  return { record, session, request, flush: () => pending }
}
