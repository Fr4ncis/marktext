// Word-style review comments addressed to the AI.
//
// A comment is an HTML comment written into the document itself:
//
//     <!--ai: tighten this, drop the passive voice-->
//     The configuration is loaded by the server at startup.
//
// Storing the anchor *as document text* is the whole trick. The user keeps
// editing while requests are in flight, and a marker that lives in the text
// moves with their edits for free — no offset re-anchoring, no fingerprint
// search, and it survives save/close/reopen because it is simply part of the
// file. Other editors render it as nothing, and it is greppable and diffable.
//
// The cost is that the marker is real content: it has to be stripped before
// export, and accepting a suggestion removes it (that is what "resolve" means).

/**
 * Matches a complete marker. The lazy body plus the required `-->` means a
 * half-typed comment does not match — which is what makes "run as soon as it
 * is written" safe, since the closing token is the completion signal.
 */
export const AI_COMMENT_PATTERN = /<!--\s*ai:\s*([\s\S]*?)-->/g

/** A marker found in the document, with the text it applies to. */
export interface ParsedAiComment {
  instruction: string
  /** Offset of `<!--`. */
  markerStart: number
  /** Offset just past `-->`. */
  markerEnd: number
  targetStart: number
  targetEnd: number
  target: string
}

export type AiCommentStatus = 'pending' | 'running' | 'ready' | 'rejected' | 'failed'

/** A parsed marker plus the queue state we hold for it. */
export interface TrackedAiComment extends ParsedAiComment {
  id: string
  status: AiCommentStatus
  /** Populated when status is `ready`. */
  suggestion?: string
  /** Populated when status is `failed`. */
  error?: string
}

/**
 * A marker applies to the text following it, up to the next blank line — the
 * markdown paragraph it sits above. Stopping at a following marker keeps two
 * adjacent comments from claiming the same text.
 */
const findTargetRange = (
  markdown: string,
  markerEnd: number,
  nextMarkerStart: number
): { start: number; end: number } => {
  const limit = nextMarkerStart >= 0 ? nextMarkerStart : markdown.length

  let start = markerEnd
  while (start < limit && /\s/.test(markdown[start])) start++

  const blankLine = markdown.indexOf('\n\n', start)
  const end = blankLine >= 0 && blankLine < limit ? blankLine : limit

  // Trailing whitespace would otherwise ride along into the model request and
  // back out into the document.
  let trimmed = end
  while (trimmed > start && /\s/.test(markdown[trimmed - 1])) trimmed--

  return { start, end: trimmed }
}

/** Finds every complete marker in document order. */
export const parseAiComments = (markdown: string): ParsedAiComment[] => {
  const pattern = new RegExp(AI_COMMENT_PATTERN.source, 'g')
  const raw: Array<{ instruction: string; markerStart: number; markerEnd: number }> = []

  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    const instruction = match[1].trim()
    // `<!--ai:-->` carries no instruction; treat it as not-yet-written rather
    // than dispatching an empty prompt.
    if (instruction) {
      raw.push({
        instruction,
        markerStart: match.index,
        markerEnd: match.index + match[0].length
      })
    }
  }

  return raw.map((entry, index) => {
    const { start, end } = findTargetRange(
      markdown,
      entry.markerEnd,
      index + 1 < raw.length ? raw[index + 1].markerStart : -1
    )
    return {
      ...entry,
      targetStart: start,
      targetEnd: end,
      target: markdown.slice(start, end)
    }
  })
}

/** Whether a comment has text to act on. */
export const hasTarget = (comment: ParsedAiComment): boolean => comment.target.trim().length > 0

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
 * cases that actually happen: text is inserted above, shifting every offset;
 * and several markers share one instruction.
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
      if (candidate.instruction !== entry.instruction) continue
      const distance = Math.abs(candidate.markerStart - entry.markerStart)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }

    if (!best) {
      const fresh: TrackedAiComment = { ...entry, id: nextId(), status: 'pending' }
      comments.push(fresh)
      added.push(fresh)
      continue
    }

    unclaimed.delete(best)
    const targetChanged = best.target !== entry.target
    comments.push({
      ...entry,
      id: best.id,
      status: targetChanged ? 'pending' : best.status,
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
 *
 * Matching mirrors reconciliation: same instruction, nearest marker.
 */
export const resolveAiComment = (
  markdown: string,
  comment: TrackedAiComment
): ParsedAiComment | null => {
  let best: ParsedAiComment | null = null
  let bestDistance = Number.POSITIVE_INFINITY

  for (const candidate of parseAiComments(markdown)) {
    if (candidate.instruction !== comment.instruction) continue
    const distance = Math.abs(candidate.markerStart - comment.markerStart)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }

  return best
}

/**
 * Removes a marker and replaces its target with `replacement`, returning the
 * new document — the "accept" operation, which resolves the comment the same
 * way closing a Word comment does.
 *
 * `expectedTarget` guards against the paragraph having changed since the
 * suggestion was produced; a mismatch returns null so the caller can refuse
 * rather than overwrite words the model never saw.
 */
export const applyAiComment = (
  markdown: string,
  comment: TrackedAiComment,
  replacement: string,
  expectedTarget: string
): string | null => {
  const { markerStart, markerEnd, targetStart, targetEnd } = comment
  if (markerStart < 0 || targetEnd > markdown.length || markerEnd > targetStart) return null
  if (markdown.slice(targetStart, targetEnd) !== expectedTarget) return null

  // Drop the marker's own trailing newline too, so resolving a comment does not
  // leave a blank line where it used to be.
  let gapEnd = markerEnd
  while (gapEnd < targetStart && markdown[gapEnd] === '\n') gapEnd++

  return (
    markdown.slice(0, markerStart) +
    markdown.slice(gapEnd, targetStart) +
    replacement +
    markdown.slice(targetEnd)
  )
}

/** Removes a marker while leaving its target text untouched — "dismiss". */
export const removeAiComment = (markdown: string, comment: TrackedAiComment): string | null => {
  const { markerStart, markerEnd } = comment
  if (markerStart < 0 || markerEnd > markdown.length) return null
  if (!markdown.slice(markerStart, markerEnd).startsWith('<!--')) return null

  let gapEnd = markerEnd
  while (gapEnd < markdown.length && markdown[gapEnd] === '\n') gapEnd++
  // Keep one newline so the paragraph does not weld onto the previous line.
  const separator = gapEnd > markerEnd ? '\n' : ''

  return markdown.slice(0, markerStart) + separator + markdown.slice(gapEnd)
}

/**
 * Strips every marker from a document — used on export so review notes never
 * reach a PDF or an HTML file.
 */
export const stripAiComments = (markdown: string): string =>
  markdown.replace(new RegExp(`${AI_COMMENT_PATTERN.source}\\n?`, 'g'), '')
