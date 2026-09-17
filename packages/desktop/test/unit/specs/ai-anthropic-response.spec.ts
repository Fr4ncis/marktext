import { describe, expect, it } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  interpretAnthropicResponse,
  type AnthropicResponseShape
} from '../../../src/main/ai/providers/anthropic'

// The Anthropic provider calls the official SDK, so the transport is not driven
// here the way the OpenAI-compatible fetch adapter is. Instead the branch logic
// is extracted into interpretAnthropicResponse and its result semantics are
// pinned directly — the same truncation guard the OpenAI adapter has, plus the
// refusal / empty branches that previously had no coverage at all.

const textBlock = (text: string): Anthropic.ContentBlock =>
  ({ type: 'text', text, citations: [] } as unknown as Anthropic.ContentBlock)

const response = (
  overrides: Partial<AnthropicResponseShape>
): AnthropicResponseShape => ({
  content: [textBlock('rewritten')],
  stop_reason: 'end_turn',
  model: 'claude-test',
  ...overrides
})

describe('interpretAnthropicResponse', () => {
  it('returns the text when the model stops normally', () => {
    const result = interpretAnthropicResponse(response({ stop_reason: 'end_turn' }))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text).toBe('rewritten')
      expect(result.model).toBe('claude-test')
    }
  })

  it('trims surrounding whitespace from the text', () => {
    const result = interpretAnthropicResponse(response({ content: [textBlock('  hi  ')] }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.text).toBe('hi')
  })

  it('rejects a completion cut off by the token limit', () => {
    // A max_tokens stop with partial text would splice half a sentence — or an
    // unclosed code fence — into the document on "Replace selection". It must
    // fail rather than be applied.
    const result = interpretAnthropicResponse(
      response({ content: [textBlock('The first half of the rewrite')], stop_reason: 'max_tokens' })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-request')
      expect(result.error.message).toContain('Max tokens')
      expect(result.error.message).toContain('not applied')
    }
  })

  it('reports an empty max_tokens response with the no-text message', () => {
    const result = interpretAnthropicResponse(
      response({ content: [textBlock('   ')], stop_reason: 'max_tokens' })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-request')
      expect(result.error.message).toContain('before producing any text')
    }
  })

  it('reports an empty non-truncated response distinctly', () => {
    const result = interpretAnthropicResponse(
      response({ content: [], stop_reason: 'end_turn' })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-request')
      expect(result.error.message).toContain('empty response')
    }
  })

  it('surfaces a refusal before any text handling', () => {
    // Even if the model emitted text alongside the refusal, a refusal stop must
    // not reach the document.
    const result = interpretAnthropicResponse(
      response({ content: [textBlock('some text')], stop_reason: 'refusal' })
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-request')
      expect(result.error.message).toContain('declined to rewrite')
    }
  })
})
