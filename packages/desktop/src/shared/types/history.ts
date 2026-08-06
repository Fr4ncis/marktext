// File version history — the data model and the pure logic behind it.
//
// Snapshots are whole-document copies rather than patches. Markdown files are
// small, gzip handles the redundancy, and a self-contained snapshot can never
// be corrupted by a broken patch chain earlier in the timeline — restoring is
// a file read, not a replay.
//
// Nothing here touches the filesystem or Electron, so all of it is unit
// testable and safe to import from either process.

/** Why a snapshot was taken. Shown in the timeline so versions are scannable. */
export type SnapshotTrigger = 'save' | 'periodic' | 'large-change' | 'manual' | 'pre-ai'

export interface SnapshotMeta {
  /** Monotonic per file; also the storage filename. */
  seq: number
  /** Epoch milliseconds. */
  createdAt: number
  trigger: SnapshotTrigger
  /** User-supplied name for a manual checkpoint. */
  label?: string
  /** Uncompressed size, for the storage figure in the UI. */
  bytes: number
  /** sha256 of the content — lets identical states be skipped. */
  hash: string
  lineCount: number
}

/** The on-disk index for one file's history. */
export interface HistoryIndex {
  /** Absolute path, kept so an entry can be identified after a rename. */
  filePath: string
  /** Oldest first. */
  snapshots: SnapshotMeta[]
}

// ---------------------------------------------------------------------------
// Change measurement
//
// The "snapshot on a big change" trigger needs a magnitude that is cheap enough
// to compute on every idle scan. Line-level comparison is the right grain for
// markdown — a reworded sentence is one changed line, a pasted or deleted
// section is many — and it costs a fraction of a character-level diff.

export interface ChangeMagnitude {
  /** Lines present in one version but not the other, counted both ways. */
  changedLines: number
  /** Line count of the larger version, the denominator for `ratio`. */
  totalLines: number
  /** Signed character difference; a large paste or deletion shows up here. */
  charDelta: number
  /** `changedLines / totalLines`, 0 when both are empty. */
  ratio: number
}

/**
 * A rewrite this size is worth its own version even if the shape of the
 * document barely moved — pasting or deleting several paragraphs.
 */
export const LARGE_CHANGE_CHARS = 500

/** Proportion of lines that must differ for a structural change to count. */
export const LARGE_CHANGE_RATIO = 0.25

/** Floor so a two-line note does not snapshot on every other keystroke. */
export const LARGE_CHANGE_MIN_LINES = 3

/** Above this, the diff is skipped and only cheap signals are used. */
export const DIFF_LINE_LIMIT = 5000

const toLines = (text: string): string[] => text.split('\n')

/**
 * Counts lines that differ, treating the two versions as multisets.
 *
 * This deliberately ignores order: moving a paragraph is not the kind of
 * "large change" the trigger is looking for, and an order-sensitive count
 * would fire on every reorder.
 */
const countChangedLines = (previous: string[], next: string[]): number => {
  const counts = new Map<string, number>()
  for (const line of previous) counts.set(line, (counts.get(line) ?? 0) + 1)

  let added = 0
  for (const line of next) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else added++
  }

  let removed = 0
  for (const remaining of counts.values()) removed += remaining

  return added + removed
}

export const measureChange = (previous: string, next: string): ChangeMagnitude => {
  const previousLines = toLines(previous)
  const nextLines = toLines(next)
  const totalLines = Math.max(previousLines.length, nextLines.length)

  const changedLines =
    totalLines > DIFF_LINE_LIMIT ? 0 : countChangedLines(previousLines, nextLines)

  return {
    changedLines,
    totalLines,
    charDelta: next.length - previous.length,
    ratio: totalLines === 0 ? 0 : changedLines / totalLines
  }
}

/**
 * Whether a change earns its own version.
 *
 * Either a lot of text moved (a paste or a deletion), or a meaningful share of
 * the document's lines changed. The line floor keeps very small documents from
 * tripping the ratio on a single edit.
 */
export const isLargeChange = (magnitude: ChangeMagnitude): boolean => {
  if (Math.abs(magnitude.charDelta) >= LARGE_CHANGE_CHARS) return true
  return (
    magnitude.changedLines >= LARGE_CHANGE_MIN_LINES &&
    magnitude.ratio >= LARGE_CHANGE_RATIO
  )
}

// ---------------------------------------------------------------------------
// Line diff, for the preview shown before restoring

export type DiffOp = 'equal' | 'insert' | 'delete'

export interface DiffLine {
  op: DiffOp
  text: string
}

export interface DiffSummary {
  lines: DiffLine[]
  added: number
  removed: number
  /** True when the documents were too large to diff exactly. */
  truncated: boolean
}

/**
 * Longest-common-subsequence line diff.
 *
 * O(n·m) in lines, which is fine for prose but not for a generated file with
 * tens of thousands of lines — past `DIFF_LINE_LIMIT` it reports the change
 * wholesale rather than locking the renderer for seconds.
 */
export const diffLines = (previous: string, next: string): DiffSummary => {
  const a = toLines(previous)
  const b = toLines(next)

  if (a.length > DIFF_LINE_LIMIT || b.length > DIFF_LINE_LIMIT) {
    return {
      lines: [
        ...a.map((text): DiffLine => ({ op: 'delete', text })),
        ...b.map((text): DiffLine => ({ op: 'insert', text }))
      ],
      added: b.length,
      removed: a.length,
      truncated: true
    }
  }

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: 'equal', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ op: 'delete', text: a[i] })
      removed++
      i++
    } else {
      lines.push({ op: 'insert', text: b[j] })
      added++
      j++
    }
  }
  while (i < a.length) {
    lines.push({ op: 'delete', text: a[i] })
    removed++
    i++
  }
  while (j < b.length) {
    lines.push({ op: 'insert', text: b[j] })
    added++
    j++
  }

  return { lines, added, removed, truncated: false }
}

// ---------------------------------------------------------------------------
// Retention

/** Snapshots kept per file before unlabelled ones start being dropped. */
export const MAX_SNAPSHOTS_PER_FILE = 200

/**
 * Chooses which snapshots to delete once a file's history outgrows its budget.
 *
 * Manual checkpoints are never pruned — the user named them, which is the
 * clearest possible signal that they matter — and neither is the newest
 * snapshot, which is the one a restore is most likely to want.
 */
export const planPruning = (
  snapshots: readonly SnapshotMeta[],
  maxEntries: number = MAX_SNAPSHOTS_PER_FILE
): number[] => {
  const disposable = snapshots
    .slice(0, Math.max(0, snapshots.length - 1))
    .filter((snapshot) => snapshot.trigger !== 'manual')

  const excess = snapshots.length - maxEntries
  if (excess <= 0) return []

  // Oldest disposable first, so the timeline thins out at the far end.
  return disposable.slice(0, excess).map((snapshot) => snapshot.seq)
}

/** Human-readable relative age, for timeline entries. */
export const formatAge = (createdAt: number, now: number = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/** Label shown against a timeline entry. */
export const describeTrigger = (snapshot: SnapshotMeta): string => {
  if (snapshot.label) return snapshot.label
  switch (snapshot.trigger) {
    case 'save':
      return 'Saved'
    case 'periodic':
      return 'Autosaved'
    case 'large-change':
      return 'Large edit'
    case 'pre-ai':
      return 'Before AI edit'
    default:
      return 'Checkpoint'
  }
}
