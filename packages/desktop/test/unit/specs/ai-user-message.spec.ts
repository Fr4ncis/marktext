import { describe, expect, it } from 'vitest'
import type { AICompletionRequest } from '@shared/types/ai'
import { PROMPT_SELECTION_SEPARATOR, buildUserMessage } from '@shared/types/ai'

// The user message is the exact string that carries the user's document text
// to the model. Both providers (OpenAI-compatible and Anthropic) build it
// through buildUserMessage, so these tests pin the shared contract in one place
// instead of leaving it duplicated inline where drift in one adapter would go
// unnoticed.

const makeRequest = (over: Partial<AICompletionRequest> = {}): AICompletionRequest =>
  ({
    prompt: 'Make this formal',
    selection: 'hey there',
    ...over
  }) as AICompletionRequest

describe('buildUserMessage', () => {
  it('joins the rendered prompt and the selection with the fence separator', () => {
    expect(buildUserMessage(makeRequest())).toBe('Make this formal\n\n---\n\nhey there')
  })

  it('uses the exported separator so the fence is defined in exactly one place', () => {
    const message = buildUserMessage(makeRequest())
    expect(message).toBe(`Make this formal${PROMPT_SELECTION_SEPARATOR}hey there`)
    // Guard against an accidental change to the fence itself: a different
    // separator would silently reshape every request sent to every provider.
    expect(PROMPT_SELECTION_SEPARATOR).toBe('\n\n---\n\n')
  })

  it('keeps the selection verbatim, including a selection that looks like a fence', () => {
    // A selection containing its own `---` must not be normalised or stripped;
    // it is the user's document text and is passed through unchanged.
    const selection = 'first\n\n---\n\nsecond'
    expect(buildUserMessage(makeRequest({ selection }))).toBe(
      `Make this formal${PROMPT_SELECTION_SEPARATOR}${selection}`
    )
  })

  it('preserves an empty selection rather than collapsing the separator', () => {
    expect(buildUserMessage(makeRequest({ selection: '' }))).toBe('Make this formal\n\n---\n\n')
  })

  it('does not treat prompt or selection as replacement patterns', () => {
    // A naive builder using String.replace would interpret `$&`/`$1`.
    const message = buildUserMessage(makeRequest({ prompt: 'Fix $1', selection: 'a $& b' }))
    expect(message).toBe('Fix $1\n\n---\n\na $& b')
  })
})
