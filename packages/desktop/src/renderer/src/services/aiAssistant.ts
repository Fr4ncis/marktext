import type {
  AICompletionResult,
  AIErrorPayload,
  AIPrompt,
  AIProviderId,
  AIProviderSettings
} from '@shared/types/ai'
import { renderPromptTemplate, reconcilePrompts } from '@shared/types/ai'
import type { PreferencesState } from '@/store/preferences'

// Thin renderer-side wrapper over `window.aiAssistant`. Its job is to turn the
// preferences store into a provider request and to translate provider errors
// into sentences a user can act on — the network work all happens in main.

/** Monotonic within a window; only needs to be unique against in-flight peers. */
let requestCounter = 0
const nextRequestId = (): string => `ai-${Date.now()}-${++requestCounter}`

export const settingsFromPreferences = (preferences: PreferencesState): AIProviderSettings => ({
  provider: preferences.aiProvider as AIProviderId,
  model: preferences.aiModel,
  baseUrl: preferences.aiBaseUrl,
  maxTokens: preferences.aiMaxTokens,
  timeoutMs: preferences.aiTimeoutMs
})

/** Prompts the user can actually run, in library order. */
export const usablePrompts = (preferences: PreferencesState): AIPrompt[] =>
  reconcilePrompts(preferences.aiPrompts).filter((prompt) => prompt.enabled)

export const findPrompt = (
  preferences: PreferencesState,
  promptId: string
): AIPrompt | undefined => reconcilePrompts(preferences.aiPrompts).find((p) => p.id === promptId)

/**
 * A cancellable rewrite. `cancel` aborts the main-process request; `result`
 * still resolves, with an `aborted` error, so callers have one cleanup path.
 */
export interface RunningCompletion {
  result: Promise<AICompletionResult>
  cancel: () => void
}

export const runCompletion = (
  settings: AIProviderSettings,
  template: string,
  selection: string
): RunningCompletion => {
  const requestId = nextRequestId()
  const result = window.aiAssistant.complete(requestId, settings, {
    prompt: renderPromptTemplate(template, selection),
    selection
  })
  return { result, cancel: () => window.aiAssistant.cancel(requestId) }
}

/**
 * Turns a provider error into a message that says what to do about it.
 *
 * The provider's own message is appended for the kinds where it carries real
 * detail (a bad model name, an unsupported parameter) and dropped for the kinds
 * where it is noise the user cannot act on.
 */
export const describeError = (error: AIErrorPayload, provider: AIProviderId): string => {
  switch (error.kind) {
    case 'missing-credentials':
      return `No API key is saved for ${provider}. Add one in Preferences → AI.`
    case 'authentication':
      return `${provider} rejected the API key. Check it in Preferences → AI.`
    case 'rate-limit':
      return `${provider} is rate limiting this account. Wait a moment and try again.`
    case 'provider-unavailable':
      return `${provider} is unavailable right now (HTTP ${error.status ?? '5xx'}). Try again shortly.`
    case 'network':
      return provider === 'lmstudio'
        ? `Could not reach LM Studio. Make sure the local server is running and the base URL in Preferences → AI matches it. (${error.message})`
        : `Could not reach ${provider}. Check your network connection. (${error.message})`
    case 'aborted':
      return 'The request was cancelled.'
    case 'invalid-request':
      return `The request was rejected: ${error.message}`
    default:
      return error.message || 'The request failed for an unknown reason.'
  }
}
