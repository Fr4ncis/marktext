import { describe, expect, it } from 'vitest'
import type { TrackedAiComment } from '@shared/types/aiComments'
import {
  applyAiComment,
  buildDocumentMarker,
  buildSpanMarkers,
  hasTarget,
  isDispatchable,
  parseAiComments,
  reconcileAiComments,
  removeAiComment,
  resolveAiComment,
  stripAiComments
} from '@shared/types/aiComments'

// The marker lives in the document so it moves with the user's edits. These
// cover the two things that make that work: parsing a marker to the paragraph
// it governs, and re-identifying markers across scans while the user types.

const idGen = () => {
  let n = 0
  return () => `c${++n}`
}

describe('parseAiComments', () => {
  it('binds a marker to the paragraph beneath it', () => {
    const doc = ['# Title', '', '<!--ai: tighten this-->', 'The quick brown fox.', '', 'Next.'].join(
      '\n'
    )
    const [comment] = parseAiComments(doc)

    expect(comment.instruction).toBe('tighten this')
    expect(comment.target).toBe('The quick brown fox.')
    expect(doc.slice(comment.markerStart, comment.markerEnd)).toBe('<!--ai: tighten this-->')
  })

  it('ignores a half-typed marker', () => {
    // The closing token is what makes fire-on-write safe: until the user types
    // `-->` there is no comment, so nothing dispatches mid-sentence.
    expect(parseAiComments('<!--ai: tighten thi')).toEqual([])
  })

  it('ignores a marker with no instruction', () => {
    expect(parseAiComments('<!--ai:-->\nSome text.')).toEqual([])
    expect(parseAiComments('<!--ai:   -->\nSome text.')).toEqual([])
  })

  it('tolerates whitespace variations in the marker', () => {
    expect(parseAiComments('<!--ai:x-->\nT.')[0].instruction).toBe('x')
    expect(parseAiComments('<!--  ai:   x  -->\nT.')[0].instruction).toBe('x')
  })

  it('does not let adjacent markers claim the same paragraph', () => {
    const doc = ['<!--ai: one-->', '<!--ai: two-->', 'Only this paragraph.'].join('\n')
    const comments = parseAiComments(doc)

    expect(comments).toHaveLength(2)
    // The first marker is immediately followed by the second, so it governs
    // nothing; the second owns the paragraph.
    expect(comments[0].target).toBe('')
    expect(comments[1].target).toBe('Only this paragraph.')
    expect(hasTarget(comments[0])).toBe(false)
    expect(hasTarget(comments[1])).toBe(true)
  })

  it('stops at a blank line, not at the end of the document', () => {
    const doc = '<!--ai: x-->\nFirst para.\n\nSecond para.'
    expect(parseAiComments(doc)[0].target).toBe('First para.')
  })

  it('spans a multi-line paragraph', () => {
    const doc = '<!--ai: x-->\nLine one\nline two\n\nAfter.'
    expect(parseAiComments(doc)[0].target).toBe('Line one\nline two')
  })

  it('reports an empty target for a trailing marker', () => {
    const comments = parseAiComments('Some text.\n\n<!--ai: x-->')
    expect(comments).toHaveLength(1)
    expect(hasTarget(comments[0])).toBe(false)
  })

  it('finds several markers in document order', () => {
    const doc = ['<!--ai: a-->', 'One.', '', '<!--ai: b-->', 'Two.'].join('\n')
    const comments = parseAiComments(doc)
    expect(comments.map((c) => c.instruction)).toEqual(['a', 'b'])
    expect(comments.map((c) => c.target)).toEqual(['One.', 'Two.'])
  })
})

describe('reconcileAiComments', () => {
  const track = (doc: string, previous: TrackedAiComment[] = []) =>
    reconcileAiComments(previous, parseAiComments(doc), idGen())

  it('treats every marker in a fresh scan as new', () => {
    const { comments, added } = track('<!--ai: a-->\nOne.')
    expect(comments).toHaveLength(1)
    expect(added).toHaveLength(1)
    expect(comments[0].status).toBe('pending')
  })

  it('keeps a comment identity when text is inserted above it', () => {
    const first = track('<!--ai: a-->\nOne.')
    const ready: TrackedAiComment[] = [
      { ...first.comments[0], status: 'ready', suggestion: 'Uno.' }
    ]

    // Typing a whole heading above shifts every offset.
    const second = reconcileAiComments(
      ready,
      parseAiComments('# A new heading\n\n<!--ai: a-->\nOne.'),
      idGen()
    )

    expect(second.added).toHaveLength(0)
    expect(second.comments[0].id).toBe(ready[0].id)
    expect(second.comments[0].status).toBe('ready')
    expect(second.comments[0].suggestion).toBe('Uno.')
    // Offsets refreshed to the new positions.
    expect(second.comments[0].markerStart).toBeGreaterThan(ready[0].markerStart)
  })

  it('invalidates a suggestion when its paragraph was edited', () => {
    // The rewrite that came back was of different words; offering it now would
    // silently discard what the user just typed.
    const first = track('<!--ai: a-->\nOne.')
    const ready: TrackedAiComment[] = [
      { ...first.comments[0], status: 'ready', suggestion: 'Uno.' }
    ]

    const second = reconcileAiComments(
      ready,
      parseAiComments('<!--ai: a-->\nOne, but edited.'),
      idGen()
    )

    expect(second.comments[0].id).toBe(ready[0].id)
    expect(second.comments[0].status).toBe('pending')
    expect(second.comments[0].suggestion).toBeUndefined()
  })

  it('distinguishes several markers that share an instruction', () => {
    const doc = ['<!--ai: shorten-->', 'One.', '', '<!--ai: shorten-->', 'Two.'].join('\n')
    const first = track(doc)
    expect(first.comments).toHaveLength(2)

    const withState: TrackedAiComment[] = [
      { ...first.comments[0], status: 'ready', suggestion: 'A' },
      { ...first.comments[1], status: 'failed', error: 'boom' }
    ]
    const second = reconcileAiComments(withState, parseAiComments(doc), idGen())

    // Matching is by proximity, so the pair keeps its order rather than both
    // collapsing onto the first candidate with a matching instruction.
    expect(second.added).toHaveLength(0)
    expect(second.comments[0].status).toBe('ready')
    expect(second.comments[1].status).toBe('failed')
  })

  it('drops a comment whose marker was deleted', () => {
    const first = track('<!--ai: a-->\nOne.')
    const second = reconcileAiComments(first.comments, parseAiComments('One.'), idGen())
    expect(second.comments).toHaveLength(0)
  })

  it('adds only the new marker when one is appended', () => {
    const first = track('<!--ai: a-->\nOne.')
    const second = reconcileAiComments(
      first.comments,
      parseAiComments('<!--ai: a-->\nOne.\n\n<!--ai: b-->\nTwo.'),
      idGen()
    )
    expect(second.comments).toHaveLength(2)
    expect(second.added).toHaveLength(1)
    expect(second.added[0].instruction).toBe('b')
  })
})

describe('applyAiComment', () => {
  const trackOne = (doc: string): TrackedAiComment => ({
    ...parseAiComments(doc)[0],
    id: 'c1',
    status: 'ready'
  })

  it('replaces the paragraph and removes the marker', () => {
    const doc = '# Title\n\n<!--ai: tighten-->\nThe quick brown fox.\n\nAfter.'
    const comment = trackOne(doc)

    expect(applyAiComment(doc, comment, 'A fast fox.', comment.target)).toBe(
      '# Title\n\nA fast fox.\n\nAfter.'
    )
  })

  it('refuses when the paragraph changed underneath', () => {
    const doc = '<!--ai: tighten-->\nThe quick brown fox.'
    const comment = trackOne(doc)
    expect(applyAiComment(doc, comment, 'A fast fox.', 'something else')).toBeNull()
  })

  it('leaves the rest of the document byte-identical', () => {
    const doc = 'Before.\n\n<!--ai: x-->\nTarget.\n\nAfter.'
    const result = applyAiComment(doc, trackOne(doc), 'New.', 'Target.')
    expect(result).toBe('Before.\n\nNew.\n\nAfter.')
  })
})

describe('resolveAiComment', () => {
  // Accept re-resolves against live text because the offsets on a tracked
  // comment come from a debounced scan and can be several keystrokes stale.
  const tracked = (doc: string): TrackedAiComment => ({
    ...parseAiComments(doc)[0],
    id: 'c1',
    status: 'ready',
    suggestion: 'X'
  })

  it('finds the marker after offsets have shifted', () => {
    const before = tracked('<!--ai: tighten-->\nTarget.')
    const after = '# Heading typed since the scan\n\n<!--ai: tighten-->\nTarget.'

    const resolved = resolveAiComment(after, before)
    expect(resolved).not.toBeNull()
    expect(after.slice(resolved!.markerStart, resolved!.markerEnd)).toBe('<!--ai: tighten-->')
    expect(resolved!.target).toBe('Target.')
  })

  it('returns null once the marker is gone', () => {
    const before = tracked('<!--ai: tighten-->\nTarget.')
    expect(resolveAiComment('Target.', before)).toBeNull()
  })

  it('reports the current paragraph so a stale accept can be refused', () => {
    const before = tracked('<!--ai: tighten-->\nOriginal.')
    const resolved = resolveAiComment('<!--ai: tighten-->\nEdited since.', before)
    // The caller compares this against the text the suggestion was made from.
    expect(resolved!.target).toBe('Edited since.')
    expect(resolved!.target).not.toBe(before.target)
  })

  it('picks the nearest of several markers sharing an instruction', () => {
    const doc = ['<!--ai: shorten-->', 'One.', '', '<!--ai: shorten-->', 'Two.'].join('\n')
    const parsed = parseAiComments(doc)
    const second: TrackedAiComment = { ...parsed[1], id: 'c2', status: 'ready' }

    expect(resolveAiComment(doc, second)!.target).toBe('Two.')
  })
})

describe('removeAiComment', () => {
  it('drops the marker but keeps the text', () => {
    const doc = '<!--ai: x-->\nKeep me.\n\nAfter.'
    const comment: TrackedAiComment = { ...parseAiComments(doc)[0], id: 'c1', status: 'rejected' }
    expect(removeAiComment(doc, comment)).toBe('\nKeep me.\n\nAfter.')
  })
})

describe('stripAiComments', () => {
  it('removes every marker for export', () => {
    // Review notes must never reach a PDF or an exported HTML file.
    const doc = '# T\n\n<!--ai: a-->\nOne.\n\n<!--ai: b-->\nTwo.'
    expect(stripAiComments(doc)).toBe('# T\n\nOne.\n\nTwo.')
  })

  it('leaves an ordinary HTML comment alone', () => {
    const doc = '<!-- just a note -->\nText.'
    expect(stripAiComments(doc)).toBe(doc)
  })
})

// A span comment wraps an exact selection, the way a Word comment anchors to
// a start and an end. Block comments (no closer) keep working unchanged.
describe('span comments', () => {
  const DOC = 'Leave covers <!--ai: soften this-->maternity (12 months)<!--/ai--> for all staff.'

  it('anchors to the exact wrapped selection', () => {
    const [comment] = parseAiComments(DOC)
    expect(comment.scope).toBe('span')
    expect(comment.kind).toBe('ai')
    expect(comment.instruction).toBe('soften this')
    expect(comment.target).toBe('maternity (12 months)')
  })

  it('does not swallow the rest of the paragraph', () => {
    // The block rule would have taken everything to the blank line; the closer
    // is what makes mid-paragraph precision possible.
    expect(parseAiComments(DOC)[0].target).not.toContain('for all staff')
  })

  it('falls back to the paragraph when the closer is missing', () => {
    const doc = '<!--ai: tighten this-->\nWhole paragraph here.\n\nNext.'
    const [comment] = parseAiComments(doc)
    expect(comment.scope).toBe('block')
    expect(comment.target).toBe('Whole paragraph here.')
  })

  it('pairs each closer with its own opener', () => {
    const doc = 'A <!--ai: one-->first<!--/ai--> and B <!--ai: two-->second<!--/ai--> end.'
    const comments = parseAiComments(doc)
    expect(comments.map((c) => c.target)).toEqual(['first', 'second'])
  })

  it('does not pair a closer of a different kind', () => {
    // An `ai` opener must not be closed by a `note` closer.
    const doc = 'X <!--ai: a-->text<!--/note--> more.\n\nNext para.'
    expect(parseAiComments(doc)[0].scope).toBe('block')
  })

  it('replaces the span and removes both markers on accept', () => {
    const comment = parseAiComments(DOC)[0]
    expect(applyAiComment(DOC, comment, 'parental leave', comment.target)).toBe(
      'Leave covers parental leave for all staff.'
    )
  })

  it('keeps the text and removes both markers on dismiss', () => {
    const comment = parseAiComments(DOC)[0]
    expect(removeAiComment(DOC, comment)).toBe(
      'Leave covers maternity (12 months) for all staff.'
    )
  })

  it('refuses an accept when the span changed underneath', () => {
    const comment = parseAiComments(DOC)[0]
    expect(applyAiComment(DOC, comment, 'x', 'different text')).toBeNull()
  })

  it('builds markers that round-trip through the parser', () => {
    const { open, close } = buildSpanMarkers('ai', '  soften this  ')
    const doc = `Leave covers ${open}maternity${close} for staff.`
    const [comment] = parseAiComments(doc)
    expect(comment.instruction).toBe('soften this')
    expect(comment.target).toBe('maternity')
  })
})

describe('note comments', () => {
  const DOC = 'Revenue was <!--note: check this figure-->£4.2m<!--/note--> last year.'

  it('parses as a note, not an AI request', () => {
    const [comment] = parseAiComments(DOC)
    expect(comment.kind).toBe('note')
    expect(comment.target).toBe('£4.2m')
  })

  it('is never dispatched to a provider', () => {
    // A note is a reminder to yourself; sending it would spend a request and
    // return a rewrite nobody asked for.
    const [note] = parseAiComments(DOC)
    expect(isDispatchable(note)).toBe(false)

    const [instruction] = parseAiComments('X <!--ai: shorten-->text<!--/ai--> Y.')
    expect(isDispatchable(instruction)).toBe(true)
  })

  it('starts in the note status rather than pending', () => {
    const { comments } = reconcileAiComments([], parseAiComments(DOC), () => 'n1')
    expect(comments[0].status).toBe('note')
  })

  it('does not collide with an AI comment of the same instruction', () => {
    const doc = 'A <!--ai: check-->one<!--/ai--> B <!--note: check-->two<!--/note--> C.'
    const { comments } = reconcileAiComments([], parseAiComments(doc), (() => {
      let n = 0
      return () => `c${++n}`
    })())
    expect(comments.map((c) => c.kind)).toEqual(['ai', 'note'])
    expect(comments.map((c) => c.target)).toEqual(['one', 'two'])
  })
})

describe('stripAiComments with spans', () => {
  it('removes both markers but keeps the wrapped text', () => {
    const doc = 'Leave covers <!--ai: soften-->maternity<!--/ai--> for staff.'
    expect(stripAiComments(doc)).toBe('Leave covers maternity for staff.')
  })

  it('removes note markers too', () => {
    const doc = 'Revenue was <!--note: check-->£4.2m<!--/note--> last year.'
    expect(stripAiComments(doc)).toBe('Revenue was £4.2m last year.')
  })
})

// A trailing slash makes the marker a void element: it never pairs, never
// claims a paragraph, and addresses the document as a whole.
describe('document comments', () => {
  const DOC = '<!--ai/: keep the tone consistent-->\n\n# Title\n\nFirst para.\n\nSecond para.'

  it('parses as document scope', () => {
    const [comment] = parseAiComments(DOC)
    expect(comment.scope).toBe('document')
    expect(comment.kind).toBe('ai')
    expect(comment.instruction).toBe('keep the tone consistent')
  })

  it('targets the whole prose with markers stripped out', () => {
    // The model should be shown the document, not the review syntax.
    const [comment] = parseAiComments(DOC)
    expect(comment.target).toBe('# Title\n\nFirst para.\n\nSecond para.')
    expect(comment.target).not.toContain('<!--')
  })

  it('excludes other comments’ markers from the target', () => {
    const doc = '<!--ai/: overall tone-->\n\nA <!--ai: soften-->word<!--/ai--> here.'
    const [documentComment] = parseAiComments(doc)
    expect(documentComment.target).toBe('A word here.')
  })

  it('never pairs with a closer', () => {
    // `<!--/ai-->` closes a span; a self-closing marker must ignore it.
    const doc = '<!--ai/: overall-->\n\nText.<!--/ai-->'
    expect(parseAiComments(doc)[0].scope).toBe('document')
  })

  it('supports a document-wide note', () => {
    const [comment] = parseAiComments('<!--note/: needs a legal review-->\n\nBody.')
    expect(comment.scope).toBe('document')
    expect(comment.kind).toBe('note')
    expect(isDispatchable(comment)).toBe(false)
  })

  it('coexists with span and block comments', () => {
    const doc = [
      '<!--ai/: overall tone-->',
      '',
      '<!--ai: tighten-->',
      'A paragraph.',
      '',
      'X <!--note: check-->this<!--/note--> Y.'
    ].join('\n')
    expect(parseAiComments(doc).map((c) => c.scope)).toEqual(['document', 'block', 'span'])
  })

  it('replaces the entire document on accept', () => {
    const comment = parseAiComments(DOC)[0]
    const rewritten = '# Title\n\nRewritten throughout.'
    expect(applyAiComment(DOC, comment, rewritten, comment.target)).toBe(rewritten)
  })

  it('refuses an accept once the prose changed', () => {
    const comment = parseAiComments(DOC)[0]
    const edited = DOC.replace('First para.', 'First para, edited.')
    // The suggestion rewrote words the user has since changed.
    expect(applyAiComment(edited, comment, 'anything', comment.target)).toBeNull()
  })

  it('removes only its own marker on dismiss', () => {
    const comment = parseAiComments(DOC)[0]
    expect(removeAiComment(DOC, comment)).toBe('\n# Title\n\nFirst para.\n\nSecond para.')
  })

  it('keeps a finished suggestion while the document is edited', () => {
    // Its target is the whole document, so invalidating on change would discard
    // the suggestion on every keystroke and make the feature useless.
    const first = reconcileAiComments([], parseAiComments(DOC), idGen())
    const ready: TrackedAiComment[] = [
      { ...first.comments[0], status: 'ready', suggestion: 'Rewritten.' }
    ]

    const edited = DOC.replace('Second para.', 'Second para, now longer.')
    const second = reconcileAiComments(ready, parseAiComments(edited), idGen())

    expect(second.comments[0].status).toBe('ready')
    expect(second.comments[0].suggestion).toBe('Rewritten.')
  })

  it('builds a marker that round-trips through the parser', () => {
    const marker = buildDocumentMarker('ai', '  keep the tone consistent  ')
    expect(marker).toBe('<!--ai/: keep the tone consistent-->')
    const [comment] = parseAiComments(`${marker}\n\nBody text.`)
    expect(comment.scope).toBe('document')
    expect(comment.instruction).toBe('keep the tone consistent')
  })

  it('is stripped for export like any other marker', () => {
    expect(stripAiComments(DOC)).toBe('# Title\n\nFirst para.\n\nSecond para.')
  })
})
