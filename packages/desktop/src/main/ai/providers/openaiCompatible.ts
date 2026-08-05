import type {
  AICompletionRequest,
  AICompletionResult,
  AIProviderSettings
} from '../../../shared/types/ai'
import { REWRITE_SYSTEM_PROMPT } from '../../../shared/types/ai'
import { aiError, classifyThrown, kindFromStatus, messageFromErrorBody } from '../errors'

// One adapter serves OpenAI, OpenRouter, and LM Studio: all three expose
// POST {baseUrl}/chat/completions with OpenAI's request and response shape.
// Only the auth header and a couple of optional courtesy headers differ.

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
  signal: AbortSignal
): Promise<AICompletionResult> => {
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    messages: [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: `${request.prompt}\n\n---\n\n${request.selection}` }
    ]
  }

  let response: Response
  try {
    response = await fetch(endpointFor(settings.baseUrl), {
      method: 'POST',
      headers: buildHeaders(settings, apiKey),
      body: JSON.stringify(body),
      signal
    })
  } catch (error) {
    return { ok: false, error: classifyThrown(error) }
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    return {
      ok: false,
      error: aiError(
        kindFromStatus(response.status),
        messageFromErrorBody(raw, response.status),
        response.status
      )
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

  return { ok: true, text, model: payload.model ?? settings.model }
}
