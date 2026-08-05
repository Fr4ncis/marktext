import type { AIErrorKind, AIErrorPayload } from '../../shared/types/ai'

// Provider failures arrive in three shapes — an Anthropic SDK error, a non-2xx
// fetch Response, and a thrown network/abort error — and the renderer should
// not have to tell them apart. Everything funnels through here into an
// AIErrorPayload whose `kind` drives the message the user actually sees.

/** Maps an HTTP status onto the error kind the UI branches on. */
export const kindFromStatus = (status: number): AIErrorKind => {
  if (status === 401 || status === 403) return 'authentication'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'provider-unavailable'
  if (status >= 400) return 'invalid-request'
  return 'unknown'
}

export const aiError = (
  kind: AIErrorKind,
  message: string,
  status?: number
): AIErrorPayload => ({ kind, message, status })

/**
 * Classifies a thrown value that never reached a response — DNS failure, a
 * refused connection (LM Studio not running), or an abort.
 *
 * `AbortError` covers both the timeout signal and an explicit user cancel; both
 * mean "no result, and the user does not need an error dialog".
 */
export const classifyThrown = (error: unknown): AIErrorPayload => {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return aiError('aborted', 'The request was cancelled or timed out.')
    }
    // undici surfaces connection failures as a TypeError whose cause carries
    // the syscall-level code.
    const cause = (error as { cause?: { code?: string } }).cause
    const code = cause?.code ?? (error as NodeJS.ErrnoException).code
    if (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      error.name === 'FetchError'
    ) {
      return aiError(
        'network',
        `Could not reach the provider (${code ?? error.name}). Check the base URL, and that the service is running if it is local.`
      )
    }
    return aiError('unknown', error.message)
  }
  return aiError('unknown', String(error))
}

/**
 * Pulls a human-readable message out of an error response body.
 *
 * OpenAI-compatible servers return `{error: {message}}`, some proxies return
 * `{error: "..."}` or `{message}`, and LM Studio occasionally returns plain
 * text. Falls back to the raw body so the user sees *something* actionable.
 */
export const messageFromErrorBody = (body: string, status: number): string => {
  const fallback = `Provider returned HTTP ${status}.`
  if (!body.trim()) return fallback

  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const error = record.error
      if (typeof error === 'string') return error
      if (error && typeof error === 'object') {
        const nested = (error as Record<string, unknown>).message
        if (typeof nested === 'string') return nested
      }
      if (typeof record.message === 'string') return record.message
    }
  } catch {
    // Not JSON — fall through to the truncated raw body.
  }

  const trimmed = body.trim()
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}
