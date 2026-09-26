import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getMarkdownContent,
  launchWithMarkdown,
  setSourceMarkdown,
  waitForEditor
} from './helpers'

// What happens to a comment when the text under it changes while a suggestion
// is outstanding or already back.
//
// Anchors are markers in the document text, so they move with the user's edits
// for free — that is the whole reason for the design. What is not free is the
// suggestion attached to them: a rewrite of the words the model was shown must
// never be offered for words the user has since changed, or accepting it quietly
// discards their edit. `reconcileAiComments` drops such a suggestion back to
// `pending`, and `ai-comments` unit-tests that on plain strings. Only a driven
// editor shows the panel actually following it.
//
// Edits are made through source mode: it is a supported editing surface the
// comment scanner already watches, and it lets a spec change an exact span
// without depending on how the markers happen to render in the WYSIWYG view.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const HEADING = '# Policy'
const PARAGRAPH = 'Parental leave now covers maternity (12 months) and applies to all staff.'
const NOTICE = 'Requests go to the people team at least eight weeks in advance.'
const SPAN = 'maternity (12 months)'
const EDITED_SPAN = 'maternity or paternity (12 months)'
const REWRITTEN = 'parental leave (12 months)'
const INTRO = 'This policy was last reviewed in March.'

let server: http.Server
let app: ElectronApplication
let page: Page
/** Prompts the stub was asked to answer, so a spec can tell a re-run happened. */
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

  const launched = await launchWithMarkdown(`${HEADING}\n\n${PARAGRAPH}\n\n${NOTICE}\n`)
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

const openPanel = async(): Promise<void> => {
  await page.locator('.side-bar .left-column li').nth(3).click()
  await expect(page.locator('.side-bar-ai-comments')).toBeVisible()
}

/** Selects `phrase` in the rendered document via a DOM range. */
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

/** Comments on the current selection and waits for the card to appear. */
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

/** Rewrites the document through source mode and lets the debounced scan run. */
const editDocument = async(rewrite: (markdown: string) => string): Promise<void> => {
  const before = await getMarkdownContent(page, app)
  const after = rewrite(before)
  expect(after).not.toBe(before)
  await setSourceMarkdown(page, app, after)
  await page.waitForTimeout(1200)
}

test('editing the commented span drops the stale suggestion', async() => {
  await waitForEditor(page)
  await openPanel()
  await page.click('.editor-component')
  await selectPhrase(SPAN)
  await comment('use inclusive wording')

  const card = cardFor('use inclusive wording')
  await expect(card.locator('.suggestion')).toHaveText(REWRITTEN, { timeout: 15000 })
  expect(await getMarkdownContent(page, app)).toContain(
    `<!--ai: use inclusive wording-->${SPAN}<!--/ai-->`
  )

  // Widen the commented span. The suggestion in hand rewrote the narrower
  // wording, so offering it now would throw away the word just typed.
  await editDocument((markdown) => markdown.replace(`-->${SPAN}<!--`, `-->${EDITED_SPAN}<!--`))
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-anchor-01-stale.png') })

  await expect(card.locator('.status')).toHaveText('Pending')
  await expect(card.locator('.suggestion')).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Accept' })).toHaveCount(0)
  // The comment is still anchored to the edited text, ready to re-run.
  await expect(card.locator('.target')).toContainText(EDITED_SPAN)
  await expect(card.getByRole('button', { name: 'Run' })).toBeVisible()

  const markdown = await getMarkdownContent(page, app)
  expect(markdown).toContain(`-->${EDITED_SPAN}<!--`)
  expect(markdown).not.toContain(REWRITTEN)
})

test('an edit above the anchor keeps the suggestion and still accepts in place', async() => {
  const card = cardFor('use inclusive wording')
  const callsBefore = received.length
  await card.getByRole('button', { name: 'Run' }).click()
  await expect(card.locator('.suggestion')).toHaveText(REWRITTEN, { timeout: 15000 })
  expect(received.length).toBeGreaterThan(callsBefore)
  // The re-run asked about the edited wording, not the wording it first saw.
  expect(received[received.length - 1].messages[1].content).toContain(EDITED_SPAN)

  // Insert a paragraph above, moving every offset the card was recorded at.
  await editDocument((markdown) => markdown.replace(`${HEADING}\n\n`, `${HEADING}\n\n${INTRO}\n\n`))

  // The target text did not change, so the suggestion is still valid.
  await expect(card.locator('.status')).toHaveText('Ready')
  await expect(card.locator('.suggestion')).toHaveText(REWRITTEN)

  await card.getByRole('button', { name: 'Accept' }).click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-anchor-02-accepted.png') })

  const after = await getMarkdownContent(page, app)
  // Accepted at the shifted position: exactly the span changed, and the
  // paragraph inserted above it survived intact.
  expect(after).toContain(`Parental leave now covers ${REWRITTEN} and applies to all staff.`)
  expect(after).toContain(INTRO)
  expect(after).toContain(NOTICE)
  expect(after).not.toContain('<!--ai:')
  expect(after).not.toContain('<!--/ai-->')
})

test('deleting the commented text forgets the comment', async() => {
  await selectPhrase('eight weeks')
  await comment('confirm the notice period')

  const card = cardFor('confirm the notice period')
  await expect(card.locator('.suggestion')).toHaveText(REWRITTEN, { timeout: 15000 })

  // The user cuts the sentence the comment hangs off, markers and all. There is
  // nothing left to review, so the card must go rather than linger pointing at
  // text that no longer exists.
  await editDocument((markdown) =>
    markdown.replace(
      '<!--ai: confirm the notice period-->eight weeks<!--/ai-->',
      'two weeks'
    )
  )
  await page.screenshot({ path: path.join(SHOT_DIR, 'aic-anchor-03-forgotten.png') })

  await expect(card).toHaveCount(0)
  await expect(page.locator('.side-bar-ai-comments .empty')).toContainText(
    'No comments in this document.'
  )
  expect(await getMarkdownContent(page, app)).toContain('at least two weeks in advance')
})
