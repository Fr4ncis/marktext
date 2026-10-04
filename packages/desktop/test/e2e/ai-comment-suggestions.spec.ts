import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { getMarkdownContent, launchWithMarkdown, waitForEditor } from './helpers'

// Quick suggestions in the comment composer: select a span, type an
// instruction, ask for three rewrites, and pick one — the selection is replaced
// in place, with no marker and no sidebar round-trip.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const PARAGRAPH = 'Parental leave now covers maternity (12 months) and applies to all staff.'
const SPAN = 'maternity (12 months)'

/** One reply per style, keyed on the hint each request carries. */
const REPLIES: Array<[string, string]> = [
  ['smallest change', 'parental (12 months)'],
  ['natural, balanced', 'parental leave (12 months)'],
  ['boldly', 'a full year of paid leave for every new parent']
]

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
      const parsed = JSON.parse(body || '{}')
      received.push(parsed)
      const prompt: string = parsed.messages?.[1]?.content ?? ''
      const round = received.length > 3 ? ' (again)' : ''
      const reply = REPLIES.find(([hint]) => prompt.includes(hint))?.[1] ?? prompt
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'stub-model',
          choices: [{ message: { content: `${reply}${round}` }, finish_reason: 'stop' }]
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

test('suggests three rewrites of a selection and applies the one picked', async() => {
  await waitForEditor(page)
  await page.click('.editor-component')
  await selectPhrase(SPAN)

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mt::ai::compose-comment')
  })
  const composer = page.locator('.ai-comment-composer')
  await expect(composer).toBeVisible({ timeout: 5000 })
  await composer.locator('textarea').fill('use inclusive wording')
  await composer.getByRole('button', { name: 'Suggest' }).click()

  const options = composer.locator('.suggestion-option.is-ready')
  await expect(options).toHaveCount(3, { timeout: 15000 })
  await expect(options.nth(0)).toContainText(REPLIES[0][1])
  await expect(options.nth(2)).toContainText(REPLIES[2][1])
  await page.screenshot({ path: path.join(SHOT_DIR, 'suggest-01-options.png') })

  // Each request carried the instruction and only the selected span.
  expect(received).toHaveLength(3)
  for (const request of received) {
    expect(request.messages[1].content).toContain('use inclusive wording')
    expect(request.messages[1].content).toContain(SPAN)
    expect(request.messages[1].content).not.toContain('applies to all staff')
  }

  // Try again replaces the options with a fresh set.
  await composer.getByRole('button', { name: 'Try again' }).click()
  await expect(options.nth(1)).toContainText('(again)', { timeout: 15000 })
  expect(received).toHaveLength(6)

  // Nothing has touched the document yet.
  expect(await getMarkdownContent(page, app)).toContain(PARAGRAPH)

  await options.nth(1).click()
  await expect(composer).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SHOT_DIR, 'suggest-02-applied.png') })

  const after = await getMarkdownContent(page, app)
  expect(after).toContain('Parental leave now covers parental leave (12 months) (again) and applies to all staff.')
  // A suggestion is an edit, not a comment: no markers are left behind.
  expect(after).not.toContain('<!--ai:')
  expect(after).not.toContain('<!--/ai-->')
})

test('a note offers no suggestions', async() => {
  await selectPhrase('all staff')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mt::ai::compose-comment')
  })
  const composer = page.locator('.ai-comment-composer')
  await expect(composer).toBeVisible({ timeout: 5000 })
  await expect(composer.getByRole('button', { name: 'Suggest' })).toBeVisible()

  await composer.locator('.el-radio-button__inner', { hasText: 'Note' }).click()
  await expect(composer.getByRole('button', { name: 'Suggest' })).toHaveCount(0)
  await page.keyboard.press('Escape')
})
