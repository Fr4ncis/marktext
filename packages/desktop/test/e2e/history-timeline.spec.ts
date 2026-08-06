import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as os from 'node:os'
import * as path from 'node:path'
import { getMarkdownContent, launchWithMarkdown, waitForEditor } from './helpers'

// Version history end to end: a large edit creates a version, the timeline
// shows it with a diff, and restoring brings the old text back while keeping
// the newer state as its own version.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const ORIGINAL = 'The original opening paragraph of the document.'

let app: ElectronApplication
let page: Page

test.beforeAll(async() => {
  const launched = await launchWithMarkdown(`# Notes\n\n${ORIGINAL}\n`)
  app = launched.app
  page = launched.page
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
  await page.keyboard.type('Completely different opening.')
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
  expect(before).toContain('Completely different opening.')

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
  expect(after).not.toContain('Completely different opening.')

  // Restoring is itself reversible: the pre-restore state became a version.
  const entriesAfter = await page.locator('.side-bar-history .entry').count()
  expect(entriesAfter).toBeGreaterThan(entriesBefore)
  await expect(
    page.locator('.side-bar-history .entry .entry-label', { hasText: 'Before restore' }).first()
  ).toBeVisible()
})
