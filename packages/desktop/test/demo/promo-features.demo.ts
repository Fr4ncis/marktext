import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { getMarkdownContent, launchWithMarkdown, sendIpcToRenderer, waitForEditor } from '../e2e/helpers'
import { Recorder } from './recorder'

// A promo tour of the features added on feat/ai-assistant, filmed in the real
// app: AI rewrites and translations, Word-style comments on a selection, review
// comments that resolve in the background, version history, and the provider
// list. The provider is a local stub, so the run needs no API key and every
// "model" reply is scripted — the point is to show the editor, not a model.

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const OUT_FILE = path.join(REPO_ROOT, 'dist', 'marktext-ai-promo.mp4')
const SANS = '/System/Library/Fonts/Avenir Next.ttc'

const CASUAL = 'hey all, quick heads up the launch got moved to friday cuz QA found some stuff'
const FORMAL =
  'Please note that the launch has been rescheduled to Friday, as QA identified several issues that need to be resolved.'
const THANKS = 'Thank you all for the hard work this quarter.'
const FRENCH = 'Merci à toutes et à tous pour le travail accompli ce trimestre.'
const SPAN = 'maternity (12 months)'
const INCLUSIVE = 'parental leave (12 months)'
const PASSIVE = 'The configuration is loaded by the server at startup.'
const ACTIVE = 'The server loads the configuration at startup.'

const DOC = `# Team update

${CASUAL}

Parental leave now covers ${SPAN} and applies to all staff.

${PASSIVE}

${THANKS}
`

/** Scripted replies, keyed on what the request asks for. */
const reply = (prompt: string): string => {
  if (prompt.includes('French')) return FRENCH
  if (prompt.includes('inclusive')) return INCLUSIVE
  if (prompt.includes('active voice')) return ACTIVE
  if (prompt.includes('formal')) return FORMAL
  return prompt
}

const selectPhrase = async(page: Page, phrase: string): Promise<void> => {
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

const composeComment = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('mt::ai::compose-comment')
  })

test('promo: what is new in MarkText', async() => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content: string }> }
      const prompt = parsed.messages?.map((m) => m.content).join('\n') ?? ''
      // A short pause so the "working" state is on screen long enough to see.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'stub-model',
            choices: [{ message: { role: 'assistant', content: reply(prompt) }, finish_reason: 'stop' }]
          })
        )
      }, 1200)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const recorder = new Recorder(path.join(os.tmpdir(), 'mt-demo-promo'), 10)
  const card = (lines: string[], seconds: number, fontSize = 40): void =>
    recorder.card(lines, { seconds, fontSize, font: SANS })

  const launched = await launchWithMarkdown(DOC)
  const { app, page } = launched

  try {
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

    card(['MarkText', '', 'Now with an AI writing assistant.'], 3.5, 56)
    card(
      [
        "What's new",
        '',
        '•  Rewrite and translate any selection',
        '•  Comment on text, Word-style',
        '•  Review comments that resolve in the background',
        '•  Version history with diffs and one-click restore',
        '•  Ten providers, local or cloud'
      ],
      6,
      34
    )

    recorder.use(page)

    // ── Rewrite ───────────────────────────────────────────────────────────
    card(['1 · Rewrite', '', 'Select text, pick a prompt, review the result before it lands.'], 3.5, 34)
    recorder.startClip('rewrite')
    await recorder.caption('A rough draft, straight from chat')
    await recorder.hold(2000)
    await page.click('.editor-component')
    await selectPhrase(page, CASUAL)
    await recorder.caption('Select a sentence and run “Make formal”', 'Right-click → AI → Make formal')
    await recorder.hold(1200)
    await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')
    const dialog = page.locator('.el-dialog:has-text("AI ·")')
    await expect(dialog).toBeVisible({ timeout: 10000 })
    await expect(dialog.locator('textarea')).toHaveValue(FORMAL, { timeout: 10000 })
    await recorder.caption('A preview first — nothing changes until you say so')
    await recorder.hold(3000)
    await dialog.getByRole('button', { name: 'Replace selection' }).click()
    await expect(dialog).toBeHidden({ timeout: 5000 })
    await recorder.caption('Replaced in place, formatting intact')
    await recorder.hold(2500)
    await recorder.stopClip()

    // ── Translate ─────────────────────────────────────────────────────────
    card(['2 · Translate', '', 'Seven languages built in, plus your own prompts.'], 3, 34)
    recorder.startClip('translate')
    await selectPhrase(page, THANKS)
    await recorder.caption('Translate a selection', 'Right-click → AI → Translate to French')
    await recorder.hold(1200)
    await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'translate-fr')
    await expect(dialog.locator('textarea')).toHaveValue(FRENCH, { timeout: 10000 })
    await recorder.hold(2500)
    await dialog.getByRole('button', { name: 'Replace selection' }).click()
    await expect(dialog).toBeHidden({ timeout: 5000 })
    await recorder.hold(2000)
    await recorder.stopClip()

    // ── Comment on a selection ────────────────────────────────────────────
    card(['3 · Comment on a selection', '', 'Like Word comments — but the AI can act on them.'], 3.5, 34)
    await page.locator('.side-bar .left-column li').nth(3).click()
    await expect(page.locator('.side-bar-ai-comments')).toBeVisible()
    recorder.startClip('comment-span')
    await selectPhrase(page, SPAN)
    await recorder.caption('Select an exact phrase and add a comment')
    await recorder.hold(1200)
    await composeComment(app)
    const composer = page.locator('.ai-comment-composer')
    await expect(composer).toBeVisible({ timeout: 5000 })
    await composer.locator('textarea').pressSequentially('use inclusive wording', { delay: 55 })
    await recorder.hold(800)
    await composer.getByRole('button', { name: 'Comment' }).click()
    const spanCard = page.locator('.side-bar-ai-comments .comment', { hasText: INCLUSIVE }).first()
    await expect(spanCard).toBeVisible({ timeout: 15000 })
    await recorder.caption('The suggestion appears in the sidebar — only that phrase is rewritten')
    await recorder.hold(3000)
    await spanCard.getByRole('button', { name: 'Accept' }).click()
    await recorder.caption('Accept it, and the comment resolves')
    await recorder.hold(2500)
    await recorder.stopClip()

    // ── Background review comments ────────────────────────────────────────
    card(['4 · Review comments', '', 'Leave notes as you write. They resolve in the background.'], 3.5, 34)
    recorder.startClip('comment-marker')
    await recorder.caption('Type a review comment right in the markdown', '<!--ai: … -->')
    await page.getByText(PASSIVE).click()
    await page.keyboard.press('Home')
    await page.keyboard.type('<!--ai: use the active voice-->', { delay: 45 })
    await page.keyboard.press('Enter')
    await recorder.caption('Keep writing — the request runs in the background')
    const markerCard = page.locator('.side-bar-ai-comments .comment', { hasText: ACTIVE }).first()
    await expect(markerCard).toBeVisible({ timeout: 15000 })
    await recorder.hold(2500)
    await recorder.caption('Review when you are ready')
    await markerCard.getByRole('button', { name: 'Accept' }).click()
    await recorder.hold(2500)
    await recorder.stopClip()

    const edited = await getMarkdownContent(page, app)
    expect(edited).toContain(FORMAL)
    expect(edited).toContain(FRENCH)
    expect(edited).toContain(INCLUSIVE)
    expect(edited).toContain(ACTIVE)
    expect(edited).not.toContain('<!--ai:')

    // ── Version history ───────────────────────────────────────────────────
    card(['5 · Version history', '', 'Every AI edit is one click from undone.'], 3.5, 34)
    await page.locator('.side-bar .left-column li').nth(4).click()
    await expect(page.locator('.side-bar-history')).toBeVisible()
    recorder.startClip('history')
    await recorder.caption('The draft is saved before the first AI edit, and after every large change')
    await recorder.hold(3000)

    await recorder.caption('Pick a version to see exactly what changed since')
    await page.locator('.side-bar-history .entry', { hasText: 'Before AI edit' }).first().click()
    const preview = page.locator('.side-bar-history .preview')
    await expect(preview.locator('.diff-line.op-delete').first()).toBeVisible({ timeout: 5000 })
    await recorder.hold(4000)
    await recorder.caption('Restore it — the current text is kept as a version too')
    await page.getByRole('button', { name: 'Restore this version' }).click()
    await page.waitForTimeout(1200)
    await recorder.hold(3000)
    await recorder.stopClip()
    expect(await getMarkdownContent(page, app)).toContain(CASUAL)

    // ── Providers ─────────────────────────────────────────────────────────
    card(['6 · Your model, your choice', '', 'Cloud providers or a model running on your own machine.'], 3.5, 34)
    await page.evaluate(() => window.electron.ipcRenderer.send('mt::open-setting-window'))
    const prefs = await app.waitForEvent('window', { timeout: 20000 })
    await prefs.waitForLoadState('domcontentloaded')
    await prefs.waitForTimeout(1200)
    await prefs.getByText('AI', { exact: true }).click()
    await prefs.waitForTimeout(600)
    recorder.use(prefs)
    recorder.startClip('providers')
    await recorder.caption('Preferences → AI')
    await recorder.hold(2000)
    await prefs.locator('.pref-ai .el-select__wrapper').first().click()
    await recorder.caption('Anthropic, OpenAI, Gemini, Mistral, Groq, DeepSeek, Cerebras, OpenRouter, Ollama, LM Studio')
    await recorder.hold(4000)
    await prefs.keyboard.press('Escape')
    await recorder.caption('Keys can be imported from your shell profile; personas load from Markdown files')
    await recorder.hold(3500)
    await recorder.stopClip()

    card(['MarkText', '', 'Write. Review. Rewind.', '', 'github.com/Fr4ncis/marktext'], 5, 48)

    const file = recorder.assemble(OUT_FILE)
    console.log('VIDEO:', file, `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`)
  } finally {
    await app.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
