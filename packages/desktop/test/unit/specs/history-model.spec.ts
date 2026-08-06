import { describe, expect, it } from 'vitest'
import type { SnapshotMeta } from '@shared/types/history'
import {
  LARGE_CHANGE_CHARS,
  describeTrigger,
  diffLines,
  formatAge,
  isLargeChange,
  measureChange,
  planPruning
} from '@shared/types/history'

// The pure half of version history: deciding when a change is big enough to
// snapshot, diffing two versions for the restore preview, and choosing what to
// prune. Storage and UI sit on top of these.

const snapshot = (over: Partial<SnapshotMeta> & { seq: number }): SnapshotMeta => ({
  createdAt: 0,
  trigger: 'periodic',
  bytes: 10,
  hash: `h${over.seq}`,
  lineCount: 1,
  ...over
})

describe('measureChange', () => {
  it('reports nothing changed for identical text', () => {
    const magnitude = measureChange('one\ntwo', 'one\ntwo')
    expect(magnitude.changedLines).toBe(0)
    expect(magnitude.charDelta).toBe(0)
    expect(magnitude.ratio).toBe(0)
  })

  it('counts a rewritten line as one out and one in', () => {
    const magnitude = measureChange('one\ntwo', 'one\nTWO')
    expect(magnitude.changedLines).toBe(2)
    expect(magnitude.totalLines).toBe(2)
  })

  it('counts added lines', () => {
    expect(measureChange('one', 'one\ntwo\nthree').changedLines).toBe(2)
  })

  it('ignores reordering', () => {
    // Moving a paragraph is not the kind of change the trigger looks for, and
    // an order-sensitive count would fire on every reorder.
    expect(measureChange('a\nb\nc', 'c\na\nb').changedLines).toBe(0)
  })

  it('handles empty documents without dividing by zero', () => {
    expect(measureChange('', '').ratio).toBe(0)
  })
})

describe('isLargeChange', () => {
  it('fires on a big paste regardless of structure', () => {
    const pasted = 'x'.repeat(LARGE_CHANGE_CHARS + 1)
    expect(isLargeChange(measureChange('short', `short${pasted}`))).toBe(true)
  })

  it('fires on a big deletion', () => {
    const long = 'x'.repeat(LARGE_CHANGE_CHARS + 1)
    expect(isLargeChange(measureChange(long, ''))).toBe(true)
  })

  it('fires when a good share of the lines change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = Array.from({ length: 20 }, (_, i) => (i < 8 ? `CHANGED ${i}` : `line ${i}`)).join(
      '\n'
    )
    expect(isLargeChange(measureChange(before, after))).toBe(true)
  })

  it('ignores ordinary typing', () => {
    // A word added to one paragraph of a long document must not snapshot.
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 7', 'line 7 with a word added')
    expect(isLargeChange(measureChange(before, after))).toBe(false)
  })

  it('does not trip on a tiny document changing one line', () => {
    // Two lines of three changing is 33% — over the ratio, under the floor.
    expect(isLargeChange(measureChange('a\nb\nc', 'a\nB\nc'))).toBe(false)
  })
})

describe('diffLines', () => {
  it('marks unchanged lines equal', () => {
    const diff = diffLines('a\nb', 'a\nb')
    expect(diff.lines.every((line) => line.op === 'equal')).toBe(true)
    expect(diff.added).toBe(0)
    expect(diff.removed).toBe(0)
  })

  it('reports an insertion without disturbing its neighbours', () => {
    const diff = diffLines('a\nc', 'a\nb\nc')
    expect(diff.lines.map((l) => `${l.op}:${l.text}`)).toEqual([
      'equal:a',
      'insert:b',
      'equal:c'
    ])
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(0)
  })

  it('reports a deletion', () => {
    const diff = diffLines('a\nb\nc', 'a\nc')
    expect(diff.lines.map((l) => `${l.op}:${l.text}`)).toEqual([
      'equal:a',
      'delete:b',
      'equal:c'
    ])
    expect(diff.removed).toBe(1)
  })

  it('reports a rewritten line as a delete plus an insert', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc')
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.lines.filter((l) => l.op === 'equal')).toHaveLength(2)
  })

  it('handles one side being empty', () => {
    expect(diffLines('', 'a\nb').added).toBe(2)
    expect(diffLines('a\nb', '').removed).toBe(2)
  })

  it('keeps every original line somewhere in the output', () => {
    // A diff that silently drops content would make the preview a lie.
    const before = 'alpha\nbeta\ngamma\ndelta'
    const after = 'alpha\nGAMMA\ndelta\nepsilon'
    const diff = diffLines(before, after)

    const kept = diff.lines.filter((l) => l.op !== 'insert').map((l) => l.text)
    expect(kept).toEqual(before.split('\n'))
    const produced = diff.lines.filter((l) => l.op !== 'delete').map((l) => l.text)
    expect(produced).toEqual(after.split('\n'))
  })
})

describe('planPruning', () => {
  it('keeps everything below the budget', () => {
    const snapshots = [snapshot({ seq: 1 }), snapshot({ seq: 2 })]
    expect(planPruning(snapshots, 10)).toEqual([])
  })

  it('drops the oldest once over budget', () => {
    const snapshots = [1, 2, 3, 4, 5].map((seq) => snapshot({ seq }))
    expect(planPruning(snapshots, 3)).toEqual([1, 2])
  })

  it('never prunes a manual checkpoint', () => {
    // The user named it, which is the clearest signal it matters.
    const snapshots = [
      snapshot({ seq: 1, trigger: 'manual', label: 'before the rewrite' }),
      snapshot({ seq: 2 }),
      snapshot({ seq: 3 }),
      snapshot({ seq: 4 })
    ]
    expect(planPruning(snapshots, 2)).toEqual([2, 3])
  })

  it('never prunes the newest snapshot', () => {
    const snapshots = [snapshot({ seq: 1 }), snapshot({ seq: 2 })]
    // Even asking for zero entries must leave the most recent one behind.
    expect(planPruning(snapshots, 0)).not.toContain(2)
  })
})

describe('formatAge', () => {
  const now = 1_000_000_000_000

  it('describes recent, minute, hour and day scales', () => {
    expect(formatAge(now - 5_000, now)).toBe('just now')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatAge(now - 2 * 86_400_000, now)).toBe('2d ago')
  })

  it('does not render a negative age from clock skew', () => {
    expect(formatAge(now + 10_000, now)).toBe('just now')
  })
})

describe('describeTrigger', () => {
  it('prefers a user label over the trigger', () => {
    expect(
      describeTrigger(snapshot({ seq: 1, trigger: 'manual', label: 'before the rewrite' }))
    ).toBe('before the rewrite')
  })

  it('names each automatic trigger', () => {
    expect(describeTrigger(snapshot({ seq: 1, trigger: 'save' }))).toBe('Saved')
    expect(describeTrigger(snapshot({ seq: 1, trigger: 'periodic' }))).toBe('Autosaved')
    expect(describeTrigger(snapshot({ seq: 1, trigger: 'large-change' }))).toBe('Large edit')
    expect(describeTrigger(snapshot({ seq: 1, trigger: 'pre-ai' }))).toBe('Before AI edit')
  })
})
