import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log'
import writeFileAtomic from 'write-file-atomic'
import type { HistoryIndex, SnapshotMeta, SnapshotTrigger } from '../../shared/types/history'
import { planPruning } from '../../shared/types/history'

// Version history on disk.
//
// Each file gets a directory under the app's userData, named for a hash of its
// absolute path. Keeping history out of the user's own folders means it works
// for documents anywhere on disk and never leaves clutter beside them; the
// tradeoff is that it does not travel with the file to another machine.
//
// Snapshots are whole documents, gzipped. Markdown compresses well and a
// self-contained snapshot cannot be broken by a bad patch earlier in the
// chain — restoring is a read, not a replay.

const INDEX_FILE = 'meta.json'

/**
 * Directory name for a file's history. The full hash would be unwieldy in a
 * path; 32 hex characters is far more than enough to avoid collisions across
 * one user's documents.
 */
const directoryFor = (filePath: string): string =>
  path.join(
    app.getPath('userData'),
    'history',
    createHash('sha256').update(filePath).digest('hex').slice(0, 32)
  )

const indexPathFor = (filePath: string): string => path.join(directoryFor(filePath), INDEX_FILE)

const snapshotPathFor = (filePath: string, seq: number): string =>
  path.join(directoryFor(filePath), `${String(seq).padStart(6, '0')}.md.gz`)

export const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex')

/** Reads a file's index, treating anything unreadable as "no history yet". */
export const readIndex = async(filePath: string): Promise<HistoryIndex> => {
  try {
    const raw = await fs.readFile(indexPathFor(filePath), 'utf8')
    const parsed = JSON.parse(raw) as HistoryIndex
    if (!Array.isArray(parsed.snapshots)) return { filePath, snapshots: [] }
    return { filePath, snapshots: parsed.snapshots }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // A corrupt index must not wedge the editor. The snapshots themselves may
      // survive, but without the index they cannot be listed, so start fresh
      // rather than refusing to record anything new.
      log.error('[history] Unreadable index; starting a new one.', error)
    }
    return { filePath, snapshots: [] }
  }
}

const writeIndex = async(index: HistoryIndex): Promise<void> => {
  await fs.mkdir(directoryFor(index.filePath), { recursive: true })
  await writeFileAtomic(indexPathFor(index.filePath), JSON.stringify(index, null, 2))
}

/**
 * Records a new version.
 *
 * Returns null when the content is byte-identical to the newest snapshot —
 * saving an unchanged file, or an idle tick with no edits, should not fill the
 * timeline with duplicates.
 */
export const captureSnapshot = async(
  filePath: string,
  content: string,
  trigger: SnapshotTrigger,
  label?: string
): Promise<SnapshotMeta | null> => {
  const index = await readIndex(filePath)
  const hash = hashContent(content)
  const newest = index.snapshots[index.snapshots.length - 1]
  if (newest?.hash === hash) return null

  const meta: SnapshotMeta = {
    seq: (newest?.seq ?? 0) + 1,
    createdAt: Date.now(),
    trigger,
    bytes: Buffer.byteLength(content, 'utf8'),
    hash,
    lineCount: content.split('\n').length,
    ...(label ? { label } : {})
  }

  await fs.mkdir(directoryFor(filePath), { recursive: true })
  await writeFileAtomic(snapshotPathFor(filePath, meta.seq), gzipSync(Buffer.from(content, 'utf8')))

  const next = [...index.snapshots, meta]
  const doomed = planPruning(next)
  // Write the index before deleting: an index that lists a missing snapshot is
  // a broken timeline entry, whereas an orphaned file is merely wasted bytes
  // that the next prune will not miss.
  await writeIndex({ filePath, snapshots: next.filter((s) => !doomed.includes(s.seq)) })
  await removeSnapshotFiles(filePath, doomed)

  return meta
}

const removeSnapshotFiles = async(filePath: string, seqs: readonly number[]): Promise<void> => {
  await Promise.all(
    seqs.map(async(seq) => {
      try {
        await fs.unlink(snapshotPathFor(filePath, seq))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`[history] Could not delete snapshot ${seq}.`, error)
        }
      }
    })
  )
}

export const listSnapshots = async(filePath: string): Promise<SnapshotMeta[]> =>
  (await readIndex(filePath)).snapshots

/** Returns a snapshot's text, or null when its file is missing or unreadable. */
export const readSnapshot = async(filePath: string, seq: number): Promise<string | null> => {
  try {
    const compressed = await fs.readFile(snapshotPathFor(filePath, seq))
    return gunzipSync(compressed).toString('utf8')
  } catch (error) {
    log.error(`[history] Could not read snapshot ${seq}.`, error)
    return null
  }
}

/** Renames or labels an existing snapshot, turning it into a named checkpoint. */
export const labelSnapshot = async(
  filePath: string,
  seq: number,
  label: string
): Promise<SnapshotMeta[]> => {
  const index = await readIndex(filePath)
  const trimmed = label.trim()
  // Labelling promotes a snapshot to a manual checkpoint, which also exempts it
  // from pruning — naming something is a request to keep it.
  const snapshots = index.snapshots.map((snapshot) => {
    if (snapshot.seq !== seq) return snapshot
    return { ...snapshot, label: trimmed || undefined, trigger: 'manual' as const }
  })
  await writeIndex({ filePath, snapshots })
  return snapshots
}

export const deleteSnapshot = async(filePath: string, seq: number): Promise<SnapshotMeta[]> => {
  const index = await readIndex(filePath)
  const snapshots = index.snapshots.filter((snapshot) => snapshot.seq !== seq)
  await writeIndex({ filePath, snapshots })
  await removeSnapshotFiles(filePath, [seq])
  return snapshots
}

/** Drops a file's entire history. */
export const clearHistory = async(filePath: string): Promise<void> => {
  try {
    await fs.rm(directoryFor(filePath), { recursive: true, force: true })
  } catch (error) {
    log.error('[history] Could not clear history.', error)
  }
}
