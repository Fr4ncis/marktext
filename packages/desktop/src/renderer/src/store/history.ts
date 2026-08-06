import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { DiffSummary, SnapshotMeta, SnapshotTrigger } from '@shared/types/history'
import { diffLines, isLargeChange, measureChange } from '@shared/types/history'

// Timeline state for the active file. Storage lives in main; this holds the
// index, the current selection, and the diff shown before a restore.

/**
 * How long the document must sit unchanged before a periodic snapshot. Long
 * enough that a burst of typing produces one version rather than twenty.
 */
export const PERIODIC_SNAPSHOT_IDLE_MS = 90_000

export const useHistoryStore = defineStore('history', () => {
  const filePath = ref('')
  const snapshots = ref<SnapshotMeta[]>([])
  /** Latest document text, pushed by the editor so diffs need no round trip. */
  const currentText = ref('')
  const selectedSeq = ref<number | null>(null)
  const selectedText = ref<string | null>(null)
  const loadingSeq = ref<number | null>(null)

  /** Content of the most recent snapshot, the baseline for change detection. */
  let lastCapturedText = ''
  let lastCaptureAt = 0

  /** Newest first — a timeline reads downwards from now. */
  const timeline = computed(() => [...snapshots.value].reverse())
  const hasHistory = computed(() => snapshots.value.length > 0)

  const selected = computed(() =>
    selectedSeq.value === null
      ? null
      : (snapshots.value.find((s) => s.seq === selectedSeq.value) ?? null)
  )

  /** Diff from the selected version to the document as it stands now. */
  const diff = computed<DiffSummary | null>(() =>
    selectedText.value === null ? null : diffLines(selectedText.value, currentText.value)
  )

  const refresh = async(): Promise<void> => {
    if (!filePath.value) {
      snapshots.value = []
      return
    }
    snapshots.value = await window.fileHistory.list(filePath.value)
  }

  /**
   * Points the timeline at a file. Resets the change-detection baseline so a
   * tab switch cannot be mistaken for a large edit.
   */
  const SET_FILE = async(nextPath: string, text: string): Promise<void> => {
    if (filePath.value === nextPath) return
    filePath.value = nextPath
    currentText.value = text
    lastCapturedText = text
    lastCaptureAt = Date.now()
    selectedSeq.value = null
    selectedText.value = null
    await refresh()
  }

  const CAPTURE = async(trigger: SnapshotTrigger, label?: string): Promise<void> => {
    if (!filePath.value) return
    const text = currentText.value
    const created = await window.fileHistory.capture(filePath.value, text, trigger, label)
    // A null result means the content was identical to the newest snapshot.
    lastCapturedText = text
    lastCaptureAt = Date.now()
    if (created) await refresh()
  }

  /**
   * Records the document text and takes a snapshot when it has changed enough,
   * or when enough time has passed since the last one. Called on the editor's
   * debounced change scan, so it must stay cheap.
   */
  const OBSERVE = async(text: string): Promise<void> => {
    currentText.value = text
    if (!filePath.value || text === lastCapturedText) return

    if (isLargeChange(measureChange(lastCapturedText, text))) {
      await CAPTURE('large-change')
      return
    }
    if (Date.now() - lastCaptureAt >= PERIODIC_SNAPSHOT_IDLE_MS) {
      await CAPTURE('periodic')
    }
  }

  const SELECT = async(seq: number | null): Promise<void> => {
    selectedSeq.value = seq
    selectedText.value = null
    if (seq === null || !filePath.value) return

    loadingSeq.value = seq
    try {
      selectedText.value = await window.fileHistory.read(filePath.value, seq)
    } finally {
      loadingSeq.value = null
    }
  }

  const LABEL = async(seq: number, label: string): Promise<void> => {
    if (!filePath.value) return
    snapshots.value = await window.fileHistory.label(filePath.value, seq, label)
  }

  const DELETE = async(seq: number): Promise<void> => {
    if (!filePath.value) return
    snapshots.value = await window.fileHistory.remove(filePath.value, seq)
    if (selectedSeq.value === seq) await SELECT(null)
  }

  const CLEAR = async(): Promise<void> => {
    if (!filePath.value) return
    await window.fileHistory.clear(filePath.value)
    await SELECT(null)
    await refresh()
  }

  /**
   * Called by the editor once a restore has been applied, so the timeline
   * reflects the new state and the baseline does not read the restore itself
   * as a large edit.
   */
  const AFTER_RESTORE = async(text: string): Promise<void> => {
    currentText.value = text
    lastCapturedText = text
    lastCaptureAt = Date.now()
    await SELECT(null)
    await refresh()
  }

  return {
    filePath,
    snapshots,
    timeline,
    hasHistory,
    currentText,
    selectedSeq,
    selectedText,
    selected,
    loadingSeq,
    diff,
    SET_FILE,
    CAPTURE,
    OBSERVE,
    SELECT,
    LABEL,
    DELETE,
    CLEAR,
    AFTER_RESTORE,
    refresh
  }
})
