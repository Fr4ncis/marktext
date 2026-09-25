import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as fs from 'node:fs'
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

test('a configured persona is prepended to the system prompt', async() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marktext-persona-e2e-'))
  const personaFile = path.join(dir, 'house.md')
  fs.writeFileSync(personaFile, 'You are the in-house style editor. Prefer short sentences.')

  try {
    await page.evaluate((filePath) => {
      window.electron.ipcRenderer.send('mt::set-user-preference', {
        aiPersonas: [{ id: 'house', name: 'House style', filePath }],
        aiDefaultPersonaId: 'house'
      })
    }, personaFile)
    await page.waitForTimeout(700)

    const callsBefore = received.length
    await waitForEditor(page)
    await sendIpcToRenderer(app, 'mt::editor-edit-action', 'selectAll')
    await page.waitForTimeout(400)
    await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')

    const dialog = page.locator('.el-dialog:has-text("AI ·")')
    await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
    expect(received.length).toBeGreaterThan(callsBefore)

    const last = received[received.length - 1] as {
      messages: Array<{ role: string; content: string }>
    }
    const system = last.messages[0]
    expect(system.role).toBe('system')
    // The persona leads, and the contract that keeps output pasteable follows.
    expect(system.content.startsWith('You are the in-house style editor.')).toBe(true)
    expect(system.content).toContain('Return only the rewritten excerpt')

    await dialog.getByRole('button', { name: 'Discard' }).click()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a prompt that names its own persona overrides the default', async() => {
  // The interesting case is the one where two personas are configured and the
  // prompt picks the non-default one: a request that silently used the global
  // default would still look correct in the dialog, and only show up as the
  // wrong voice in the rewritten text.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marktext-persona-pick-e2e-'))
  const defaultPersona = path.join(dir, 'house.md')
  const promptPersona = path.join(dir, 'legal.md')
  fs.writeFileSync(defaultPersona, 'You are the in-house style editor. Prefer short sentences.')
  fs.writeFileSync(promptPersona, 'You are a contracts lawyer. Prefer precise, defensible wording.')

  try {
    await page.evaluate(
      (personas) => {
        window.electron.ipcRenderer.send('mt::set-user-preference', {
          aiPersonas: [
            { id: 'house', name: 'House style', filePath: personas.defaultPersona },
            { id: 'legal', name: 'Legal', filePath: personas.promptPersona }
          ],
          aiDefaultPersonaId: 'house',
          // Shaped like a stored library: the built-in prompt, edited to carry a
          // persona of its own.
          aiPrompts: [
            {
              id: 'formal',
              label: 'Make formal',
              template:
                'Rewrite the following markdown in a formal, professional register. Preserve the meaning and all markdown formatting.',
              builtin: true,
              enabled: true,
              personaId: 'legal'
            }
          ]
        })
      },
      { defaultPersona, promptPersona }
    )
    await page.waitForTimeout(700)

    const callsBefore = received.length
    await waitForEditor(page)
    await sendIpcToRenderer(app, 'mt::editor-edit-action', 'selectAll')
    await page.waitForTimeout(400)
    await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')

    const dialog = page.locator('.el-dialog:has-text("AI ·")')
    await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
    expect(received.length).toBeGreaterThan(callsBefore)

    const last = received[received.length - 1] as {
      messages: Array<{ role: string; content: string }>
    }
    const system = last.messages[0].content
    expect(system.startsWith('You are a contracts lawyer.')).toBe(true)
    expect(system).not.toContain('in-house style editor')
    expect(system).toContain('Return only the rewritten excerpt')

    await dialog.getByRole('button', { name: 'Discard' }).click()
    await expect(dialog).toBeHidden({ timeout: 5000 })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
