// Word-style review comments anchored in the document itself.
//
// Two shapes, both HTML comments so they are invisible to other renderers:
//
//   span   <!--ai: soften this-->maternity (12 months)<!--/ai-->
//   block  <!--ai: tighten this-->
//          The whole paragraph beneath the marker is the target.
//
// Storing the anchor *as document text* is the whole trick. The user keeps
// editing while requests are in flight, and markers that live in the text move
// with their edits for free — no offset re-anchoring, no fingerprint search —
// and they survive save/close/reopen because they are simply part of the file.
// The paired form is Word's own model: an anchor with a start and an end.
//
// The cost is that markers are real content: they are stripped before export,
// and resolving a comment removes them.

/** `ai` dispatches a rewrite request; `note` is a reminder that never does. */
export type AiCommentKind = 'ai' | 'note'

/** Whether the comment covers an exact selection or the paragraph below it. */
export type AiCommentScope = 'span' | 'block'

/**
 * Opening marker. The lazy body plus the required `-->` means a half-typed
 * comment does not match — which is what makes "run as soon as it is written"
 * safe, since the closing token is the completion signal.
 */
export const AI_COMMENT_OPEN_PATTERN = /<!--\s*(ai|note):\s*([\s\S]*?)-->/g

/** Closing marker of a span comment. */
export const AI_COMMENT_CLOSE_PATTERN = /<!--\s*\/(ai|note)\s*-->/g

/** Every marker, used when stripping a document for export. */
const ANY_MARKER_PATTERN = /<!--\s*(?:\/(?:ai|note)\s*|(?:ai|note):[\s\S]*?)-->/g

export interface ParsedAiComment {
  kind: AiCommentKind
  scope: AiCommentScope
  instruction: string
  /** Offset of the opening `<!--`. */
  markerStart: number
  /** Offset just past the opening `-->`. */
  markerEnd: number
  /** Offset of the closing `<!--`, for span comments only. */
  closerStart: number
  /** Offset just past the closing `-->`, for span comments only. */
  closerEnd: number
  targetStart: number
  targetEnd: number
  target: string
}

export type AiCommentStatus = 'pending' | 'running' | 'ready' | 'rejected' | 'failed' | 'note'

export interface TrackedAiComment extends ParsedAiComment {
  id: string
  status: AiCommentStatus
  suggestion?: string
  error?: string
}

interface OpenMarker {
  kind: AiCommentKind
  instruction: string
  start: number
  end: number
}

interface CloseMarker {
  kind: AiCommentKind
  start: number
  end: number
}

const findOpenMarkers = (markdown: string): OpenMarker[] => {
  const pattern = new RegExp(AI_COMMENT_OPEN_PATTERN.source, 'g')
  const found: OpenMarker[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    const instruction = match[2].trim()
    // `<!--ai:-->` carries no instruction; treat it as not-yet-written rather
    // than dispatching an empty prompt.
    if (instruction) {
      found.push({
        kind: match[1] as AiCommentKind,
        instruction,
        start: match.index,
        end: match.index + match[0].length
      })
    }
  }
  return found
}

const findCloseMarkers = (markdown: string): CloseMarker[] => {
  const pattern = new RegExp(AI_COMMENT_CLOSE_PATTERN.source, 'g')
  const found: CloseMarker[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    found.push({
      kind: match[1] as AiCommentKind,
      start: match.index,
      end: match.index + match[0].length
    })
  }
  return found
}

/**
 * A block marker governs the text following it, up to the next blank line — the
 * paragraph it sits above. Whitespace between the two is skipped because Muya
 * separates blocks with a blank line. Stopping at a following marker keeps two
 * adjacent comments from claiming the same text.
 */
const findBlockTarget = (
  markdown: string,
  markerEnd: number,
  nextMarkerStart: number
): { start: number; end: number } => {
  const limit = nextMarkerStart >= 0 ? nextMarkerStart : markdown.length

  let start = markerEnd
  while (start < limit && /\s/.test(markdown[start])) start++

  const blankLine = markdown.indexOf('\n\n', start)
  const end = blankLine >= 0 && blankLine < limit ? blankLine : limit

  let trimmed = end
  while (trimmed > start && /\s/.test(markdown[trimmed - 1])) trimmed--

  return { start, end: trimmed }
}

/**
 * Finds every complete comment in document order.
 *
 * An opener is a span comment when a matching closer of the same kind appears
 * before the next opener of that kind; otherwise it falls back to governing the
 * paragraph beneath it, which keeps block-level comments working unchanged.
 */
export const parseAiComments = (markdown: string): ParsedAiComment[] => {
  const opens = findOpenMarkers(markdown)
  const closes = findCloseMarkers(markdown)

  return opens.map((open, index) => {
    const nextSameKind = opens.find((o, i) => i > index && o.kind === open.kind)
    const closer = closes.find(
      (c) =>
        c.start >= open.end &&
        c.kind === open.kind &&
        (!nextSameKind || c.start < nextSameKind.start)
    )

    if (closer) {
      return {
        kind: open.kind,
        scope: 'span' as const,
        instruction: open.instruction,
        markerStart: open.start,
        markerEnd: open.end,
        closerStart: closer.start,
        closerEnd: closer.end,
        targetStart: open.end,
        targetEnd: closer.start,
        target: markdown.slice(open.end, closer.start)
      }
    }

    const nextOpen = opens[index + 1]
    const { start, end } = findBlockTarget(markdown, open.end, nextOpen ? nextOpen.start : -1)
    return {
      kind: open.kind,
      scope: 'block' as const,
      instruction: open.instruction,
      markerStart: open.start,
      markerEnd: open.end,
      closerStart: -1,
      closerEnd: -1,
      targetStart: start,
      targetEnd: end,
      target: markdown.slice(start, end)
    }
  })
}

/** Whether a comment has text to act on. */
export const hasTarget = (comment: ParsedAiComment): boolean => comment.target.trim().length > 0

/** Notes are never dispatched to a provider. */
export const isDispatchable = (comment: ParsedAiComment): boolean =>
  comment.kind === 'ai' && hasTarget(comment)

/** Builds the marker text that wraps a selection. */
export const buildSpanMarkers = (
  kind: AiCommentKind,
  instruction: string
): { open: string; close: string } => ({
  open: `<!--${kind}: ${instruction.trim()}-->`,
  close: `<!--/${kind}-->`
})

export interface ReconcileResult {
  comments: TrackedAiComment[]
  /** Comments seen for the first time — the ones worth dispatching. */
  added: TrackedAiComment[]
}

/**
 * Merges a fresh scan into the comments already tracked.
 *
 * Markers have no ids of their own (an id in the text would be extra clutter
 * the user has to look at), so a marker is re-identified across scans by its
 * instruction plus proximity to where it was last seen. That handles the two
 * cases that actually happen: text inserted above shifting every offset, and
 * several markers sharing one instruction.
 *
 * A comment whose target text changed drops back to `pending`: the suggestion
 * that came back was a rewrite of different words and must not be offered for
 * text the user has since edited.
 */
export const reconcileAiComments = (
  previous: readonly TrackedAiComment[],
  parsed: readonly ParsedAiComment[],
  nextId: () => string
): ReconcileResult => {
  const unclaimed = new Set(previous)
  const comments: TrackedAiComment[] = []
  const added: TrackedAiComment[] = []

  for (const entry of parsed) {
    let best: TrackedAiComment | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of unclaimed) {
      if (candidate.instruction !== entry.instruction || candidate.kind !== entry.kind) continue
      const distance = Math.abs(candidate.markerStart - entry.markerStart)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }

    const initialStatus: AiCommentStatus = entry.kind === 'note' ? 'note' : 'pending'

    if (!best) {
      const fresh: TrackedAiComment = { ...entry, id: nextId(), status: initialStatus }
      comments.push(fresh)
      added.push(fresh)
      continue
    }

    unclaimed.delete(best)
    const targetChanged = best.target !== entry.target
    comments.push({
      ...entry,
      id: best.id,
      status: targetChanged ? initialStatus : best.status,
      suggestion: targetChanged ? undefined : best.suggestion,
      error: targetChanged ? undefined : best.error
    })
  }

  return { comments, added }
}

/**
 * Re-finds a tracked comment in the current document text.
 *
 * The offsets carried on a `TrackedAiComment` come from the last scan, which is
 * debounced — by the time the user clicks Accept they can be several keystrokes
 * stale. Editing the document must therefore go through a fresh resolve rather
 * than trusting stored offsets, or the splice lands in the wrong place.
 */
export const resolveAiComment = (
  markdown: string,
  comment: TrackedAiComment
): ParsedAiComment | null => {
  let best: ParsedAiComment | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of parseAiComments(markdown)) {
    if (candidate.instruction !== comment.instruction || candidate.kind !== comment.kind) continue
    const distance = Math.abs(candidate.markerStart - comment.markerStart)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  return best
}

/** Trailing newlines a block marker leaves behind when it is removed. */
const skipNewlines = (markdown: string, from: number, limit: number): number => {
  let index = from
  while (index < limit && markdown[index] === '\n') index++
  return index
}

/**
 * Removes a comment's markers and replaces its target with `replacement` —
 * the "accept" operation, which resolves the comment the same way closing a
 * Word comment does.
 *
 * `expectedTarget` guards against the text having changed since the suggestion
 * was produced; a mismatch returns null so the caller can refuse rather than
 * overwrite words the model never saw.
 */
export const applyAiComment = (
  markdown: string,
  comment: ParsedAiComment,
  replacement: string,
  expectedTarget: string
): string | null => {
  const { markerStart, markerEnd, targetStart, targetEnd, closerEnd, scope } = comment
  if (markerStart < 0 || targetEnd > markdown.length) return null
  if (markdown.slice(targetStart, targetEnd) !== expectedTarget) return null

  if (scope === 'span') {
    if (closerEnd > markdown.length) return null
    return markdown.slice(0, markerStart) + replacement + markdown.slice(closerEnd)
  }

  // Drop the marker's own trailing newline too, so resolving a comment does not
  // leave a blank line where it used to be.
  const gapEnd = skipNewlines(markdown, markerEnd, targetStart)
  return (
    markdown.slice(0, markerStart) +
    markdown.slice(gapEnd, targetStart) +
    replacement +
    markdown.slice(targetEnd)
  )
}

/** Removes a comment's markers while leaving its text untouched — "dismiss". */
export const removeAiComment = (markdown: string, comment: ParsedAiComment): string | null => {
  const { markerStart, markerEnd, targetStart, targetEnd, closerEnd, scope } = comment
  if (markerStart < 0 || markerEnd > markdown.length) return null

  if (scope === 'span') {
    if (closerEnd > markdown.length) return null
    return (
      markdown.slice(0, markerStart) +
      markdown.slice(targetStart, targetEnd) +
      markdown.slice(closerEnd)
    )
  }

  const gapEnd = skipNewlines(markdown, markerEnd, markdown.length)
  // Keep one newline so the paragraph does not weld onto the previous line.
  const separator = gapEnd > markerEnd ? '\n' : ''
  return markdown.slice(0, markerStart) + separator + markdown.slice(gapEnd)
}

/**
 * Strips every marker from a document — used on export so review notes never
 * reach a PDF or an HTML file. Span text is preserved; only the markers go.
 */
export const stripAiComments = (markdown: string): string =>
  markdown.replace(new RegExp(`${ANY_MARKER_PATTERN.source}\\n?`, 'g'), '')
