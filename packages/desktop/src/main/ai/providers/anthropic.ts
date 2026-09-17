import Anthropic from '@anthropic-ai/sdk'
import type {
  AICompletionRequest,
  AICompletionResult,
  AIProviderSettings
} from '../../../shared/types/ai'
import { aiError, classifyThrown, kindFromStatus } from '../errors'

// Anthropic is the one provider that is not OpenAI-shaped, so it goes through
// the official SDK rather than the shared fetch adapter.

/**
 * Effort keeps a rewrite from being billed and timed like a reasoning task.
 * Thinking is deliberately left at the model's default rather than disabled:
 * on Claude Opus 5 disabling it can leak `<thinking>` tags into the visible
 * response, and that response is pasted straight into the user's document.
 */
const REWRITE_EFFORT = 'low'

/** True when a 400 is the model rejecting `output_config.effort` itself. */
const isUnsupportedEffortError = (error: unknown): boolean => {
  if (!(error instanceof Anthropic.BadRequestError)) return false
  const message = error.message.toLowerCase()
  return message.includes('effort') || message.includes('output_config')
}

const extractText = (content: Anthropic.ContentBlock[]): string =>
  content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')

/**
 * The subset of an Anthropic message the result depends on. Interpreting it is
 * split out from the SDK call so it can be unit-tested without a live client.
 */
export interface AnthropicResponseShape {
  content: Anthropic.ContentBlock[]
  stop_reason: Anthropic.Message['stop_reason']
  model: string
}

/**
 * Turn a completed Anthropic response into a result. Kept pure and exported so
 * the refusal / empty / truncation branches are covered by unit tests; the
 * transport and retry logic stay in `completeWithAnthropic`.
 */
export const interpretAnthropicResponse = (
  response: AnthropicResponseShape
): AICompletionResult => {
  if (response.stop_reason === 'refusal') {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        'The model declined to rewrite this text. Try a different prompt or a different selection.'
      )
    }
  }

  const text = extractText(response.content).trim()
  if (!text) {
    const reason =
      response.stop_reason === 'max_tokens'
        ? 'The response hit the token limit before producing any text. Raise "Max tokens" in AI settings.'
        : 'The model returned an empty response.'
    return { ok: false, error: aiError('invalid-request', reason) }
  }

  // A `max_tokens` stop with text present means the rewrite was cut off
  // mid-output. That truncated text replaces a document selection verbatim, so
  // returning it as a success would splice half a sentence — or an unclosed
  // code fence — into the user's file. Fail instead and say how to fix it, the
  // same as the OpenAI-compatible adapter does for `finish_reason === 'length'`.
  if (response.stop_reason === 'max_tokens') {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        'The response hit the token limit before the rewrite was complete, so it was not applied. Raise "Max tokens" in AI settings and try again.'
      )
    }
  }

  return { ok: true, text, model: response.model }
}

export const completeWithAnthropic = async(
  settings: AIProviderSettings,
  request: AICompletionRequest,
  apiKey: string,
  signal: AbortSignal,
  /** Persona plus contract, already assembled by the caller. */
  systemPrompt: string
): Promise<AICompletionResult> => {
  const client = new Anthropic({ apiKey, maxRetries: 1 })

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `${request.prompt}\n\n---\n\n${request.selection}`
      }
    ]
  }

  try {
    let response: Anthropic.Message
    try {
      response = await client.messages.create(
        { ...params, output_config: { effort: REWRITE_EFFORT } },
        { signal }
      )
    } catch (error) {
      // Models older than Opus 4.5 reject `effort` outright. The model is a
      // free-text setting, so rather than maintain a support matrix we retry
      // once without it — any model that accepts the rest of the request works.
      if (!isUnsupportedEffortError(error)) throw error
      response = await client.messages.create(params, { signal })
    }

    return interpretAnthropicResponse(response)
  } catch (error) {
    if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
      return { ok: false, error: aiError(kindFromStatus(error.status), error.message, error.status) }
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return {
        ok: false,
        error: aiError('network', 'Could not reach the Anthropic API. Check your connection.')
      }
    }
    return { ok: false, error: classifyThrown(error) }
  }
}
