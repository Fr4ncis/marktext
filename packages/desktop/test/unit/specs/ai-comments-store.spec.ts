import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The pure marker layer (parse / reconcile / apply) is exercised in full by
// ai-comments.spec.ts. This file covers the *store* on top of it — the queue,
// the first-scan guard, the stale-target drop, and the retry affordance — the
// runtime path that turns a written marker into a dispatched request. The two
// boundaries the store reaches across are mocked: the completion service (so a
// request can be held in flight and resolved on demand) and the preferences
// store (so `aiEnabled` and the persona are controllable). Everything under
// @shared/types/aiComments stays real, so the store is driven the way the
// editor drives it: by handing it document markdown.

/**
 * One controllable completion. `runCompletion` hands back `result` immediately
 * and the test resolves it later, which is exactly the in-flight window the
 * stale-target drop guards.
 */
interface Deferred {
  resolve: (value: unknown) => void
  promise: Promise<unknown>
}

const deferreds: Deferred[] = []
const runCompletion = vi.fn(() => {
  let capturedResolve!: (value: unknown) => void
  const promise = new Promise<unknown>((resolve) => {
    capturedResolve = resolve
  })
  deferreds.push({ resolve: capturedResolve, promise })
  return { result: promise, cancel: vi.fn() }
})

vi.mock('@/services/aiAssistant', () => ({
  runCompletion,
  // Copied verbatim into a failed comment; asserted below.
  describeError: (error: { message: string }) => error.message,
  resolvePersonaPath: () => undefined,
  settingsFromPreferences: () => ({
    provider: 'openai',
    model: 'test-model',
    baseUrl: '',
    maxTokens: 1000,
    timeoutMs: 5000
  })
}))

let aiEnabled = true
vi.mock('@/store/preferences', () => ({
  usePreferencesStore: () => ({ aiEnabled })
}))

// Imported after the mocks are declared so the store picks up the stubs.
const { useAiCommentsStore } = await import('@/store/aiComments')

/** Resolves a held completion successfully, then lets the store's `.then` run. */
const settleOk = async(index: number, text: string): Promise<void> => {
  deferreds[index].resolve({ ok: true, text })
  await deferreds[index].promise
  await Promise.resolve()
  await Promise.resolve()
}

const settleFail = async(index: number, message: string): Promise<void> => {
  deferreds[index].resolve({ ok: false, error: { message } })
  await deferreds[index].promise
  await Promise.resolve()
  await Promise.resolve()
}

const doc = (instruction: string, paragraph: string): string =>
  `<!--ai: ${instruction}-->\n${paragraph}\n`

describe('useAiCommentsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    deferreds.length = 0
    runCompletion.mockClear()
    aiEnabled = true
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not dispatch on the first scan of a document', () => {
    // Opening a file that already carries comments must not silently spend a
    // request per marker.
    const store = useAiCommentsStore()
    store.SYNC('file-1', doc('tighten this', 'The paragraph to tighten.'))

    expect(runCompletion).not.toHaveBeenCalled()
    expect(store.comments).toHaveLength(1)
    expect(store.comments[0].status).toBe('pending')
  })

  it('dispatches a comment written after the first scan and marks it ready', async() => {
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Just prose, no markers yet.\n')
    expect(runCompletion).not.toHaveBeenCalled()

    // The fast-iteration path: a marker typed into an already-open document.
    store.SYNC('file-1', doc('tighten this', 'The paragraph to tighten.'))
    expect(runCompletion).toHaveBeenCalledTimes(1)
    expect(store.comments[0].status).toBe('running')

    await settleOk(0, 'Tightened.')
    expect(store.comments[0].status).toBe('ready')
    expect(store.comments[0].suggestion).toBe('Tightened.')
  })

  it('drops a completion whose paragraph was edited while it was in flight', async() => {
    // The user kept typing; reconciliation reset the comment to pending against
    // the new text. Applying the rewrite of the *old* words would clobber that
    // edit, so the outcome must be discarded.
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Prose.\n')
    store.SYNC('file-1', doc('rewrite this', 'Original paragraph.'))
    expect(store.comments[0].status).toBe('running')

    // Edit the target while the request is in flight.
    store.SYNC('file-1', doc('rewrite this', 'Edited paragraph, different now.'))

    await settleOk(0, 'A rewrite of the ORIGINAL words.')

    // The stale outcome was not applied: no suggestion, not marked ready.
    expect(store.comments[0].suggestion).toBeUndefined()
    expect(store.comments[0].status).not.toBe('ready')
  })

  it('marks a comment failed and copies the described error', async() => {
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Prose.\n')
    store.SYNC('file-1', doc('rewrite this', 'A paragraph.'))

    await settleFail(0, 'rate limited')
    expect(store.comments[0].status).toBe('failed')
    expect(store.comments[0].error).toBe('rate limited')
  })

  it('re-dispatches a failed comment on RUN and clears its prior error', async() => {
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Prose.\n')
    store.SYNC('file-1', doc('rewrite this', 'A paragraph.'))
    await settleFail(0, 'transient failure')
    expect(store.comments[0].status).toBe('failed')

    store.RUN(store.comments[0].id)
    expect(runCompletion).toHaveBeenCalledTimes(2)
    expect(store.comments[0].error).toBeUndefined()

    await settleOk(1, 'Second time lucky.')
    expect(store.comments[0].status).toBe('ready')
    expect(store.comments[0].suggestion).toBe('Second time lucky.')
  })

  it('ignores RUN for a comment already running', () => {
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Prose.\n')
    store.SYNC('file-1', doc('rewrite this', 'A paragraph.'))
    expect(store.comments[0].status).toBe('running')

    // A second click while the first request is still in flight must not
    // enqueue a duplicate.
    store.RUN(store.comments[0].id)
    expect(runCompletion).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch when AI is disabled in preferences', () => {
    aiEnabled = false
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Prose.\n')
    store.SYNC('file-1', doc('rewrite this', 'A paragraph.'))

    expect(runCompletion).not.toHaveBeenCalled()
  })

  it('caps concurrent requests at three and drains the queue as they settle', async() => {
    // Four markers written into an already-open document must not all fire at
    // once: the queue keeps at most MAX_CONCURRENT (3) in flight, then dispatches
    // the fourth once a slot frees. A regression that dropped the cap would flood
    // the provider; one that dropped the finally-block re-drain would strand the
    // fourth comment forever.
    const store = useAiCommentsStore()
    store.SYNC('file-1', 'Prose only.\n')

    const fourMarkers = [
      doc('rewrite one', 'Paragraph one.'),
      doc('rewrite two', 'Paragraph two.'),
      doc('rewrite three', 'Paragraph three.'),
      doc('rewrite four', 'Paragraph four.')
    ].join('\n')
    store.SYNC('file-1', fourMarkers)

    // Only three of the four are dispatched; the fourth waits behind the cap.
    expect(runCompletion).toHaveBeenCalledTimes(3)
    const running = store.comments.filter((c) => c.status === 'running')
    const pending = store.comments.filter((c) => c.status === 'pending')
    expect(running).toHaveLength(3)
    expect(pending).toHaveLength(1)

    // Settle one in-flight request; the freed slot pulls the fourth off the queue.
    await settleOk(0, 'First done.')
    expect(runCompletion).toHaveBeenCalledTimes(4)
    expect(store.comments.filter((c) => c.status === 'running')).toHaveLength(3)
    expect(store.comments.filter((c) => c.status === 'pending')).toHaveLength(0)
  })

  it('RUN_ALL dispatches every pending comment and leaves others alone', async() => {
    // A document opened with existing markers is all pending after the first
    // scan (no auto-dispatch). RUN_ALL is the "run them now" affordance: it must
    // enqueue every dispatchable pending comment, and must not re-touch one that
    // is already ready or one with no target under it.
    const store = useAiCommentsStore()
    const opened = [
      doc('rewrite one', 'Paragraph one.'),
      doc('rewrite two', 'Paragraph two.')
    ].join('\n')
    // First scan: both markers land pending, nothing dispatched.
    store.SYNC('file-1', opened)
    expect(runCompletion).not.toHaveBeenCalled()
    expect(store.comments.filter((c) => c.status === 'pending')).toHaveLength(2)

    store.RUN_ALL()
    expect(runCompletion).toHaveBeenCalledTimes(2)

    // Settle both, then a second RUN_ALL must be a no-op: nothing is pending.
    await settleOk(0, 'One done.')
    await settleOk(1, 'Two done.')
    expect(store.comments.every((c) => c.status === 'ready')).toBe(true)

    store.RUN_ALL()
    expect(runCompletion).toHaveBeenCalledTimes(2)
  })
})
