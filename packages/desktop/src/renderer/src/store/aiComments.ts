import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { TrackedAiComment } from '@shared/types/aiComments'
import { hasTarget, parseAiComments, reconcileAiComments } from '@shared/types/aiComments'
import { describeError, runCompletion, settingsFromPreferences } from '@/services/aiAssistant'
import { usePreferencesStore } from './preferences'
import type { AIProviderId } from '@shared/types/ai'

// Background queue behind the review comments. The editor hands this store the
// document markdown whenever it changes; the store keeps the tracked comments
// in step and dispatches new ones without blocking the user.

/**
 * Requests in flight at once. Small enough to stay under provider rate limits
 * on a document sprinkled with comments, large enough that a handful of
 * markers resolve while the user keeps typing.
 */
const MAX_CONCURRENT = 3

let idCounter = 0
const nextId = (): string => `aic-${++idCounter}`

export const useAiCommentsStore = defineStore('aiComments', () => {
  /**
   * Keyed by file id so switching tabs does not throw away results that are
   * already paid for; the markers themselves live in each document.
   */
  const byFile = ref<Record<string, TrackedAiComment[]>>({})
  const activeFileId = ref<string>('')
  /** Files whose markers have been scanned once, so a load does not auto-run. */
  const seenFiles = ref<Set<string>>(new Set())

  const queue: Array<{ fileId: string; commentId: string }> = []
  let inFlight = 0

  const comments = computed<TrackedAiComment[]>(() => byFile.value[activeFileId.value] ?? [])
  const pendingCount = computed(
    () => comments.value.filter((c) => c.status === 'pending' || c.status === 'running').length
  )
  const readyCount = computed(() => comments.value.filter((c) => c.status === 'ready').length)

  const patch = (fileId: string, commentId: string, changes: Partial<TrackedAiComment>): void => {
    const list = byFile.value[fileId]
    if (!list) return
    const index = list.findIndex((c) => c.id === commentId)
    if (index === -1) return
    list[index] = { ...list[index], ...changes }
  }

  const find = (fileId: string, commentId: string): TrackedAiComment | undefined =>
    byFile.value[fileId]?.find((c) => c.id === commentId)

  const pump = (): void => {
    while (inFlight < MAX_CONCURRENT && queue.length > 0) {
      const job = queue.shift()
      if (!job) return
      const comment = find(job.fileId, job.commentId)
      // The marker may have been deleted, or its paragraph edited, between
      // being queued and reaching the front.
      if (!comment || comment.status !== 'pending') continue

      inFlight++
      patch(job.fileId, job.commentId, { status: 'running' })
      dispatch(job.fileId, comment)
        .catch((error: unknown) => {
          // `dispatch` resolves rather than throws on provider failures, so a
          // rejection here means the bridge itself broke. Surfacing it beats
          // leaving the card stuck on "Working…" forever.
          patch(job.fileId, job.commentId, {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        })
        .finally(() => {
          inFlight--
          pump()
        })
    }
  }

  const dispatch = async(fileId: string, comment: TrackedAiComment): Promise<void> => {
    const preferences = usePreferencesStore()
    const settings = settingsFromPreferences(preferences)
    const targetAtDispatch = comment.target

    const { result } = runCompletion(settings, comment.instruction, comment.target)
    const outcome = await result

    // The user may have edited the paragraph while this was in flight;
    // reconciliation will have reset the comment to `pending`, and overwriting
    // that with a rewrite of the old words would lose their edit.
    const current = find(fileId, comment.id)
    if (!current || current.target !== targetAtDispatch) return

    if (outcome.ok) {
      patch(fileId, comment.id, { status: 'ready', suggestion: outcome.text, error: undefined })
      return
    }
    patch(fileId, comment.id, {
      status: 'failed',
      error: describeError(outcome.error, settings.provider as AIProviderId),
      suggestion: undefined
    })
  }

  const enqueue = (fileId: string, commentId: string): void => {
    queue.push({ fileId, commentId })
    pump()
  }

  /**
   * Re-scans `markdown` and merges the result into the tracked comments.
   *
   * Markers found the first time a file is scanned are left `pending` rather
   * than dispatched: opening a document that already carries twenty comments
   * should not silently spend twenty requests. Everything written afterwards —
   * the actual fast-iteration path — runs immediately.
   */
  const SYNC = (fileId: string, markdown: string): void => {
    if (!fileId) return
    activeFileId.value = fileId

    const previous = byFile.value[fileId] ?? []
    const { comments: next, added } = reconcileAiComments(
      previous,
      parseAiComments(markdown),
      nextId
    )
    byFile.value[fileId] = next

    const firstScan = !seenFiles.value.has(fileId)
    seenFiles.value.add(fileId)
    if (firstScan) return

    const preferences = usePreferencesStore()
    if (!preferences.aiEnabled) return

    for (const comment of added) {
      // A marker with nothing beneath it has no text to rewrite; it shows in
      // the panel as needing a paragraph rather than burning a request.
      if (hasTarget(comment)) enqueue(fileId, comment.id)
    }
  }

  /** Runs one comment on demand — the retry affordance, and the load-time path. */
  const RUN = (commentId: string): void => {
    const fileId = activeFileId.value
    const comment = find(fileId, commentId)
    if (!comment || !hasTarget(comment)) return
    if (comment.status === 'running') return
    patch(fileId, commentId, { status: 'pending', error: undefined, suggestion: undefined })
    enqueue(fileId, commentId)
  }

  const RUN_ALL = (): void => {
    for (const comment of comments.value) {
      if (comment.status === 'pending' && hasTarget(comment)) {
        enqueue(activeFileId.value, comment.id)
      }
    }
  }

  /** Marks a suggestion declined; the marker stays so it can be re-run. */
  const REJECT = (commentId: string): void => {
    patch(activeFileId.value, commentId, { status: 'rejected' })
  }

  /** Forgets a comment once its marker has left the document. */
  const FORGET = (commentId: string): void => {
    const list = byFile.value[activeFileId.value]
    if (!list) return
    byFile.value[activeFileId.value] = list.filter((c) => c.id !== commentId)
  }

  const CLOSE_FILE = (fileId: string): void => {
    delete byFile.value[fileId]
    seenFiles.value.delete(fileId)
  }

  return {
    comments,
    pendingCount,
    readyCount,
    activeFileId,
    SYNC,
    RUN,
    RUN_ALL,
    REJECT,
    FORGET,
    CLOSE_FILE
  }
})
