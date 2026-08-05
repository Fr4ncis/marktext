import { describe, expect, it } from 'vitest'
import { classifyThrown, kindFromStatus, messageFromErrorBody } from '../../../src/main/ai/errors'

// Four providers fail in four dialects. These helpers flatten them into the
// `kind` the renderer branches on when deciding what to tell the user.

describe('kindFromStatus', () => {
  it('separates the statuses that need different user advice', () => {
    expect(kindFromStatus(401)).toBe('authentication')
    expect(kindFromStatus(403)).toBe('authentication')
    expect(kindFromStatus(429)).toBe('rate-limit')
    expect(kindFromStatus(400)).toBe('invalid-request')
    expect(kindFromStatus(404)).toBe('invalid-request')
    expect(kindFromStatus(500)).toBe('provider-unavailable')
    expect(kindFromStatus(529)).toBe('provider-unavailable')
  })

  it('does not classify a success status as an error kind', () => {
    expect(kindFromStatus(200)).toBe('unknown')
  })
})

describe('messageFromErrorBody', () => {
  it('reads the OpenAI-shaped nested message', () => {
    const body = JSON.stringify({ error: { message: 'model not found', type: 'invalid' } })
    expect(messageFromErrorBody(body, 404)).toBe('model not found')
  })

  it('reads the flat variants some proxies return', () => {
    expect(messageFromErrorBody(JSON.stringify({ error: 'no capacity' }), 503)).toBe('no capacity')
    expect(messageFromErrorBody(JSON.stringify({ message: 'bad key' }), 401)).toBe('bad key')
  })

  it('falls back to the raw body when it is not JSON', () => {
    // LM Studio sometimes answers with plain text; showing it beats "HTTP 500".
    expect(messageFromErrorBody('Model is still loading', 500)).toBe('Model is still loading')
  })

  it('falls back to the status when the body is empty', () => {
    expect(messageFromErrorBody('', 502)).toBe('Provider returned HTTP 502.')
    expect(messageFromErrorBody('   ', 502)).toBe('Provider returned HTTP 502.')
  })

  it('truncates a very long body', () => {
    const long = 'x'.repeat(1000)
    const result = messageFromErrorBody(long, 500)
    // 400 characters plus the ellipsis.
    expect(result).toHaveLength(401)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('classifyThrown', () => {
  it('treats an abort as cancellation rather than a failure', () => {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    expect(classifyThrown(error).kind).toBe('aborted')
  })

  it('classifies a refused connection as a network problem', () => {
    // The common LM-Studio-not-running case: undici wraps the syscall error.
    const error = new TypeError('fetch failed')
    ;(error as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' }
    const result = classifyThrown(error)
    expect(result.kind).toBe('network')
    expect(result.message).toContain('ECONNREFUSED')
  })

  it('classifies DNS failure as a network problem', () => {
    const error = new TypeError('fetch failed')
    ;(error as unknown as { cause: { code: string } }).cause = { code: 'ENOTFOUND' }
    expect(classifyThrown(error).kind).toBe('network')
  })

  it('falls back to unknown for an unrecognized error', () => {
    const result = classifyThrown(new Error('something odd'))
    expect(result.kind).toBe('unknown')
    expect(result.message).toBe('something odd')
  })

  it('handles a non-Error throw', () => {
    expect(classifyThrown('plain string').kind).toBe('unknown')
    expect(classifyThrown('plain string').message).toBe('plain string')
  })
})
