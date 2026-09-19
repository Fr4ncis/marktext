import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDER_IDS,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  OPENAI_COMPATIBLE_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  PROVIDERS_REQUIRING_KEY
} from '@shared/types/ai'

// The provider catalog is five parallel tables keyed by the same union. Adding a
// provider means touching all of them, and the compiler only catches the
// `Record<AIProviderId, …>` ones — a missing model list or a provider left out
// of AI_PROVIDER_IDS type-checks fine and fails at runtime as a blank dropdown
// or a silently-unauthenticated request. These specs are that missing check.

describe('AI provider catalog', () => {
  it('lists every provider exactly once', () => {
    expect(new Set(AI_PROVIDER_IDS).size).toBe(AI_PROVIDER_IDS.length)
  })

  it('carries a label, base URL, default model and model list for every provider', () => {
    for (const id of AI_PROVIDER_IDS) {
      expect(PROVIDER_LABELS[id], `label for ${id}`).toBeTruthy()
      expect(DEFAULT_BASE_URLS[id], `base URL for ${id}`).toBeTruthy()
      expect(DEFAULT_MODELS[id], `default model for ${id}`).toBeTruthy()
      expect(PROVIDER_MODELS[id], `model list for ${id}`).toBeDefined()
    }
  })

  it('keys every table only by known providers', () => {
    const known = new Set<string>(AI_PROVIDER_IDS)
    for (const table of [PROVIDER_LABELS, DEFAULT_BASE_URLS, DEFAULT_MODELS, PROVIDER_MODELS]) {
      expect(Object.keys(table).filter((key) => !known.has(key))).toEqual([])
    }
  })

  it('offers the default model in its own list, so the initial value is selectable', () => {
    for (const id of AI_PROVIDER_IDS) {
      const models = PROVIDER_MODELS[id]
      if (models.length === 0) continue
      expect(
        models.map((model) => model.id),
        `default model for ${id} must appear in its list`
      ).toContain(DEFAULT_MODELS[id])
    }
  })

  it('treats every provider except Anthropic as OpenAI-compatible', () => {
    expect([...OPENAI_COMPATIBLE_PROVIDERS].sort()).toEqual(
      AI_PROVIDER_IDS.filter((id) => id !== 'anthropic')
        .slice()
        .sort()
    )
  })

  it('requires a key for every hosted provider and neither local one', () => {
    expect(PROVIDERS_REQUIRING_KEY).not.toContain('lmstudio')
    expect(PROVIDERS_REQUIRING_KEY).not.toContain('ollama')
    // Everything else is a hosted API: reaching it without a key is a 401, so a
    // provider missing from this list would hide the settings pane's key field.
    for (const id of AI_PROVIDER_IDS) {
      if (id === 'lmstudio' || id === 'ollama') continue
      expect(PROVIDERS_REQUIRING_KEY, `${id} needs a key`).toContain(id)
    }
  })

  it('points the local providers at loopback, not a hosted endpoint', () => {
    expect(DEFAULT_BASE_URLS.lmstudio).toMatch(/^http:\/\/127\.0\.0\.1:/)
    expect(DEFAULT_BASE_URLS.ollama).toMatch(/^http:\/\/127\.0\.0\.1:/)
  })

  it('leaves the local providers without a curated model list', () => {
    // They serve whatever is loaded or pulled, so a shipped guess would be
    // wrong more often than useful — the pane falls back to free text.
    expect(PROVIDER_MODELS.lmstudio).toEqual([])
    expect(PROVIDER_MODELS.ollama).toEqual([])
  })

  it('gives every listed model a distinct id and a label', () => {
    for (const id of AI_PROVIDER_IDS) {
      const ids = PROVIDER_MODELS[id].map((model) => model.id)
      expect(new Set(ids).size, `${id} has a duplicate model id`).toBe(ids.length)
      for (const model of PROVIDER_MODELS[id]) {
        expect(model.label, `label for ${id}/${model.id}`).toBeTruthy()
      }
    }
  })

  it('marks the GPT-5 family as needing max_completion_tokens wherever it is served', () => {
    // The quirk follows the model across hosts: OpenRouter fronts the same
    // family, so its entry has to carry the flag too.
    const openai = PROVIDER_MODELS.openai.find((model) => model.id === 'gpt-5.6')
    expect(openai?.tokenLimitField).toBe('max_completion_tokens')

    const viaRouter = PROVIDER_MODELS.openrouter.find((model) => model.id === 'openai/gpt-5.6')
    expect(viaRouter?.tokenLimitField).toBe('max_completion_tokens')
  })
})
