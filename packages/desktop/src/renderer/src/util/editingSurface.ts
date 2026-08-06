import type { DocumentRange } from './documentRange'
import { offsetToLineCh, toDocumentRange } from './documentRange'

// The AI features never needed a WYSIWYG editor — they only ever needed to read
// the document markdown, learn which part of it is selected, and splice text
// back in. Muya and CodeMirror can both answer those questions, so this is the
// seam that lets the same assistant, comments, and history code drive either
// one. Without it every handler grows a `sourceCode ? … : …` branch and the two
// paths drift.

/** Viewport-space geometry of a selection, for placing the comment composer. */
export interface SelectionAnchorRect {
  rect: { top: number; bottom: number; left: number; right: number }
  /**
   * Right edge of the *text column*, not of the pane. The composer sits beside
   * the commented text, so it needs where the words stop, not where the
   * viewport does.
   */
  columnRight: number
}

export interface EditingSurface {
  getMarkdown(): string
  /** The selection as a `[start, end)` range over {@link getMarkdown}. */
  getSelectionRange(): DocumentRange | null
  /**
   * Replaces the whole document, recording an undo boundary so the edit is one
   * Ctrl+Z away. Both backends have a whole-document write that does this;
   * neither has a usable "replace the current selection" primitive.
   */
  replaceAll(markdown: string): void
  /** Selects `[start, end)` over the *new* markdown, which the caller passes in. */
  select(markdown: string, start: number, end: number): void
  selectionRect(): SelectionAnchorRect | null
}

/** The slice of Muya's API this module uses. */
export interface MuyaLike {
  getMarkdown(): string
  getCursorOffset(): { anchor?: unknown; focus?: unknown } | null | undefined
  replaceContent(markdown: string): void
  setCursorByOffset(cursor: { anchor: unknown; focus: unknown }): void
}

/** The slice of the CodeMirror 5 API this module uses. */
export interface CodeMirrorLike {
  getValue(): string
  getCursor(which: string): { line: number; ch: number }
  indexFromPos(pos: { line: number; ch: number }): number
  posFromIndex(index: number): { line: number; ch: number }
  replaceRange(
    text: string,
    from: { line: number; ch: number },
    to: { line: number; ch: number }
  ): void
  setSelection(
    anchor: { line: number; ch: number },
    head: { line: number; ch: number },
    options?: Record<string, unknown>
  ): void
  lastLine(): number
  getLine(line: number): string
  cursorCoords(
    pos: { line: number; ch: number },
    mode: string
  ): { top: number; bottom: number; left: number; right: number }
  getWrapperElement(): HTMLElement
  focus(): void
}

export const muyaSurface = (editor: MuyaLike): EditingSurface => ({
  getMarkdown: () => editor.getMarkdown(),

  getSelectionRange: () => {
    const cursor = editor.getCursorOffset()
    if (!cursor) return null
    return toDocumentRange(
      editor.getMarkdown(),
      cursor.anchor as { line: number; ch: number } | null,
      cursor.focus as { line: number; ch: number } | null
    )
  },

  replaceAll: (markdown) => {
    editor.replaceContent(markdown)
  },

  select: (markdown, start, end) => {
    editor.setCursorByOffset({
      anchor: offsetToLineCh(markdown, start),
      focus: offsetToLineCh(markdown, end)
    })
  },

  selectionRect: () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const rect = range.getBoundingClientRect()

    // `.editor-component` fills the pane, so its right edge is useless for
    // placement; the paragraph element gives the real text-column edge.
    const startNode = range.startContainer
    const block =
      startNode.nodeType === Node.ELEMENT_NODE
        ? (startNode as Element)
        : startNode.parentElement

    return {
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      columnRight: block?.getBoundingClientRect().right ?? rect.right
    }
  }
})

export const codeMirrorSurface = (cm: CodeMirrorLike): EditingSurface => {
  const endOfDocument = () => {
    const line = cm.lastLine()
    return { line, ch: cm.getLine(line).length }
  }

  return {
    getMarkdown: () => cm.getValue(),

    getSelectionRange: () => {
      const anchor = cm.indexFromPos(cm.getCursor('anchor'))
      const head = cm.indexFromPos(cm.getCursor('head'))
      return { start: Math.min(anchor, head), end: Math.max(anchor, head) }
    },

    // A whole-document `replaceRange` rather than `setValue`: setValue clears
    // CodeMirror's undo history, which would make an AI edit unundoable —
    // exactly the guarantee `replaceContent` gives on the Muya side.
    replaceAll: (markdown) => {
      cm.replaceRange(markdown, { line: 0, ch: 0 }, endOfDocument())
    },

    select: (_markdown, start, end) => {
      cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(end), { scroll: true })
    },

    selectionRect: () => {
      const from = cm.cursorCoords(cm.getCursor('from'), 'window')
      const to = cm.cursorCoords(cm.getCursor('to'), 'window')
      const lines = cm.getWrapperElement().querySelector('.CodeMirror-lines')
      const columnRight = (lines ?? cm.getWrapperElement()).getBoundingClientRect().right

      return {
        rect: {
          top: Math.min(from.top, to.top),
          bottom: Math.max(from.bottom, to.bottom),
          left: Math.min(from.left, to.left),
          right: Math.max(from.right, to.right)
        },
        columnRight
      }
    }
  }
}
