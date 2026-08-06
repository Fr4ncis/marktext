import { ipcMain } from 'electron'
import log from 'electron-log'
import type { SnapshotMeta, SnapshotTrigger } from '../../shared/types/history'
import {
  captureSnapshot,
  clearHistory,
  deleteSnapshot,
  labelSnapshot,
  listSnapshots,
  readSnapshot
} from './store'

// The renderer is sandboxed, so every history read and write crosses these
// channels. The renderer supplies the document text; main owns the disk.

export const registerHistoryHandlers = (): void => {
  ipcMain.handle(
    'mt::history::list',
    async(_event, filePath: string): Promise<SnapshotMeta[]> => {
      if (!filePath) return []
      return listSnapshots(filePath)
    }
  )

  ipcMain.handle(
    'mt::history::capture',
    async(
      _event,
      filePath: string,
      content: string,
      trigger: SnapshotTrigger,
      label?: string
    ): Promise<SnapshotMeta | null> => {
      // An unsaved buffer has no path to key history against; it is covered by
      // the separate editor-buffer store until it is first saved.
      if (!filePath) return null
      try {
        return await captureSnapshot(filePath, content, trigger, label)
      } catch (error) {
        // History is a safety net, never a reason to interrupt editing.
        log.error('[history] Capture failed.', error)
        return null
      }
    }
  )

  ipcMain.handle(
    'mt::history::read',
    async(_event, filePath: string, seq: number): Promise<string | null> =>
      filePath ? readSnapshot(filePath, seq) : null
  )

  ipcMain.handle(
    'mt::history::label',
    async(_event, filePath: string, seq: number, label: string): Promise<SnapshotMeta[]> =>
      filePath ? labelSnapshot(filePath, seq, label) : []
  )

  ipcMain.handle(
    'mt::history::delete',
    async(_event, filePath: string, seq: number): Promise<SnapshotMeta[]> =>
      filePath ? deleteSnapshot(filePath, seq) : []
  )

  ipcMain.handle('mt::history::clear', async(_event, filePath: string): Promise<void> => {
    if (filePath) await clearHistory(filePath)
  })
}
