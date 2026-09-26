import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getMarkdownContent,
  launchWithMarkdown,
  relaunchWithDoc,
  sendIpcToRenderer,
  waitForEditor
} from './helpers'

// Comments survive save and reopen because the anchor is document text rather
// than sidecar state — the claim the marker design rests on. This drives it:
// write a span comment and a document-wide one, save, reopen the file in a new
// process, and find both back in the panel.
//
// The document-wide marker is the shape worth pinning. It is unpaired
// (`<!--ai/: …-->`), it has no text of its own to anchor to, and it is the only
// scope whose target is the whole file, so a round trip through the serializer
// and the parser is where it would quietly turn into a block comment governing
// whatever paragraph follows it.
//
// The reopen also pins the deliberate asymmetry in the store: suggestions are
// in-memory, and a file scanned for the first time leaves its markers `pending`
// instead of dispatching. Opening a document carrying twenty comments must not
// spend twenty requests.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const HEADING = '# Handbook'
const PARAGRAPH = 'Expenses are reimbursed within thirty days of submission.'
const SPAN = 'thirty days'
const REWRITTEN = 'one month'
const SPAN_INSTRUCTION = 'state this in weeks'
const DOCUMENT_INSTRUCTION = 'keep the tone consistent'

let server: http.Server
let app: ElectronApplication
let page: Page
let filePath: string
let userDataDir: string
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

  const launched = await launchWithMarkdown(`${HEADING}\n\n${PARAGRAPH}\n`)
  app = launched.app
  page = launched.page
  filePath = launched.filePath
  userDataDir = launched.userDataDir

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

const openPanel = async(): Promise<void> => {
  await page.evaluate(() => {
    window.electron.ipcRenderer.send('mt::view-layout-changed', 0, {})
  })
  await page.locator('.side-bar .left-column li').nth(3).click()
  await expect(page.locator('.side-bar-ai-comments')).toBeVisible()
}

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

const comment = async(instruction: string): Promise<void> => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mt::ai::compose-comment')
  })
  const composer = page.locator('.ai-comment-composer')
  await expect(composer).toBeVisible({ timeout: 5000 })
  await composer.locator('textarea').fill(instruction)
  await composer.getByRole('button', { name: 'Comment' }).click()
  await expect(composer).toBeHidden({ timeout: 5000 })
}

const cardFor = (instruction: string): ReturnType<Page['locator']> =>
  page.locator('.side-bar-ai-comments .comment', { hasText: instruction })

test('both comment shapes reach the file on disk', async() => {
  await waitForEditor(page)
  await openPanel()

  await page.click('.editor-component')
  await selectPhrase(SPAN)
  await comment(SPAN_INSTRUCTION)
  await expect(cardFor(SPAN_INSTRUCTION).locator('.suggestion')).toHaveText(REWRITTEN, {
    timeout: 15000
  })

  // No selection is what makes the next comment document-wide.
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await comment(DOCUMENT_INSTRUCTION)
  const documentCard = cardFor(DOCUMENT_INSTRUCTION)
  await expect(documentCard.locator('.scope-hint')).toHaveText('Applies to the whole document', {
    timeout: 10000
  })
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-persist-01-before-save.png') })

  // Same channel File › Save sends.
  await sendIpcToRenderer(app, 'mt::editor-ask-file-save')
  await expect(page.locator('.editor-tabs li.unsaved')).toHaveCount(0, { timeout: 10000 })

  const onDisk = fs.readFileSync(filePath, 'utf-8')
  // The unpaired marker leads the file and stays unpaired — a stray `<!--/ai-->`
  // would turn it into a span comment over the heading.
  expect(onDisk.startsWith(`<!--ai/: ${DOCUMENT_INSTRUCTION}-->`)).toBe(true)
  expect(onDisk).toContain(`<!--ai: ${SPAN_INSTRUCTION}-->${SPAN}<!--/ai-->`)
  expect(onDisk).toContain(HEADING)
})

test('reopening the file restores both comments without spending a request', async() => {
  await app.close()

  const callsBefore = received.length
  const relaunched = await relaunchWithDoc(filePath, userDataDir)
  app = relaunched.app
  page = relaunched.page
  await openPanel()

  // Scope survived the round trip: the unpaired marker is still document-wide
  // rather than a block comment over the heading beneath it.
  const documentCard = cardFor(DOCUMENT_INSTRUCTION)
  await expect(documentCard).toBeVisible({ timeout: 10000 })
  await expect(documentCard.locator('.scope-hint')).toHaveText('Applies to the whole document')

  const spanCard = cardFor(SPAN_INSTRUCTION)
  await expect(spanCard).toBeVisible()
  await expect(spanCard.locator('.target')).toHaveText(SPAN)

  // Suggestions are not persisted, and a first scan must not dispatch: both come
  // back as work waiting for the user rather than as finished reviews.
  await expect(documentCard.locator('.status')).toHaveText('Pending')
  await expect(spanCard.locator('.status')).toHaveText('Pending')
  await page.waitForTimeout(1500)
  expect(received.length).toBe(callsBefore)
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-persist-02-reopened.png') })
})

test('a restored document comment runs on demand and is shown prose, not markers', async() => {
  const documentCard = cardFor(DOCUMENT_INSTRUCTION)
  await documentCard.getByRole('button', { name: 'Run' }).click()
  await expect(documentCard.locator('.suggestion')).toHaveText(REWRITTEN, { timeout: 15000 })

  const sent = received[received.length - 1].messages[1].content
  expect(sent).toContain(DOCUMENT_INSTRUCTION)
  expect(sent).toContain(PARAGRAPH)
  // A document comment's target is the stripped prose: showing the model the
  // review syntax would invite it to rewrite the markers into the document.
  expect(sent).not.toContain('<!--')

  // Nothing was applied by running it, so the markers are still in the file.
  const markdown = await getMarkdownContent(page, app)
  expect(markdown).toContain(`<!--ai/: ${DOCUMENT_INSTRUCTION}-->`)
  expect(markdown).toContain(`<!--ai: ${SPAN_INSTRUCTION}-->`)
})
