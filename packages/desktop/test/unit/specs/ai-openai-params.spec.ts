import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AIProviderSettings } from '@shared/types/ai'
import { DEFAULT_MODELS } from '@shared/types/ai'
import {
  completeWithOpenAICompatible,
  isTokenLimitFieldRejection,
  resolveTokenLimitField
} from '../../../src/main/ai/providers/openaiCompatible'

// OpenAI removed `max_tokens` from Chat Completions for the GPT-5 / o-series
// models. Since every current OpenAI model is in that family, sending the old
// name broke the provider outright:
//   400 Unsupported parameter: 'max_tokens' is not supported with this model.
//       Use 'max_completion_tokens' instead.
// OpenRouter and LM Studio document only `max_tokens`, so the adapter cannot
// simply switch the name for everyone.

describe('resolveTokenLimitField', () => {
  it('sends max_completion_tokens to OpenAI', () => {
    expect(resolveTokenLimitField('openai')).toBe('max_completion_tokens')
  })

  it('keeps max_tokens for OpenRouter and LM Studio', () => {
    // Both document `max_tokens` and not the newer name; switching would break
    // the two providers that were previously working.
    expect(resolveTokenLimitField('openrouter')).toBe('max_tokens')
    expect(resolveTokenLimitField('lmstudio')).toBe('max_tokens')
  })
})

describe('isTokenLimitFieldRejection', () => {
  const OPENAI_ERROR = JSON.stringify({
    error: {
      message:
        "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
      type: 'invalid_request_error',
      param: 'max_tokens',
      code: 'unsupported_parameter'
    }
  })

  it('recognizes the real OpenAI rejection', () => {
    expect(isTokenLimitFieldRejection(400, OPENAI_ERROR)).toBe(true)
  })

  it('recognizes a server that wants the old name back', () => {
    const body = JSON.stringify({
      error: { message: "Unknown parameter: 'max_completion_tokens'." }
    })
    expect(isTokenLimitFieldRejection(400, body)).toBe(true)
  })

  it('accepts 422, which some local servers use for a bad parameter', () => {
    expect(isTokenLimitFieldRejection(422, "invalid 'max_tokens' value")).toBe(true)
  })

  it('does not retry unrelated 400s', () => {
    // A bad model name must surface to the user, not burn a silent retry.
    const body = JSON.stringify({ error: { message: 'The model `nope` does not exist.' } })
    expect(isTokenLimitFieldRejection(400, body)).toBe(false)
  })

  it('does not retry auth, rate-limit, or server failures', () => {
    // These mention nothing about the parameter and would not be fixed by it.
    expect(isTokenLimitFieldRejection(401, 'Incorrect API key provided')).toBe(false)
    expect(isTokenLimitFieldRejection(429, 'Rate limit reached')).toBe(false)
    expect(isTokenLimitFieldRejection(500, 'internal error')).toBe(false)
  })

  it('is case insensitive', () => {
    expect(isTokenLimitFieldRejection(400, "Unsupported parameter: 'MAX_TOKENS'")).toBe(true)
  })
})

describe('DEFAULT_MODELS', () => {
  it('does not default OpenAI to a retired model', () => {
    // gpt-4o predates the parameter change and is no longer in the current
    // lineup; defaulting to it shipped users straight into the broken path.
    expect(DEFAULT_MODELS.openai).not.toBe('gpt-4o')
    expect(DEFAULT_MODELS.openai).toMatch(/^gpt-5/)
  })
})

// The predicate above proves we recognize the rejection; these drive the real
// adapter to prove the request body and the retry are correct. `fetch` is
// stubbed rather than served by a local socket: this suite runs under jsdom
// alongside 50-odd other files, and binding a port there makes unrelated
// timing-sensitive specs flake.
describe('completeWithOpenAICompatible wire format', () => {
  /** Bodies the adapter actually sent, in order. */
  let sent: Array<Record<string, unknown>>
  /** Set per test to shape the reply to each successive call. */
  let reply: (body: Record<string, unknown>) => { status: number; payload: unknown }

  const settingsFor = (provider: AIProviderSettings['provider']): AIProviderSettings => ({
    provider,
    model: 'test-model',
    baseUrl: 'https://example.invalid/v1',
    maxTokens: 1234,
    timeoutMs: 5000
  })

  const okPayload = {
    model: 'test-model',
    choices: [{ message: { content: 'rewritten' }, finish_reason: 'stop' }]
  }

  const run = (provider: AIProviderSettings['provider'] = 'openai') =>
    completeWithOpenAICompatible(
      settingsFor(provider),
      { prompt: 'Make it formal', selection: 'hi' },
      'sk-test',
      new AbortController().signal
    )

  beforeEach(() => {
    sent = []
    reply = () => ({ status: 200, payload: okPayload })
    vi.stubGlobal('fetch', async(_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>
      sent.push(body)
      const { status, payload } = reply(body)
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends max_completion_tokens to OpenAI and never max_tokens', async() => {
    const result = await run('openai')

    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].max_completion_tokens).toBe(1234)
    expect(sent[0]).not.toHaveProperty('max_tokens')
  })

  it('sends max_tokens to LM Studio and OpenRouter', async() => {
    await run('lmstudio')
    await run('openrouter')

    expect(sent[0].max_tokens).toBe(1234)
    expect(sent[0]).not.toHaveProperty('max_completion_tokens')
    expect(sent[1].max_tokens).toBe(1234)
  })

  it('retries with the other spelling when the server rejects the first', async() => {
    // Mimic a server that only accepts the newer name, as OpenAI now does.
    reply = (body) =>
      'max_tokens' in body
        ? {
          status: 400,
          payload: {
            error: {
              message:
                  "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
            }
          }
        }
        : { status: 200, payload: okPayload }

    const result = await run('lmstudio')

    expect(sent).toHaveLength(2)
    expect(sent[0]).toHaveProperty('max_tokens')
    expect(sent[1]).toHaveProperty('max_completion_tokens')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe('rewritten')
  })

  it('does not retry an unrelated 400, and surfaces its message', async() => {
    // A bad model name must reach the user, not burn a silent retry.
    reply = () => ({
      status: 400,
      payload: { error: { message: 'The model `test-model` does not exist.' } }
    })

    const result = await run('openai')

    expect(sent).toHaveLength(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-request')
      expect(result.error.message).toContain('does not exist')
    }
  })

  it('reports the second failure when both spellings are rejected', async() => {
    // A genuinely broken request must not be masked by the retry.
    reply = () => ({
      status: 400,
      payload: { error: { message: "Invalid 'max_tokens': must be a positive integer." } }
    })

    const result = await run('openai')

    expect(sent).toHaveLength(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('positive integer')
  })
})
