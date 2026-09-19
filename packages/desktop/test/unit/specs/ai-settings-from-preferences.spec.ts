import { describe, expect, it } from 'vitest'
import type { AIProviderSettings } from '@shared/types/ai'
import { settingsFromPreferences } from '@/services/aiAssistant'
import type { PreferencesState } from '@/store/preferences'

// `settingsFromPreferences` is the single seam that turns the preferences store
// into the settings object every provider request is built from. A silent drift
// here — a dropped field, a mis-mapped one — would misconfigure every AI call
// (wrong model, lost token cap, lost timeout) with nothing else to catch it, so
// the field-by-field mapping is pinned directly. It is a pure function of the
// store slice, so no mocks are needed.

const preferences = (over: Partial<PreferencesState> = {}): PreferencesState =>
  ({
    aiProvider: 'anthropic',
    aiModel: 'claude-3-5-sonnet',
    aiBaseUrl: 'https://api.anthropic.com',
    aiMaxTokens: 8192,
    aiTimeoutMs: 60000,
    ...over
  }) as PreferencesState

describe('settingsFromPreferences', () => {
  it('maps every provider field across, one to one', () => {
    const settings = settingsFromPreferences(preferences())
    expect(settings).toEqual<AIProviderSettings>({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      baseUrl: 'https://api.anthropic.com',
      maxTokens: 8192,
      timeoutMs: 60000
    })
  })

  it('carries the provider id through unchanged', () => {
    // The store types aiProvider as `AIProviderId | string`; whatever is stored
    // is handed to main verbatim, which resolves the default base URL from it.
    expect(settingsFromPreferences(preferences({ aiProvider: 'lmstudio' })).provider).toBe(
      'lmstudio'
    )
    expect(settingsFromPreferences(preferences({ aiProvider: 'openai' })).provider).toBe('openai')
  })

  it('keeps a blank base URL blank rather than filling a default', () => {
    // The provider default is applied in the main process (resolveBaseUrl), not
    // here — this mapping must not silently substitute one, or the user could
    // never point the field at a custom endpoint.
    expect(settingsFromPreferences(preferences({ aiBaseUrl: '' })).baseUrl).toBe('')
  })

  it('preserves the exact token cap and timeout, without coercion', () => {
    const settings = settingsFromPreferences(
      preferences({ aiMaxTokens: 512, aiTimeoutMs: 15000 })
    )
    expect(settings.maxTokens).toBe(512)
    expect(settings.timeoutMs).toBe(15000)
  })

  it('does not carry unrelated preference fields into the settings', () => {
    // Only the five provider fields belong in the request; extra store state
    // (prompts, personas, unrelated editor prefs) must not leak across the IPC.
    const settings = settingsFromPreferences(
      preferences({ aiPrompts: [], aiPersonas: [], aiDefaultPersonaId: 'house' })
    )
    expect(Object.keys(settings).sort()).toEqual([
      'baseUrl',
      'maxTokens',
      'model',
      'provider',
      'timeoutMs'
    ])
  })
})
