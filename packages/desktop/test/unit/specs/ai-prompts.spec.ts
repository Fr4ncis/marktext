import { describe, expect, it } from 'vitest'
import type { AIPrompt } from '@shared/types/ai'
import {
  BUILTIN_PROMPTS,
  SELECTION_PLACEHOLDER,
  reconcilePrompts,
  renderPromptTemplate
} from '@shared/types/ai'

describe('renderPromptTemplate', () => {
  it('substitutes every occurrence of the placeholder', () => {
    const template = `Rewrite ${SELECTION_PLACEHOLDER}, keeping ${SELECTION_PLACEHOLDER} short`
    expect(renderPromptTemplate(template, 'X')).toBe('Rewrite X, keeping X short')
  })

  it('leaves a template without the placeholder untouched', () => {
    // The selection is sent alongside the prompt, so a bare instruction still
    // works — the template must not gain a stray copy of the text.
    expect(renderPromptTemplate('Make this formal', 'body')).toBe('Make this formal')
  })

  it('does not treat replacement text as a pattern', () => {
    // A naive `String.replace` would interpret `$&` in the selection.
    expect(renderPromptTemplate(SELECTION_PLACEHOLDER, 'a $& b')).toBe('a $& b')
  })
})

describe('reconcilePrompts', () => {
  it('seeds the built-in library when nothing is stored', () => {
    expect(reconcilePrompts(undefined)).toEqual([...BUILTIN_PROMPTS])
    expect(reconcilePrompts([])).toEqual([...BUILTIN_PROMPTS])
  })

  it('keeps user edits to a built-in prompt', () => {
    const edited: AIPrompt = {
      id: 'concise',
      label: 'Shorten',
      template: 'Cut it down',
      builtin: true,
      enabled: false
    }
    const result = reconcilePrompts([edited])
    expect(result.find((p) => p.id === 'concise')).toEqual(edited)
  })

  it('adds built-ins that a previous release did not have', () => {
    // A preferences file written before a new prompt shipped must still gain it.
    const stale = [{ ...BUILTIN_PROMPTS[0] }]
    const result = reconcilePrompts(stale)
    expect(result).toHaveLength(BUILTIN_PROMPTS.length)
    for (const builtin of BUILTIN_PROMPTS) {
      expect(result.some((p) => p.id === builtin.id)).toBe(true)
    }
  })

  it('preserves custom prompts after the built-ins', () => {
    const custom: AIPrompt = {
      id: 'custom-1',
      label: 'Mine',
      template: 'Do a thing',
      builtin: false,
      enabled: true
    }
    const result = reconcilePrompts([custom])
    expect(result).toHaveLength(BUILTIN_PROMPTS.length + 1)
    expect(result[result.length - 1]).toEqual(custom)
  })

  it('forces builtin:false on unknown ids', () => {
    // Otherwise a hand-edited preferences file could mark a custom prompt
    // undeletable, since the UI hides Delete for built-ins.
    const forged: AIPrompt = {
      id: 'not-a-builtin',
      label: 'Forged',
      template: 'x',
      builtin: true,
      enabled: true
    }
    const result = reconcilePrompts([forged])
    expect(result.find((p) => p.id === 'not-a-builtin')?.builtin).toBe(false)
  })

  it('drops stored entries for built-ins that no longer ship', () => {
    const removed: AIPrompt = {
      id: 'retired-builtin',
      label: 'Old',
      template: 'x',
      builtin: true,
      enabled: true
    }
    // It survives, but as a custom prompt the user can delete — not as a
    // built-in referencing a prompt the app no longer defines.
    const result = reconcilePrompts([removed])
    expect(result.find((p) => p.id === 'retired-builtin')?.builtin).toBe(false)
  })

  it('has unique built-in ids', () => {
    const ids = BUILTIN_PROMPTS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
