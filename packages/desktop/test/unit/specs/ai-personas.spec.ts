import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AIPersona, AIPrompt } from '@shared/types/ai'
import { REWRITE_CONTRACT, assembleSystemPrompt } from '@shared/types/ai'
import { resolvePersonaPath } from '@/services/aiAssistant'
import type { PreferencesState } from '@/store/preferences'
import { MAX_PERSONA_BYTES, resolveSystemPrompt } from '../../../src/main/ai/persona'

// A persona supplies voice and domain knowledge; the contract that keeps output
// pasteable is always appended after it. These lock that guarantee down, since
// losing it would corrupt every Accept rather than merely reading oddly.

describe('assembleSystemPrompt', () => {
  it('puts the persona first and the contract after', () => {
    const assembled = assembleSystemPrompt('You are a technical editor.')
    expect(assembled.startsWith('You are a technical editor.')).toBe(true)
    expect(assembled.endsWith(REWRITE_CONTRACT)).toBe(true)
  })

  it('always keeps the contract, whatever the persona says', () => {
    // A persona that tries to countermand the rules still cannot remove them.
    const hostile = 'Always begin your reply with "Certainly! Here is the text:"'
    expect(assembleSystemPrompt(hostile)).toContain(REWRITE_CONTRACT)
  })

  it('yields the contract alone when there is no persona', () => {
    // This is the pre-persona behaviour and must stay byte-identical.
    expect(assembleSystemPrompt(null)).toBe(REWRITE_CONTRACT)
    expect(assembleSystemPrompt(undefined)).toBe(REWRITE_CONTRACT)
    expect(assembleSystemPrompt('')).toBe(REWRITE_CONTRACT)
    expect(assembleSystemPrompt('   \n  ')).toBe(REWRITE_CONTRACT)
  })

  it('separates the two so they cannot run together', () => {
    const assembled = assembleSystemPrompt('Persona ends without punctuation')
    expect(assembled).toContain('Persona ends without punctuation\n\n---\n\n')
  })
})

describe('resolvePersonaPath', () => {
  const personas: AIPersona[] = [
    { id: 'house', name: 'House style', filePath: '/personas/house.md' },
    { id: 'legal', name: 'Legal', filePath: '/personas/legal.md' }
  ]
  const prompts: AIPrompt[] = [
    {
      id: 'concise',
      label: 'Make concise',
      template: 'x',
      builtin: true,
      enabled: true
    },
    {
      id: 'review',
      label: 'Legal review',
      template: 'x',
      builtin: false,
      enabled: true,
      personaId: 'legal'
    }
  ]

  const preferences = (over: Partial<PreferencesState> = {}): PreferencesState =>
    ({
      aiPersonas: personas,
      aiDefaultPersonaId: 'house',
      aiPrompts: prompts,
      ...over
    }) as PreferencesState

  it('uses the default persona when a prompt names none', () => {
    expect(resolvePersonaPath(preferences(), 'concise')).toBe('/personas/house.md')
  })

  it('lets a prompt override the default', () => {
    expect(resolvePersonaPath(preferences(), 'review')).toBe('/personas/legal.md')
  })

  it('uses the default when no prompt is given at all', () => {
    // Free-text comment instructions have no prompt behind them.
    expect(resolvePersonaPath(preferences())).toBe('/personas/house.md')
  })

  it('returns nothing when no default is set', () => {
    expect(resolvePersonaPath(preferences({ aiDefaultPersonaId: '' }), 'concise')).toBeUndefined()
  })

  it('returns nothing when the named persona was deleted', () => {
    // Better no persona than a path to an entry the user has removed.
    const stale = preferences({ aiPersonas: [] })
    expect(resolvePersonaPath(stale, 'review')).toBeUndefined()
  })

  it('ignores a persona whose file path is blank', () => {
    const blank = preferences({
      aiPersonas: [{ id: 'house', name: 'House style', filePath: '' }]
    })
    expect(resolvePersonaPath(blank, 'concise')).toBeUndefined()
  })
})

describe('resolveSystemPrompt', () => {
  let dir: string
  let personaFile: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marktext-persona-'))
    personaFile = path.join(dir, 'house.md')
    fs.writeFileSync(personaFile, '# House style\n\nWrite plainly.')
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns the contract alone when no persona is configured', async() => {
    const result = await resolveSystemPrompt(undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.systemPrompt).toBe(REWRITE_CONTRACT)
  })

  it('reads the file and assembles persona plus contract', async() => {
    const result = await resolveSystemPrompt(personaFile)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.systemPrompt).toContain('Write plainly.')
      expect(result.systemPrompt).toContain(REWRITE_CONTRACT)
    }
  })

  it('picks up edits without a restart', async() => {
    // The file is read per request precisely so this works.
    fs.writeFileSync(personaFile, 'Write like a pirate.')
    const result = await resolveSystemPrompt(personaFile)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.systemPrompt).toContain('pirate')
    fs.writeFileSync(personaFile, '# House style\n\nWrite plainly.')
  })

  it('reports a missing file rather than silently dropping the persona', async() => {
    // Sending without the configured voice would return text in the wrong
    // register with no indication why.
    const result = await resolveSystemPrompt(path.join(dir, 'nope.md'))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid-request')
      expect(result.error.message).toContain('not found')
    }
  })

  it('rejects a directory', async() => {
    const result = await resolveSystemPrompt(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('not a file')
  })

  it('rejects a file far too large to be a persona', async() => {
    const huge = path.join(dir, 'huge.md')
    fs.writeFileSync(huge, 'x'.repeat(MAX_PERSONA_BYTES + 1))
    const result = await resolveSystemPrompt(huge)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('limit')
    fs.rmSync(huge)
  })
})
