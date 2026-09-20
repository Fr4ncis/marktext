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

// The failure paths of the assistant, driven end to end against a stub
// OpenAI-compatible server. The happy path is covered by
// ai-assistant-drive.spec.ts; what matters here is the opposite guarantee —
// that a failed or truncated completion never reaches the document.
//
// Unit specs already assert the adapter returns the right error object
// (ai-openai-params, ai-errors). They cannot show that the renderer then
// refuses to apply it, which is the property that protects the user's file.
//
// LM Studio is the provider under test because it authenticates with no
// credential, so nothing here needs a key or an OS keychain — the suite stays
// hermetic under CI's xvfb setup.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()
const ORIGINAL = 'hey so i got the thing you sent, thanks'
/** Long enough to be obviously a partial sentence if it were ever applied. */
const TRUNCATED = 'The undersigned hereby acknowledges receipt of the afore'

/** What the stub should do with the next request. */
type Mode = 'truncated' | 'empty' | 'unauthorized' | 'server-error' | 'malformed'
let mode: Mode = 'truncated'

let server: http.Server
let app: ElectronApplication
let page: Page

const respond = (res: http.ServerResponse): void => {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  switch (mode) {
    case 'truncated':
      // Text present *and* cut off by the token limit — the case that would
      // splice half a sentence into the document if treated as success.
      return json(200, {
        model: 'stub-model',
        choices: [{ message: { role: 'assistant', content: TRUNCATED }, finish_reason: 'length' }]
      })
    case 'empty':
      return json(200, {
        model: 'stub-model',
        choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }]
      })
    case 'unauthorized':
      return json(401, { error: { message: 'Invalid API key provided.' } })
    case 'server-error':
      return json(503, { error: { message: 'The engine is overloaded.' } })
    case 'malformed':
      // A base URL pointing at something that is not an API at all — the
      // common misconfiguration when the port belongs to another service.
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body>not an API</body></html>')
  }
}

/** Runs a prompt and returns the dialog, leaving it open for assertions. */
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
    req.on('end', () => respond(res))
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
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('a completion cut off by the token limit is refused, not applied', async() => {
  mode = 'truncated'
  const dialog = await runPrompt()

  const error = dialog.locator('.ai-error')
  await expect(error).toBeVisible({ timeout: 15000 })
  await expect(error).toContainText('token limit', { timeout: 5000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-fail-01-truncated.png') })

  // The guarantee that matters: the partial rewrite is nowhere in the document,
  // and the original text is untouched.
  const markdown = await getMarkdownContent(page, app)
  expect(markdown).toContain(ORIGINAL)
  expect(markdown).not.toContain(TRUNCATED)

  // There is nothing to apply, so the affordance that would apply it is gone.
  await expect(dialog.getByRole('button', { name: 'Replace selection' })).toBeHidden()

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('an empty completion reports the token-limit hint rather than blanking the selection', async() => {
  mode = 'empty'
  const dialog = await runPrompt()

  await expect(dialog.locator('.ai-error')).toBeVisible({ timeout: 15000 })
  // Replacing a selection with '' would silently delete the user's text.
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('a rejected key surfaces as an authentication error', async() => {
  mode = 'unauthorized'
  const dialog = await runPrompt()

  const error = dialog.locator('.ai-error')
  await expect(error).toBeVisible({ timeout: 15000 })
  await expect(error).toContainText(/key|authenticat/i, { timeout: 5000 })
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('a provider-side failure leaves the document alone', async() => {
  mode = 'server-error'
  const dialog = await runPrompt()

  await expect(dialog.locator('.ai-error')).toBeVisible({ timeout: 15000 })
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('a base URL that is not an API is reported rather than crashing the dialog', async() => {
  mode = 'malformed'
  const dialog = await runPrompt()

  // The dialog must stay usable: an unparseable body is a misconfiguration the
  // user can fix, not a reason to leave the UI wedged in loading.
  await expect(dialog.locator('.ai-error')).toBeVisible({ timeout: 15000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-fail-02-malformed.png') })
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('the document is still editable after a run of failures', async() => {
  // A failed request must not leave the editor read-only or the selection in a
  // half-applied state — five failures in a row above, so this is the check
  // that the app is no worse for them.
  await waitForEditor(page)
  await page.keyboard.press('End')
  await page.keyboard.type(' still typing')
  await page.waitForTimeout(400)
  expect(await getMarkdownContent(page, app)).toContain('still typing')
})
