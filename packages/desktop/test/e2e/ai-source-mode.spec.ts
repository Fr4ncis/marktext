import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { enterSourceMode, launchWithMarkdown, sendIpcToRenderer, waitForEditor } from './helpers'

// Source-code mode overlays the WYSIWYG component rather than replacing it, so
// the AI handlers keep running in the still-mounted `editor.vue` while
// CodeMirror owns the live text. That is the whole risk of this feature: a
// rewrite that reads or writes the wrong editor would either send stale text to
// the model or silently discard what the user typed in source mode. These
// specs drive the real app against a stub provider to prove neither happens.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const REWRITTEN = 'The undersigned hereby acknowledges receipt of the document.'
const ORIGINAL = '# Notes\n\nhey so i got the thing you sent, thanks\n\nsecond paragraph stays put\n'

let server: http.Server
let app: ElectronApplication
let page: Page
const received: Array<{ messages: Array<{ role: string; content: string }> }> = []

/** Reads CodeMirror's live buffer — the source of truth while in source mode. */
const sourceValue = (target: Page): Promise<string> =>
  target.evaluate(() => {
    const cm = document.querySelector('.source-code .CodeMirror') as
      | (Element & { CodeMirror?: { getValue(): string } })
      | null
    return cm?.CodeMirror ? cm.CodeMirror.getValue() : ''
  })

/** Selects `text` inside CodeMirror by locating it in the buffer. */
const selectInSource = async(target: Page, text: string): Promise<void> => {
  await target.evaluate((needle) => {
    const cm = (
      document.querySelector('.source-code .CodeMirror') as Element & {
        CodeMirror?: {
          focus(): void
          getValue(): string
          posFromIndex(i: number): unknown
          setSelection(a: unknown, b: unknown): void
        }
      }
    ).CodeMirror!
    cm.focus()
    const start = cm.getValue().indexOf(needle)
    if (start < 0) throw new Error(`not found in source buffer: ${needle}`)
    cm.setSelection(cm.posFromIndex(start), cm.posFromIndex(start + needle.length))
  }, text)
  await target.waitForTimeout(250)
}

test.beforeAll(async() => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'))
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

  await waitForEditor(page)
  await enterSourceMode(page, app)
})

test.afterAll(async() => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('rewrites a source-mode selection and writes it back to CodeMirror', async() => {
  const target = 'hey so i got the thing you sent, thanks'
  await selectInSource(page, target)

  const callsBefore = received.length
  await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')

  const dialog = page.locator('.el-dialog:has-text("AI ·")')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 10000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'src-01-preview.png') })

  // The model must have been sent what CodeMirror holds, not Muya's copy.
  expect(received.length).toBeGreaterThan(callsBefore)
  expect(received[received.length - 1].messages[1].content).toContain(target)

  // Preview does not auto-apply.
  expect(await sourceValue(page)).toContain(target)

  await dialog.getByRole('button', { name: 'Replace selection' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SHOT_DIR, 'src-02-applied.png') })

  const after = await sourceValue(page)
  expect(after).toContain(REWRITTEN)
  expect(after).not.toContain(target)
  // Only the selected span changed.
  expect(after).toContain('second paragraph stays put')
  expect(after).toContain('# Notes')
})

test('the applied rewrite is undoable, so CodeMirror history survived the write', async() => {
  // A whole-document `setValue` would have cleared CodeMirror's undo stack and
  // made the AI edit permanent — the reason the surface splices instead.
  await page.evaluate(() => {
    const cm = (
      document.querySelector('.source-code .CodeMirror') as Element & {
        CodeMirror?: { focus(): void; execCommand(c: string): void }
      }
    ).CodeMirror!
    cm.focus()
    cm.execCommand('undo')
  })
  await page.waitForTimeout(400)

  const afterUndo = await sourceValue(page)
  expect(afterUndo).toContain('hey so i got the thing you sent, thanks')
  expect(afterUndo).not.toContain(REWRITTEN)
})

test('anchors a comment around an exact source-mode selection', async() => {
  await selectInSource(page, 'second paragraph stays put')
  await sendIpcToRenderer(app, 'mt::ai::compose-comment')

  const composer = page.locator('.ai-comment-composer')
  await expect(composer).toBeVisible({ timeout: 5000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'src-03-composer.png') })

  await composer.locator('textarea').fill('tighten this')
  await composer.getByRole('button', { name: 'Comment' }).click()
  await page.waitForTimeout(700)

  const withMarker = await sourceValue(page)
  // The markers wrap exactly the selected span, in the document itself.
  expect(withMarker).toContain('<!--ai: tighten this-->second paragraph stays put<!--/ai-->')
  // And nothing else moved.
  expect(withMarker).toContain('# Notes')
  await page.screenshot({ path: path.join(SHOT_DIR, 'src-04-commented.png') })
})

test('a comment typed by hand in source mode reaches the review panel', async() => {
  // In source mode Muya's `json-change` never fires, so the panel is fed from
  // the editor store instead. Without that wiring this marker would be
  // invisible until the user switched back to WYSIWYG.
  await page.evaluate(() => {
    const cm = (
      document.querySelector('.source-code .CodeMirror') as Element & {
        CodeMirror?: {
          focus(): void
          getValue(): string
          setValue(v: string): void
        }
      }
    ).CodeMirror!
    cm.focus()
    cm.setValue(`${cm.getValue()}\n\n<!--ai/: check the tone throughout-->\n`)
  })

  // The panel is the fourth left-rail icon, after Files / Search / TOC.
  await page.locator('.side-bar .left-column li').nth(3).click()
  const panel = page.locator('.side-bar-ai-comments')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('check the tone throughout')).toBeVisible({ timeout: 8000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'src-05-panel.png') })
})
