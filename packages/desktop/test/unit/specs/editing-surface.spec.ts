import { describe, expect, it, vi } from 'vitest'
import { codeMirrorSurface, muyaSurface, type CodeMirrorLike } from '@/util/editingSurface'

// The surface is what lets the AI assistant, the review comments, and the
// version timeline drive either editor. The risk it carries is subtle: both
// backends speak `{ line, ch }` and flat offsets, so a coordinate mistake does
// not throw — it silently splices text into the wrong place. These pin the
// arithmetic down against a real document.

const DOC = ['# Title', '', 'alpha bravo charlie', '', 'delta echo'].join('\n')

/** A CodeMirror 5 double: enough of the real API to exercise the adapter. */
const fakeCodeMirror = (initial: string) => {
  let value = initial
  let anchor = { line: 0, ch: 0 }
  let head = { line: 0, ch: 0 }

  const posFromIndex = (index: number) => {
    const clamped = Math.min(Math.max(index, 0), value.length)
    const before = value.slice(0, clamped).split('\n')
    return { line: before.length - 1, ch: before[before.length - 1].length }
  }
  const indexFromPos = (pos: { line: number; ch: number }) => {
    const lines = value.split('\n')
    let offset = 0
    for (let i = 0; i < pos.line && i < lines.length; i++) offset += lines[i].length + 1
    return offset + pos.ch
  }
  const ordered = () =>
    indexFromPos(anchor) <= indexFromPos(head) ? { from: anchor, to: head } : { from: head, to: anchor }

  const cm = {
    getValue: () => value,
    getCursor: (which: string) => {
      if (which === 'anchor') return anchor
      if (which === 'head') return head
      return which === 'from' ? ordered().from : ordered().to
    },
    indexFromPos,
    posFromIndex,
    replaceRange: (
      text: string,
      from: { line: number; ch: number },
      to: { line: number; ch: number }
    ) => {
      value = value.slice(0, indexFromPos(from)) + text + value.slice(indexFromPos(to))
    },
    setSelection: (a: { line: number; ch: number }, h: { line: number; ch: number }) => {
      anchor = a
      head = h
    },
    lastLine: () => value.split('\n').length - 1,
    getLine: (line: number) => value.split('\n')[line] ?? '',
    cursorCoords: (pos: { line: number; ch: number }) => ({
      top: pos.line * 20,
      bottom: pos.line * 20 + 18,
      left: pos.ch * 8,
      right: pos.ch * 8 + 8
    }),
    getWrapperElement: () => ({
      querySelector: () => null,
      getBoundingClientRect: () => ({ right: 640 })
    }),
    focus: () => undefined,
    /** Test-only helper. */
    __select: (start: number, end: number) => {
      anchor = posFromIndex(start)
      head = posFromIndex(end)
    }
  }
  return cm as unknown as CodeMirrorLike & { __select: (s: number, e: number) => void }
}

describe('codeMirrorSurface', () => {
  it('reads the document verbatim', () => {
    expect(codeMirrorSurface(fakeCodeMirror(DOC)).getMarkdown()).toBe(DOC)
  })

  it('reports the selection as offsets into that document', () => {
    const cm = fakeCodeMirror(DOC)
    const start = DOC.indexOf('bravo')
    cm.__select(start, start + 5)

    const range = codeMirrorSurface(cm).getSelectionRange()
    expect(range).toEqual({ start, end: start + 5 })
    expect(DOC.slice(range!.start, range!.end)).toBe('bravo')
  })

  it('normalizes a selection dragged backwards', () => {
    // Dragging right-to-left reports head before anchor; the range must still
    // read low-to-high or every slice downstream is inverted.
    const cm = fakeCodeMirror(DOC)
    const start = DOC.indexOf('bravo')
    cm.__select(start + 5, start)

    expect(codeMirrorSurface(cm).getSelectionRange()).toEqual({ start, end: start + 5 })
  })

  it('replaces the whole document without clobbering undo history', () => {
    // `setValue` would be the obvious call and would silently destroy the undo
    // stack, making an AI edit unundoable. Assert we splice instead.
    const cm = fakeCodeMirror(DOC)
    const setValue = vi.fn()
    ;(cm as unknown as { setValue: unknown }).setValue = setValue

    codeMirrorSurface(cm).replaceAll('# New\n\nbody')

    expect(cm.getValue()).toBe('# New\n\nbody')
    expect(setValue).not.toHaveBeenCalled()
  })

  it('round-trips a splice at an offset', () => {
    const cm = fakeCodeMirror(DOC)
    const surface = codeMirrorSurface(cm)
    const start = DOC.indexOf('bravo')
    const updated = DOC.slice(0, start) + 'BRAVISSIMO' + DOC.slice(start + 5)

    surface.replaceAll(updated)
    surface.select(updated, start, start + 'BRAVISSIMO'.length)

    expect(surface.getMarkdown()).toBe(updated)
    expect(surface.getSelectionRange()).toEqual({ start, end: start + 10 })
  })

  it('places a caret when start and end coincide', () => {
    // How the comment path parks the caret after a closing marker.
    const cm = fakeCodeMirror(DOC)
    const surface = codeMirrorSurface(cm)
    surface.select(DOC, 9, 9)
    expect(surface.getSelectionRange()).toEqual({ start: 9, end: 9 })
  })

  it('reports selection geometry spanning both ends', () => {
    const cm = fakeCodeMirror(DOC)
    cm.__select(DOC.indexOf('alpha'), DOC.indexOf('echo') + 4)

    const anchor = codeMirrorSurface(cm).selectionRect()
    expect(anchor).not.toBeNull()
    // Top comes from the earlier line, bottom from the later one.
    expect(anchor!.rect.top).toBeLessThan(anchor!.rect.bottom)
    expect(anchor!.columnRight).toBe(640)
  })
})

describe('muyaSurface', () => {
  const muya = (markdown: string, cursor: unknown) => ({
    getMarkdown: () => markdown,
    getCursorOffset: () => cursor as { anchor?: unknown; focus?: unknown } | null,
    replaceContent: vi.fn(),
    setCursorByOffset: vi.fn()
  })

  it('converts line/ch cursors into document offsets', () => {
    const editor = muya(DOC, { anchor: { line: 2, ch: 6 }, focus: { line: 2, ch: 11 } })
    const range = muyaSurface(editor).getSelectionRange()
    expect(DOC.slice(range!.start, range!.end)).toBe('bravo')
  })

  it('returns no range when there is no cursor', () => {
    expect(muyaSurface(muya(DOC, null)).getSelectionRange()).toBeNull()
  })

  it('writes through replaceContent, which records an undo boundary', () => {
    const editor = muya(DOC, null)
    muyaSurface(editor).replaceAll('changed')
    expect(editor.replaceContent).toHaveBeenCalledWith('changed')
  })

  it('selects by converting offsets back to line/ch', () => {
    const editor = muya(DOC, null)
    muyaSurface(editor).select(DOC, DOC.indexOf('bravo'), DOC.indexOf('bravo') + 5)
    expect(editor.setCursorByOffset).toHaveBeenCalledWith({
      anchor: { line: 2, ch: 6 },
      focus: { line: 2, ch: 11 }
    })
  })
})
