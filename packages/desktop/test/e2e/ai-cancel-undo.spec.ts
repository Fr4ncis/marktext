import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getMarkdownContent,
  launchWithMarkdown,
  sendIpcToRenderer,
  waitForEditor
} from './helpers'

// The two ways out of a rewrite that are not "accept it": cancelling while the
// request is in flight, and undoing it after it has landed.
//
// Both are properties of the document rather than of the adapter, so neither is
// reachable from a unit test. Undo in particular is load-bearing: the apply path
// goes through `replaceContent`/`replaceRange` specifically so that a
// whole-document write stays one undoable step (see util/editingSurface.ts) —
// nothing asserted that in the WYSIWYG editor until now.
//
// LM Studio is the provider under test so no key or keychain is involved.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const ORIGINAL = 'hey so i got the thing you sent, thanks'
const REWRITTEN = 'The undersigned hereby acknowledges receipt of the aforementioned document.'

/** `hold` never answers, so the request stays in flight until the test cancels it. */
type Mode = 'fast' | 'hold'
let mode: Mode = 'fast'

let server: http.Server
let app: ElectronApplication
let page: Page
/** Responses parked by `hold`, released in afterAll so `server.close` can finish. */
const parked: http.ServerResponse[] = []

/** Text of the rendered document, read without toggling source mode. */
const editorText = (): Promise<string> =>
  page.evaluate(() => document.querySelector('.editor-component')?.textContent ?? '')

const runPrompt = async(): Promise<ReturnType<Page['locator']>> => {
  await waitForEditor(page)
  await sendIpcToRenderer(app, 'mt::editor-edit-action', 'selectAll')
  await page.waitForTimeout(400)
  await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')
  return page.locator('.el-dialog:has-text("AI ·")')
}

test.beforeAll(async() => {
  server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      if (mode === 'hold') {
        parked.push(res)
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'stub-model',
          choices: [{ message: { role: 'assistant', content: REWRITTEN }, finish_reason: 'stop' }]
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const launched = await launchWithMarkdown(ORIGINAL)
  app = launched.app
  page = launched.page

  await page.evaluate((baseUrl) => {
    window.electron.ipcRenderer.send('mt::set-user-preference', {
      aiEnabled: true,
      aiProvider: 'lmstudio',
      aiModel: 'stub-model',
      aiBaseUrl: baseUrl
    })
  }, `http://127.0.0.1:${port}/v1`)
  await page.waitForTimeout(800)
})

test.afterAll(async() => {
  await app?.close()
  for (const res of parked) res.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('an applied rewrite is undone in a single step', async() => {
  mode = 'fast'
  const dialog = await runPrompt()
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
  await dialog.getByRole('button', { name: 'Replace selection' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(600)
  expect(await editorText()).toContain(REWRITTEN)

  // Same channel Edit › Undo uses. One undo, not several: the apply is a
  // whole-document write, and if it were recorded as one history entry per
  // changed block the user would have to press undo an unpredictable number of
  // times to get their paragraph back.
  await sendIpcToRenderer(app, 'mt::editor-edit-action', 'undo')
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-undo-01-after-undo.png') })

  const restored = await editorText()
  expect(restored).toContain(ORIGINAL)
  expect(restored).not.toContain(REWRITTEN)

  // And the markdown really is the original, not just the rendered text.
  const markdown = await getMarkdownContent(page, app)
  expect(markdown).toContain(ORIGINAL)
  expect(markdown).not.toContain(REWRITTEN)
})

test('cancelling an in-flight request leaves the document untouched', async() => {
  mode = 'hold'
  const before = await editorText()

  const dialog = await runPrompt()
  // Cancel only exists while the request is in flight — its presence is the
  // proof the request is genuinely outstanding rather than already failed.
  const cancelButton = dialog.getByRole('button', { name: 'Cancel' })
  await expect(cancelButton).toBeVisible({ timeout: 10000 })
  expect(parked.length).toBeGreaterThan(0)
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-cancel-01-in-flight.png') })

  await cancelButton.click()

  // A cancel is reported as a cancel, not as a provider failure the user is
  // expected to act on, and it leaves nothing to apply.
  const error = dialog.locator('.ai-error')
  await expect(error).toBeVisible({ timeout: 10000 })
  await expect(error).toContainText(/cancel/i)
  await expect(dialog.getByRole('button', { name: 'Replace selection' })).toBeHidden()
  await expect(cancelButton).toBeHidden()
  expect(await editorText()).toBe(before)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('a rewrite still works after a cancelled one', async() => {
  // A cancel must not leave the in-flight registry or the dialog in a state
  // that poisons the next request.
  mode = 'fast'
  const dialog = await runPrompt()
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })

  // And the editor still accepts input.
  await waitForEditor(page)
  await page.keyboard.press('End')
  await page.keyboard.type(' still typing')
  await page.waitForTimeout(400)
  expect(await editorText()).toContain('still typing')
})
