import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { getMarkdownContent, launchWithMarkdown, waitForEditor } from './helpers'

// Word-style commenting: select an exact span, type an instruction in the
// floating composer, and get a rewrite of just that span — not the paragraph.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const PARAGRAPH = 'Parental leave now covers maternity (12 months) and applies to all staff.'
const SPAN = 'maternity (12 months)'
const REWRITTEN = 'parental leave (12 months)'

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

  const launched = await launchWithMarkdown(`# Policy\n\n${PARAGRAPH}\n`)
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

/** Selects `text` inside the rendered paragraph via a DOM range. */
const selectPhrase = async(phrase: string): Promise<void> => {
  await page.evaluate((needle) => {
    const walker = document.createTreeWalker(
      document.querySelector('.editor-component') as Node,
      NodeFilter.SHOW_TEXT
    )
    let node: Node | null
    while ((node = walker.nextNode())) {
      const index = (node.textContent ?? '').indexOf(needle)
      if (index === -1) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    throw new Error(`phrase not found: ${needle}`)
  }, phrase)
  await page.waitForTimeout(300)
}

test('comments on an exact selection and rewrites only that span', async() => {
  await waitForEditor(page)
  await page.locator('.side-bar .left-column li').nth(3).click()

  await page.click('.editor-component')
  await selectPhrase(SPAN)

  // Same event the context-menu item and the shortcut both send.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mt::ai::compose-comment')
  })

  const composer = page.locator('.ai-comment-composer')
  await expect(composer).toBeVisible({ timeout: 5000 })
  // The card quotes the exact selection it will anchor to.
  await expect(composer.locator('.quoted')).toContainText(SPAN)
  await page.screenshot({ path: path.join(SHOT_DIR, 'span-01-composer.png') })

  await composer.locator('textarea').fill('use inclusive wording')
  await composer.getByRole('button', { name: 'Comment' }).click()

  const card = page.locator('.side-bar-ai-comments .comment').first()
  await expect(card.locator('.suggestion')).toHaveText(REWRITTEN, { timeout: 15000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'span-02-ready.png') })

  // Only the span was sent, not the surrounding sentence.
  const sent = received[0].messages[1].content
  expect(sent).toContain(SPAN)
  expect(sent).toContain('use inclusive wording')
  expect(sent).not.toContain('applies to all staff')

  // The markers wrap the selection in place, mid-paragraph.
  const withMarkers = await getMarkdownContent(page, app)
  expect(withMarkers).toContain(`<!--ai: use inclusive wording-->${SPAN}<!--/ai-->`)

  await card.getByRole('button', { name: 'Accept' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOT_DIR, 'span-03-accepted.png') })

  const after = await getMarkdownContent(page, app)
  // Exactly the span changed; the rest of the sentence is untouched.
  expect(after).toContain(`Parental leave now covers ${REWRITTEN} and applies to all staff.`)
  expect(after).not.toContain('<!--ai:')
  expect(after).not.toContain('<!--/ai-->')
})

test('a note is anchored but never sent to the model', async() => {
  const callsBefore = received.length

  await selectPhrase('all staff')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mt::ai::compose-comment')
  })

  const composer = page.locator('.ai-comment-composer')
  await expect(composer).toBeVisible({ timeout: 5000 })
  // Element Plus hides the real radio behind its label span, which intercepts
  // pointer events — click the label rather than the input.
  await composer.locator('.el-radio-button__inner', { hasText: 'Note' }).click()
  await composer.locator('textarea').fill('confirm with HR')
  await composer.getByRole('button', { name: 'Comment' }).click()

  const note = page.locator('.side-bar-ai-comments .comment.is-note').first()
  await expect(note).toBeVisible({ timeout: 5000 })
  await expect(note.locator('.status')).toHaveText('Note')
  await page.screenshot({ path: path.join(SHOT_DIR, 'span-04-note.png') })

  // A note must not spend a request.
  await page.waitForTimeout(1500)
  expect(received.length).toBe(callsBefore)

  const markdown = await getMarkdownContent(page, app)
  expect(markdown).toContain('<!--note: confirm with HR-->all staff<!--/note-->')
})
