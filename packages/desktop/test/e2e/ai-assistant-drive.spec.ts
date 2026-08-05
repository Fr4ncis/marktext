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

// Drives the AI assistant end to end against a stub OpenAI-compatible server,
// so the real IPC -> provider adapter -> preview -> apply path runs without
// needing a live provider or an API key. LM Studio is the provider under test
// because it is the one that authenticates with no credential.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

/** What the stub returns; distinctive enough to assert on. */
const REWRITTEN = 'The undersigned hereby acknowledges receipt of the aforementioned document.'
const ORIGINAL = 'hey so i got the thing you sent, thanks'

let server: http.Server
let app: ElectronApplication
let page: Page
/** Request bodies the app actually sent, so we can assert on the wire format. */
const received: Array<Record<string, unknown>> = []

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

  // The editor component only mounts once a document is open, so launch with a
  // file rather than into the empty start state.
  const launched = await launchWithMarkdown(ORIGINAL)
  app = launched.app
  page = launched.page

  // Configure through the same channel the settings pane writes on.
  await page.evaluate((baseUrl) => {
    window.electron.ipcRenderer.send('mt::set-user-preference', {
      aiEnabled: true,
      aiProvider: 'lmstudio',
      aiModel: 'stub-model',
      aiBaseUrl: baseUrl
    })
  }, `http://127.0.0.1:${port}/v1`)
  // The write round-trips through main and comes back on `mt::user-preference`;
  // wait for the store to actually carry the new provider before driving.
  await page.waitForTimeout(800)
})

test.afterAll(async() => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('rewrites the selection through the preview dialog', async() => {
  await waitForEditor(page)
  await sendIpcToRenderer(app, 'mt::editor-edit-action', 'selectAll')
  await page.waitForTimeout(400)

  // Same event the editor context menu emits; the native menu itself is not
  // reachable from Playwright, but everything downstream of it is.
  await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')

  const dialog = page.locator('.el-dialog:has-text("AI ·")')
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 10000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-01-preview.png') })

  // The original must still be in the document — preview does not auto-apply.
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)

  await dialog.getByRole('button', { name: 'Replace selection' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-02-applied.png') })

  const after = await getMarkdownContent(page, app)
  expect(after).toContain(REWRITTEN)
  expect(after).not.toContain(ORIGINAL)

  // The prompt reached the provider as a system + user pair, with the
  // instruction and the selection both present in the user turn.
  const sent = received[0] as { model: string; messages: Array<{ role: string; content: string }> }
  expect(sent.model).toBe('stub-model')
  expect(sent.messages[0].role).toBe('system')
  expect(sent.messages[1].content).toContain('formal')
  expect(sent.messages[1].content).toContain(ORIGINAL)
})
