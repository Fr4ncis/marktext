import { describe, expect, it } from 'vitest'
import { maskSecret, parseExportedKeys } from '../../../src/main/ai/shellProfile'

// The parser reads rc files rather than sourcing them: sourcing would execute
// whatever the user's profile contains — plugin managers, `eval`, curl pipelines
// — to obtain a handful of string assignments. That trade only holds if the
// parser is strict about what counts as an assignment, which is what these
// specs pin down.

describe('parseExportedKeys', () => {
  it('reads a plain export', () => {
    expect(parseExportedKeys('export ANTHROPIC_API_KEY=sk-ant-123').get('ANTHROPIC_API_KEY')).toBe(
      'sk-ant-123'
    )
  })

  it('strips one layer of double or single quotes', () => {
    const parsed = parseExportedKeys(
      ['export OPENAI_API_KEY="sk-double"', "export GROQ_API_KEY='gsk-single'"].join('\n')
    )
    expect(parsed.get('OPENAI_API_KEY')).toBe('sk-double')
    expect(parsed.get('GROQ_API_KEY')).toBe('gsk-single')
  })

  it('tolerates leading whitespace and extra spaces after export', () => {
    expect(parseExportedKeys('\t export   GROQ_API_KEY=gsk-1').get('GROQ_API_KEY')).toBe('gsk-1')
  })

  it('ignores commented-out exports', () => {
    // A key the user deliberately disabled must not come back via the importer.
    const parsed = parseExportedKeys('# export OPENAI_API_KEY=sk-old\n  #export GROQ_API_KEY=gsk')
    expect(parsed.size).toBe(0)
  })

  it('ignores assignments without export, which are shell-local', () => {
    expect(parseExportedKeys('OPENAI_API_KEY=sk-local').size).toBe(0)
  })

  it('ignores an export that appears mid-line', () => {
    // `&& export X=y` inside a conditional is not an unconditional assignment,
    // and treating it as one would import a key the shell may never set.
    expect(parseExportedKeys('[ -f x ] && export OPENAI_API_KEY=sk-conditional').size).toBe(0)
  })

  it('takes the last assignment when a name is exported twice', () => {
    // Same precedence a shell applies while reading the file top to bottom.
    const parsed = parseExportedKeys('export GROQ_API_KEY=first\nexport GROQ_API_KEY=second')
    expect(parsed.get('GROQ_API_KEY')).toBe('second')
  })

  it('treats an empty assignment as unsetting the name', () => {
    // `export FOO=` after a real value is how a profile disables a key; carrying
    // the earlier value forward would import something the shell does not have.
    const parsed = parseExportedKeys('export GROQ_API_KEY=real\nexport GROQ_API_KEY=')
    expect(parsed.has('GROQ_API_KEY')).toBe(false)
  })

  it('keeps a # and everything after it, because a key is opaque', () => {
    // Deliberate: treating the remainder as a comment would silently truncate
    // any key containing #, and a truncated key fails as an auth error the user
    // cannot explain.
    expect(parseExportedKeys('export DEEPSEEK_API_KEY=sk-a#b').get('DEEPSEEK_API_KEY')).toBe(
      'sk-a#b'
    )
  })

  it('does not treat a quote inside the value as a delimiter', () => {
    expect(parseExportedKeys('export MISTRAL_API_KEY=ab"cd').get('MISTRAL_API_KEY')).toBe('ab"cd')
  })

  it('handles CRLF profiles without trailing carriage returns in the value', () => {
    expect(parseExportedKeys('export CEREBRAS_API_KEY=csk-1\r\n').get('CEREBRAS_API_KEY')).toBe(
      'csk-1'
    )
  })

  it('skips names that are not valid shell identifiers', () => {
    expect(parseExportedKeys('export 9BAD=value').size).toBe(0)
  })
})

describe('maskSecret', () => {
  it('shows only the ends of a long key', () => {
    const masked = maskSecret('sk-ant-0123456789abcdef')
    expect(masked).toBe('sk-a…cdef')
    expect(masked).not.toContain('0123456789')
  })

  it('hides a short value outright rather than half-revealing it', () => {
    // At 12 characters or fewer, showing 8 of them would leak most of the key.
    expect(maskSecret('short')).toBe('•••••')
    expect(maskSecret('abc')).toBe('••••')
  })

  it('never returns the input for any length', () => {
    for (const value of ['a', 'abcdefgh', 'abcdefghijkl', 'abcdefghijklmnop']) {
      expect(maskSecret(value)).not.toBe(value)
    }
  })
})
