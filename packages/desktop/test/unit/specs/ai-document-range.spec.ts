import { describe, expect, it } from 'vitest'
import {
  isNonEmptyRange,
  lineChToOffset,
  offsetToLineCh,
  replaceRange,
  toDocumentRange
} from '@/util/documentRange'

// Muya reports the caret in CodeMirror `{ line, ch }` coordinates while a
// rewrite has to splice flat markdown, so these conversions sit between the
// editor and every AI action. A rounding error here corrupts the document.

const DOC = ['# Title', '', 'First paragraph.', 'Second paragraph.'].join('\n')

describe('lineChToOffset', () => {
  it('resolves positions on the first and later lines', () => {
    expect(lineChToOffset(DOC, { line: 0, ch: 0 })).toBe(0)
    expect(lineChToOffset(DOC, { line: 0, ch: 7 })).toBe(7)
    // Line 2 starts after "# Title\n" (8) + "\n" (1).
    expect(lineChToOffset(DOC, { line: 2, ch: 0 })).toBe(9)
    expect(lineChToOffset(DOC, { line: 2, ch: 5 })).toBe(14)
  })

  it('clamps out-of-range input instead of throwing', () => {
    // A position captured a tick earlier can outlive the text it referred to;
    // clamping keeps the action usable rather than crashing the editor.
    expect(lineChToOffset(DOC, { line: 99, ch: 0 })).toBe(DOC.length - 'Second paragraph.'.length)
    expect(lineChToOffset(DOC, { line: 0, ch: 999 })).toBe(7)
    expect(lineChToOffset(DOC, { line: -3, ch: -3 })).toBe(0)
  })
})

describe('offsetToLineCh', () => {
  it('round-trips every offset in the document', () => {
    for (let offset = 0; offset <= DOC.length; offset++) {
      expect(lineChToOffset(DOC, offsetToLineCh(DOC, offset))).toBe(offset)
    }
  })

  it('places an offset at a newline on the end of the preceding line', () => {
    expect(offsetToLineCh(DOC, 7)).toEqual({ line: 0, ch: 7 })
    expect(offsetToLineCh(DOC, 8)).toEqual({ line: 1, ch: 0 })
  })
})

describe('toDocumentRange', () => {
  it('orders a backwards selection', () => {
    const forwards = toDocumentRange(DOC, { line: 2, ch: 0 }, { line: 2, ch: 5 })
    const backwards = toDocumentRange(DOC, { line: 2, ch: 5 }, { line: 2, ch: 0 })
    expect(forwards).toEqual({ start: 9, end: 14 })
    expect(backwards).toEqual(forwards)
  })

  it('returns null when either end is missing', () => {
    expect(toDocumentRange(DOC, null, { line: 0, ch: 1 })).toBeNull()
    expect(toDocumentRange(DOC, { line: 0, ch: 1 }, undefined)).toBeNull()
  })
})

describe('isNonEmptyRange', () => {
  it('rejects a collapsed caret and a whitespace-only span', () => {
    expect(isNonEmptyRange(DOC, { start: 5, end: 5 })).toBe(false)
    // Offsets 7..9 are "\n\n" — a selection the user cannot rewrite.
    expect(isNonEmptyRange(DOC, { start: 7, end: 9 })).toBe(false)
    expect(isNonEmptyRange(DOC, { start: 9, end: 14 })).toBe(true)
  })
})

describe('replaceRange', () => {
  it('splices the replacement over the range', () => {
    const result = replaceRange(DOC, { start: 9, end: 14 }, 'Third', 'First')
    expect(result).toBe(['# Title', '', 'Third paragraph.', 'Second paragraph.'].join('\n'))
  })

  it('refuses when the document changed under the range', () => {
    // The user can keep typing while a request is in flight; splicing at a
    // stale offset would overwrite unrelated text.
    expect(replaceRange(DOC, { start: 9, end: 14 }, 'Third', 'Wrong')).toBeNull()
  })

  it('refuses an out-of-bounds or inverted range', () => {
    expect(replaceRange(DOC, { start: 0, end: DOC.length + 5 }, 'x', '')).toBeNull()
    expect(replaceRange(DOC, { start: 12, end: 4 }, 'x', '')).toBeNull()
    expect(replaceRange(DOC, { start: -1, end: 4 }, 'x', '')).toBeNull()
  })

  it('allows a replacement that changes the document length', () => {
    expect(replaceRange('abc', { start: 1, end: 2 }, 'XYZ', 'b')).toBe('aXYZc')
    expect(replaceRange('abc', { start: 1, end: 2 }, '', 'b')).toBe('ac')
  })
})
