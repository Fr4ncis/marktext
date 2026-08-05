// Muya reports the caret as CodeMirror-style `{ line, ch }` pairs, but a
// rewrite needs to slice and splice the document markdown, which is a flat
// string. These helpers convert between the two, and are kept separate from the
// editor component so the arithmetic is unit-testable without a live editor.

/** One end of a selection in CodeMirror coordinates. */
export interface LineChPosition {
  line: number
  ch: number
}

/** A half-open `[start, end)` span of the document markdown. */
export interface DocumentRange {
  start: number
  end: number
}

/**
 * Byte-free index of where each line begins. Line endings are normalized to
 * `\n` before this runs, so a single offset per line is enough.
 */
const lineStartOffsets = (text: string): number[] => {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/**
 * Converts `{ line, ch }` to a flat offset, clamping out-of-range input rather
 * than throwing: the cursor is captured a tick before it is used, and a stale
 * position should degrade to a sane offset instead of breaking the action.
 */
export const lineChToOffset = (text: string, position: LineChPosition): number => {
  const starts = lineStartOffsets(text)
  const line = Math.min(Math.max(position.line, 0), starts.length - 1)
  const lineStart = starts[line]
  const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length
  const ch = Math.min(Math.max(position.ch, 0), lineEnd - lineStart)
  return lineStart + ch
}

/** Inverse of {@link lineChToOffset}. */
export const offsetToLineCh = (text: string, offset: number): LineChPosition => {
  const clamped = Math.min(Math.max(offset, 0), text.length)
  const starts = lineStartOffsets(text)
  // Last line whose start is at or before `clamped`.
  let line = 0
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= clamped) line = i
    else break
  }
  return { line, ch: clamped - starts[line] }
}

/**
 * Normalizes an anchor/focus pair into an ordered range. Returns null when
 * either end is missing — a cursor with no anchor is not a selection.
 *
 * Anchor and focus are ordered by position because a selection dragged upward
 * reports focus before anchor, and the caller only cares about the span.
 */
export const toDocumentRange = (
  text: string,
  anchor: LineChPosition | null | undefined,
  focus: LineChPosition | null | undefined
): DocumentRange | null => {
  if (!anchor || !focus) return null
  const a = lineChToOffset(text, anchor)
  const b = lineChToOffset(text, focus)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** Whether a range covers at least one non-whitespace character. */
export const isNonEmptyRange = (text: string, range: DocumentRange): boolean =>
  range.end > range.start && text.slice(range.start, range.end).trim().length > 0

/**
 * Splices `replacement` into `text` over `range`.
 *
 * `expected` guards against the document having changed between the moment the
 * selection was captured and the moment the rewrite came back — the user can
 * keep typing while a request is in flight. A mismatch returns null so the
 * caller can tell the user rather than overwriting unrelated text.
 */
export const replaceRange = (
  text: string,
  range: DocumentRange,
  replacement: string,
  expected: string
): string | null => {
  if (range.start < 0 || range.end > text.length || range.start > range.end) return null
  if (text.slice(range.start, range.end) !== expected) return null
  return text.slice(0, range.start) + replacement + text.slice(range.end)
}
