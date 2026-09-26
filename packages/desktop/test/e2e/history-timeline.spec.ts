import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getMarkdownContent,
  launchWithMarkdown,
  reportExternalFileChange,
  sendIpcToRenderer,
  waitForEditor
} from './helpers'

// Version history end to end: a large edit creates a version, the timeline
// shows it with a diff, and restoring brings the old text back while keeping
// the newer state as its own version.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const ORIGINAL = 'The original opening paragraph of the document.'
const REPLACEMENT = 'Completely different opening.'
/** Stands in for another program — a git checkout, a sync client — rewriting the file. */
const EXTERNAL = 'Rewritten on disk by another program.'

let app: ElectronApplication
let page: Page
let filePath: string

const entries = (): ReturnType<Page['locator']> => page.locator('.side-bar-history .entry')

test.beforeAll(async() => {
  const launched = await launchWithMarkdown(`# Notes\n\n${ORIGINAL}\n`)
  app = launched.app
  page = launched.page
  filePath = launched.filePath
  await waitForEditor(page)
  // Fourth icon is AI comments, fifth is History.
  await page.locator('.side-bar .left-column li').nth(4).click()
  await expect(page.locator('.side-bar-history')).toBeVisible()
})

test.afterAll(async() => {
  await app?.close()
})

test('an empty timeline explains itself', async() => {
  await expect(page.locator('.side-bar-history .empty')).toContainText('No versions yet')
  await page.screenshot({ path: path.join(SHOT_DIR, 'hist-01-empty.png') })
})

test('a manual checkpoint appears in the timeline', async() => {
  await page.getByRole('button', { name: 'Save a checkpoint now' }).click()

  const dialog = page.locator('.el-message-box')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await dialog.locator('input').fill('original wording')
  await dialog.getByRole('button', { name: 'Save' }).click()

  const entry = page.locator('.side-bar-history .entry').first()
  await expect(entry).toBeVisible({ timeout: 5000 })
  // A named checkpoint shows its label rather than its trigger.
  await expect(entry.locator('.entry-label')).toHaveText('original wording')
  await page.screenshot({ path: path.join(SHOT_DIR, 'hist-02-checkpoint.png') })
})

test('selecting a version shows a diff against the document now', async() => {
  // Replace the body with a large block — a change big enough to matter.
  await page.getByText(ORIGINAL).click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(REPLACEMENT)
  await page.waitForTimeout(1200)

  await page.locator('.side-bar-history .entry').last().click()

  const preview = page.locator('.side-bar-history .preview')
  await expect(preview).toBeVisible({ timeout: 5000 })
  await expect(preview.locator('.diff-line.op-delete').first()).toBeVisible({ timeout: 5000 })
  await expect(preview.locator('.diff-line.op-insert').first()).toBeVisible()
  await page.screenshot({ path: path.join(SHOT_DIR, 'hist-03-diff.png') })
})

test('restoring brings the old text back and keeps the newer state', async() => {
  const before = await getMarkdownContent(page, app)
  expect(before).toContain(REPLACEMENT)

  const entriesBefore = await page.locator('.side-bar-history .entry').count()

  // Clicking an already-open entry collapses it, so only select if the preview
  // is not already showing the version left selected by the previous test.
  const preview = page.locator('.side-bar-history .preview')
  if (!(await preview.isVisible())) {
    await page.locator('.side-bar-history .entry').last().click()
    await expect(preview).toBeVisible({ timeout: 5000 })
  }

  await page.getByRole('button', { name: 'Restore this version' }).click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(SHOT_DIR, 'hist-04-restored.png') })

  const after = await getMarkdownContent(page, app)
  expect(after).toContain(ORIGINAL)
  expect(after).not.toContain(REPLACEMENT)

  // Restoring is itself reversible: the pre-restore state became a version.
  const entriesAfter = await page.locator('.side-bar-history .entry').count()
  expect(entriesAfter).toBeGreaterThan(entriesBefore)
  await expect(
    page.locator('.side-bar-history .entry .entry-label', { hasText: 'Before restore' }).first()
  ).toBeVisible()
})

test('a restore is undoable in one step', async() => {
  // The timeline keeps the pre-restore text as a version, but the fast way back
  // from a misclick is Ctrl+Z — and that only works because a restore writes
  // through `replaceAll` rather than reloading the document. One step, not one
  // per changed block.
  const countBefore = await entries().count()

  await sendIpcToRenderer(app, 'mt::editor-edit-action', 'undo')
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOT_DIR, 'hist-05-undone.png') })

  const after = await getMarkdownContent(page, app)
  expect(after).toContain(REPLACEMENT)
  expect(after).not.toContain(ORIGINAL)

  // Undoing cannot cost a version. It may add one — swapping the whole body
  // back is a large change like any other, and the store snapshots those
  // whatever caused them — but the pre-restore checkpoint must still be there,
  // because that is what the timeline is for.
  expect(await entries().count()).toBeGreaterThanOrEqual(countBefore)
  await expect(
    page.locator('.side-bar-history .entry .entry-label', { hasText: 'Before restore' }).first()
  ).toBeVisible()
})

test('an external change while the timeline is open loses no versions', async() => {
  // A clean tab plus autoSave is what lets the watcher's report apply without
  // asking the user, which is the case worth covering: the document changes
  // under the open timeline with no interaction at all.
  await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
  await expect(page.locator('.editor-tabs li.unsaved')).toHaveCount(0, { timeout: 10000 })
  await sendIpcToRenderer(app, 'mt::user-preference', { autoSave: true })
  await page.waitForTimeout(200)

  const labelsBefore = await entries().allInnerTexts()
  expect(labelsBefore.length).toBeGreaterThan(0)

  await reportExternalFileChange(app, filePath, `# Notes\n\n${EXTERNAL}\n`)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: path.join(SHOT_DIR, 'hist-06-external.png') })

  expect(await getMarkdownContent(page, app)).toContain(EXTERNAL)

  // Versions are keyed by file path, so a reload of that same path must leave
  // every one of them in place — after an external write the timeline is the
  // only route back to the text that was overwritten.
  const labelsAfter = await entries().allInnerTexts()
  for (const label of labelsBefore) expect(labelsAfter).toContain(label)

  // The timeline is still live, too: selecting a version diffs it against the
  // externally-changed document rather than the text the tab was opened with.
  await entries().filter({ hasText: 'original wording' }).first().click()
  const preview = page.locator('.side-bar-history .preview')
  await expect(preview).toBeVisible({ timeout: 5000 })
  await expect(preview).toContainText(EXTERNAL)

  // And restoring over an external change is not a one-way door: the text that
  // arrived from disk is still in the timeline afterwards. It is the autosaved
  // version rather than a second "Before restore" one — an identical snapshot
  // is not recorded twice — so look for the content, not for a label.
  await page.getByRole('button', { name: 'Restore this version' }).click()
  await page.waitForTimeout(1500)
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)
  expect(await entries().count()).toBeGreaterThanOrEqual(labelsAfter.length)

  const someVersionHoldsExternal = await page.evaluate(async(args) => {
    const snapshots = await window.fileHistory.list(args.filePath)
    for (const snapshot of snapshots) {
      const text = await window.fileHistory.read(args.filePath, snapshot.seq)
      if (text?.includes(args.needle)) return true
    }
    return false
  }, { filePath, needle: EXTERNAL })
  expect(someVersionHoldsExternal).toBe(true)
})
