import { describe, expect, it } from 'vitest'
import type { AIErrorKind, AIErrorPayload, AIProviderId } from '@shared/types/ai'
import { describeError } from '@/services/aiAssistant'

// `describeError` is the last hop between a normalized provider failure and the
// sentence the user reads in the assistant dialog's error alert. It is a pure
// function of (error, provider), so its every branch is checked here directly —
// this is the surface the main-process truncation and auth guards ultimately
// reach, and a regression here shows the user the wrong advice.

const err = (kind: AIErrorKind, message = '', status?: number): AIErrorPayload => ({
  kind,
  message,
  status
})

describe('describeError', () => {
  it('names the provider and points at Preferences for a missing key', () => {
    const message = describeError(err('missing-credentials'), 'anthropic')
    expect(message).toContain('anthropic')
    expect(message).toContain('Preferences → AI')
  })

  it('names the provider for a rejected key', () => {
    const message = describeError(err('authentication'), 'openai')
    expect(message).toContain('openai')
    expect(message).toContain('Preferences → AI')
  })

  it('advises waiting on a rate limit', () => {
    const message = describeError(err('rate-limit'), 'openrouter')
    expect(message).toContain('openrouter')
    expect(message.toLowerCase()).toContain('wait')
  })

  it('shows the HTTP status when the provider is unavailable', () => {
    const message = describeError(err('provider-unavailable', '', 503), 'anthropic')
    expect(message).toContain('503')
  })

  it('falls back to 5xx when an unavailable error carries no status', () => {
    const message = describeError(err('provider-unavailable'), 'anthropic')
    expect(message).toContain('5xx')
  })

  it('gives LM Studio its own local-server network advice', () => {
    // The common "server not started" case: the fix is to launch LM Studio and
    // match the base URL, not to check the internet connection.
    const message = describeError(err('network', 'ECONNREFUSED'), 'lmstudio')
    expect(message).toContain('LM Studio')
    expect(message).toContain('base URL')
    expect(message).toContain('ECONNREFUSED')
  })

  it('gives a generic connection message for a remote provider', () => {
    const message = describeError(err('network', 'ENOTFOUND'), 'openai')
    expect(message).toContain('openai')
    expect(message.toLowerCase()).toContain('network')
    expect(message).toContain('ENOTFOUND')
  })

  it('reports a cancellation plainly, without the raw message', () => {
    const message = describeError(err('aborted', 'The operation was aborted'), 'anthropic')
    expect(message).toBe('The request was cancelled.')
  })

  it('surfaces the provider message for an invalid request', () => {
    // The truncation guards raise `invalid-request` with an actionable sentence
    // ("...Raise Max tokens..."); it must reach the user rather than be dropped.
    const detail =
      'The response hit the token limit before the rewrite was complete, so it was not applied. Raise "Max tokens" in AI settings and try again.'
    const message = describeError(err('invalid-request', detail), 'anthropic')
    expect(message).toContain(detail)
  })

  it('shows the raw message for an unknown failure', () => {
    const message = describeError(err('unknown', 'something odd'), 'openai')
    expect(message).toBe('something odd')
  })

  it('has a fallback for an unknown failure with no message', () => {
    const message = describeError(err('unknown'), 'openai')
    expect(message).toBe('The request failed for an unknown reason.')
  })
})
