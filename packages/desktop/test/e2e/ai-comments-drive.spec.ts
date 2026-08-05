import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { getMarkdownContent, launchWithMarkdown, waitForEditor } from './helpers'

// Drives the AI review-comment loop end to end against a stub provider: write a
// marker, let it resolve in the background while the document stays editable,
// then accept it from the sidebar panel.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const ORIGINAL = 'The configuration is loaded by the server at startup.'
const REWRITTEN = 'The server loads the configuration at startup.'

let server: http.Server
let app: ElectronApplication
let page: Page
const received: Array<{ messages: Array<{ role: string; content: string }> }> = []

test.beforeAll(async() => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'stub-model',
          choices: [{ message: { content: REWRITTEN }, finish_reason: 'stop' }]
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const launched = await launchWithMarkdown(`# Deployment\n\n${ORIGINAL}\n`)
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

/** Opens the AI comments sidebar tab. */
const openPanel = async(): Promise<void> => {
  await page.evaluate(() => {
    window.electron.ipcRenderer.send('mt::view-layout-changed', 0, {})
  })
  // The panel is the fourth left-rail icon, after Files / Search / TOC.
  await page.locator('.side-bar .left-column li').nth(3).click()
  await expect(page.locator('.side-bar-ai-comments')).toBeVisible()
}

test('a comment resolves in the background and can be accepted', async() => {
  await waitForEditor(page)
  await openPanel()
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-01-empty.png') })

  // Type the marker above the paragraph, exactly as a user would: put the
  // caret at the start of the paragraph, type the comment, split the block.
  // Muya then separates them with a blank line, which target resolution skips.
  await page.getByText(ORIGINAL).click()
  await page.keyboard.press('Home')
  await page.keyboard.type('<!--ai: use the active voice-->')
  await page.keyboard.press('Enter')

  // The scan is debounced; the request then runs in the background.
  const card = page.locator('.side-bar-ai-comments .comment').first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await expect(card.locator('.suggestion')).toHaveText(REWRITTEN, { timeout: 15000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-02-ready.png') })

  // Nothing has touched the document yet — the whole point is review-later.
  expect(await getMarkdownContent(page, app)).toContain(ORIGINAL)

  // The marker, not just the paragraph, reached the model as the instruction.
  expect(received[0].messages[1].content).toContain('use the active voice')
  expect(received[0].messages[1].content).toContain(ORIGINAL)

  await card.getByRole('button', { name: 'Accept' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-03-accepted.png') })

  const after = await getMarkdownContent(page, app)
  expect(after).toContain(REWRITTEN)
  expect(after).not.toContain(ORIGINAL)
  // Accepting resolves the comment: the marker is gone from the document.
  expect(after).not.toContain('<!--ai:')
  expect(after).toContain('# Deployment')
})
