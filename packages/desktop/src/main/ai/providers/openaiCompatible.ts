import type {
  AICompletionRequest,
  AICompletionResult,
  AIProviderId,
  AIProviderSettings
} from '../../../shared/types/ai'
import { aiError, classifyThrown, kindFromStatus, messageFromErrorBody } from '../errors'

// One adapter serves OpenAI, OpenRouter, and LM Studio: all three expose
// POST {baseUrl}/chat/completions with OpenAI's request and response shape.
// Only the auth header, a couple of optional courtesy headers, and the name of
// the output-length parameter differ.

/**
 * Name of the parameter capping output length.
 *
 * OpenAI removed `max_tokens` from Chat Completions for the GPT-5 and o-series
 * models — sending it returns 400 "Unsupported parameter: 'max_tokens' is not
 * supported with this model. Use 'max_completion_tokens' instead." Every
 * current OpenAI model is in that family, so OpenAI always gets the new name.
 *
 * OpenRouter and LM Studio both document `max_tokens` and not the newer name,
 * so they keep the original. `resolveTokenLimitField` is exported for tests.
 */
export const resolveTokenLimitField = (provider: AIProviderId): string =>
  provider === 'openai' ? 'max_completion_tokens' : 'max_tokens'

/** The other spelling, used for the one-shot retry below. */
const alternateTokenLimitField = (field: string): string =>
  field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'

/**
 * Whether a rejection is the server objecting to the output-length parameter
 * specifically, rather than to something else in the request.
 *
 * Three independently-evolving services share this adapter, so rather than
 * pin a support matrix that silently rots, a 400 naming the parameter earns
 * one retry with the other spelling. Exported for tests.
 */
export const isTokenLimitFieldRejection = (status: number, body: string): boolean => {
  if (status !== 400 && status !== 422) return false
  const lower = body.toLowerCase()
  return lower.includes('max_tokens') || lower.includes('max_completion_tokens')
}

/** Shape we read back. Everything else in the response is ignored. */
interface ChatCompletionResponse {
  model?: string
  choices?: Array<{
    message?: { content?: string | null }
    finish_reason?: string
  }>
}

/**
 * OpenRouter uses these to attribute traffic and, for some models, to gate
 * access. They are ignored by OpenAI and LM Studio.
 */
const OPENROUTER_ATTRIBUTION = {
  'HTTP-Referer': 'https://marktext.me',
  'X-Title': 'MarkText'
}

const buildHeaders = (settings: AIProviderSettings, apiKey: string | null): HeadersInit => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // LM Studio ignores Authorization but tolerates it; sending it only when a
  // key exists keeps local requests clean.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (settings.provider === 'openrouter') Object.assign(headers, OPENROUTER_ATTRIBUTION)
  return headers
}

/** Joins base URL and path without doubling or dropping the separator. */
const endpointFor = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/chat/completions`

export const completeWithOpenAICompatible = async(
  settings: AIProviderSettings,
  request: AICompletionRequest,
  apiKey: string | null,
  signal: AbortSignal,
  /** Persona plus contract, already assembled by the caller. */
  systemPrompt: string
): Promise<AICompletionResult> => {
  // `system` is accepted by every target: OpenAI silently treats it as a
  // `developer` message on the reasoning models, so no per-provider branch.
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${request.prompt}\n\n---\n\n${request.selection}` }
  ]

  const send = async(tokenField: string): Promise<Response> =>
    fetch(endpointFor(settings.baseUrl), {
      method: 'POST',
      headers: buildHeaders(settings, apiKey),
      body: JSON.stringify({
        model: settings.model,
        [tokenField]: settings.maxTokens,
        messages
      }),
      signal
    })

  const tokenField = resolveTokenLimitField(settings.provider)
  let response: Response
  try {
    response = await send(tokenField)
  } catch (error) {
    return { ok: false, error: classifyThrown(error) }
  }

  if (!response.ok) {
    let raw = await response.text().catch(() => '')

    // A server that rejects this spelling almost certainly wants the other one.
    if (isTokenLimitFieldRejection(response.status, raw)) {
      try {
        response = await send(alternateTokenLimitField(tokenField))
      } catch (error) {
        return { ok: false, error: classifyThrown(error) }
      }
      raw = response.ok ? '' : await response.text().catch(() => '')
    }

    if (!response.ok) {
      return {
        ok: false,
        error: aiError(
          kindFromStatus(response.status),
          messageFromErrorBody(raw, response.status),
          response.status
        )
      }
    }
  }

  let payload: ChatCompletionResponse
  try {
    payload = (await response.json()) as ChatCompletionResponse
  } catch (error) {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        `The provider returned a response that is not valid JSON (${(error as Error).message}). Check that the base URL points at an OpenAI-compatible API.`
      )
    }
  }

  const choice = payload.choices?.[0]
  const text = choice?.message?.content?.trim() ?? ''

  if (!text) {
    const reason =
      choice?.finish_reason === 'length'
        ? 'The response hit the token limit before producing any text. Raise "Max tokens" in AI settings.'
        : 'The model returned an empty response.'
    return { ok: false, error: aiError('invalid-request', reason) }
  }

  // A `length` finish with text present means the rewrite was cut off
  // mid-output. That truncated text replaces a document selection verbatim, so
  // returning it as a success would splice half a sentence — or an unclosed
  // code fence — into the user's file. Fail instead and say how to fix it, the
  // same as the empty-`length` case above.
  if (choice?.finish_reason === 'length') {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        'The response hit the token limit before the rewrite was complete, so it was not applied. Raise "Max tokens" in AI settings and try again.'
      )
    }
  }

  return { ok: true, text, model: payload.model ?? settings.model }
}
