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

// The Anthropic path end to end, against a stub server. Everything else in the
// AI suite drives the OpenAI-compatible adapter through LM Studio; Anthropic is
// the one provider that is not OpenAI-shaped — it goes through the official SDK
// and it authenticates — so none of that coverage says anything about it.
// `ai-anthropic-response` unit-tests the response interpreter in isolation; what
// is only observable here is the wire request, the key coming back out of the
// encrypted store, and the retry when a model rejects `output_config.effort`.
//
// Two things make this hermetic:
//
//  - the SDK is pointed at the stub through ANTHROPIC_BASE_URL, which it reads
//    itself when the client is constructed without an explicit `baseURL` (the
//    adapter never passes one, since `baseUrl` is documented as ignored for
//    Anthropic). No production code is test-aware.
//  - `--password-store=basic` gives Electron's safeStorage a working backend on
//    a Linux runner with no keyring daemon, so a fake key can be stored through
//    the real `mt::ai::set-key` path instead of a test-only bypass. macOS
//    ignores the switch and uses the Keychain, which is available anyway.
//
// If safeStorage is still unavailable the spec skips rather than fails: without
// it the app itself refuses to store a key, so there is no behaviour to assert.

const SHOT_DIR = process.env.MT_SHOT_DIR || os.tmpdir()

const ORIGINAL = 'hey so i got the thing you sent, thanks'
const REWRITTEN = 'The undersigned hereby acknowledges receipt of the aforementioned document.'
/**
 * Long enough to be obviously a partial sentence if it were ever applied, and
 * deliberately not a prefix of REWRITTEN — an earlier test applies that, so a
 * shared prefix would make "the truncation never landed" assert nothing.
 */
const TRUNCATED = 'Receipt of the aforementioned document is hereby acknowl'
/** Never a real credential — the assertion is that this exact string reaches the wire. */
const FAKE_KEY = 'sk-ant-e2e-0123456789abcdef'
const STUB_MODEL = 'claude-stub'

type Mode = 'ok' | 'effort-unsupported' | 'truncated' | 'unauthorized'
let mode: Mode = 'ok'

interface Call {
  body: Record<string, unknown>
  headers: http.IncomingHttpHeaders
  url: string
}

const calls: Call[] = []

let server: http.Server
let app: ElectronApplication
let page: Page
/** False when the OS has no usable keychain, which makes the whole spec moot. */
let encryptionAvailable = false

const message = (text: string, stopReason: string): unknown => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: STUB_MODEL,
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 24 }
})

const respond = (res: http.ServerResponse, call: Call): void => {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  switch (mode) {
    case 'ok':
      return json(200, message(REWRITTEN, 'end_turn'))
    case 'effort-unsupported':
      // What a model older than Opus 4.5 answers when it is sent
      // `output_config.effort`. The adapter is expected to drop the parameter
      // and try once more rather than surface this to the user.
      if ('output_config' in call.body) {
        return json(400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'output_config.effort: Extra inputs are not permitted'
          }
        })
      }
      return json(200, message(REWRITTEN, 'end_turn'))
    case 'truncated':
      return json(200, message(TRUNCATED, 'max_tokens'))
    case 'unauthorized':
      return json(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' }
      })
  }
}

/** Runs a prompt over the whole document and returns the dialog, left open. */
const runPrompt = async(): Promise<ReturnType<Page['locator']>> => {
  await waitForEditor(page)
  await sendIpcToRenderer(app, 'mt::editor-edit-action', 'selectAll')
  await page.waitForTimeout(400)
  await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')
  return page.locator('.el-dialog:has-text("AI ·")')
}

test.beforeAll(async() => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const call: Call = {
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
        headers: req.headers,
        url: req.url || ''
      }
      calls.push(call)
      respond(res, call)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const launched = await launchWithMarkdown(ORIGINAL, {
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
    switches: ['--password-store=basic']
  })
  app = launched.app
  page = launched.page

  encryptionAvailable = await page.evaluate(() => window.aiAssistant.isEncryptionAvailable())
  if (!encryptionAvailable) return

  const stored = await page.evaluate(
    (key) => window.aiAssistant.setApiKey('anthropic', key),
    FAKE_KEY
  )
  expect(stored).toEqual({ ok: true })
  // A key that is on file is the precondition for every test below; if the
  // store reported success but reads back absent, fail here rather than as a
  // confusing "missing credentials" error inside a test.
  const status = await page.evaluate(() => window.aiAssistant.credentialStatus())
  expect(status.anthropic).toBe(true)

  await page.evaluate(() => {
    window.electron.ipcRenderer.send('mt::set-user-preference', {
      aiEnabled: true,
      aiProvider: 'anthropic',
      aiModel: 'claude-stub',
      // Ignored for Anthropic — the SDK takes its host from ANTHROPIC_BASE_URL.
      aiBaseUrl: ''
    })
  })
  await page.waitForTimeout(800)
})

test.afterAll(async() => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('rewrites the selection through the Anthropic SDK', async() => {
  test.skip(!encryptionAvailable, 'safeStorage has no backend, so no key can be stored')
  mode = 'ok'
  calls.length = 0

  const dialog = await runPrompt()
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
  await page.screenshot({ path: path.join(SHOT_DIR, 'ai-anthropic-01-preview.png') })

  await dialog.getByRole('button', { name: 'Replace selection' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await page.waitForTimeout(600)

  const after = await getMarkdownContent(page, app)
  expect(after).toContain(REWRITTEN)
  expect(after).not.toContain(ORIGINAL)

  expect(calls).toHaveLength(1)
  const [call] = calls
  expect(call.url).toBe('/v1/messages')

  // The key came out of the encrypted store and reached the wire as itself —
  // the property that no unit test of the adapter can show, since it stops at
  // the `apiKey` argument.
  expect(call.headers['x-api-key']).toBe(FAKE_KEY)
  expect(call.headers['anthropic-version']).toBeTruthy()
  // Never the OpenAI-shaped header, which would mean the wrong adapter ran.
  expect(call.headers.authorization).toBeUndefined()

  const body = call.body as {
    model: string
    max_tokens: number
    system: string
    messages: Array<{ role: string; content: string }>
    output_config?: { effort?: string }
  }
  expect(body.model).toBe(STUB_MODEL)
  expect(body.max_tokens).toBeGreaterThan(0)
  // Anthropic takes the system prompt as its own field rather than a message.
  expect(body.system).toContain('Return only the rewritten excerpt')
  expect(body.messages).toHaveLength(1)
  expect(body.messages[0].role).toBe('user')
  expect(body.messages[0].content).toContain('formal')
  expect(body.messages[0].content).toContain(ORIGINAL)
  // Effort is what keeps a rewrite from being billed and timed as a reasoning
  // task, so its absence is a regression even though the result looks right.
  expect(body.output_config?.effort).toBe('low')
})

test('a model that rejects output_config.effort is retried without it', async() => {
  test.skip(!encryptionAvailable, 'safeStorage has no backend, so no key can be stored')
  mode = 'effort-unsupported'
  calls.length = 0

  const dialog = await runPrompt()
  // The user sees a rewrite, not the 400 — the fallback is invisible by design.
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
  await expect(dialog.locator('.ai-error')).toBeHidden()

  expect(calls).toHaveLength(2)
  expect((calls[0].body as { output_config?: unknown }).output_config).toBeDefined()
  expect((calls[1].body as { output_config?: unknown }).output_config).toBeUndefined()
  // The retry must carry the same request, not a degraded one.
  expect(calls[1].body.model).toBe(calls[0].body.model)
  expect(calls[1].body.system).toEqual(calls[0].body.system)
  expect(calls[1].body.messages).toEqual(calls[0].body.messages)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('a response cut off by max_tokens is refused, not applied', async() => {
  test.skip(!encryptionAvailable, 'safeStorage has no backend, so no key can be stored')
  mode = 'truncated'
  const before = await getMarkdownContent(page, app)

  const dialog = await runPrompt()
  const error = dialog.locator('.ai-error')
  await expect(error).toBeVisible({ timeout: 15000 })
  await expect(error).toContainText('token limit', { timeout: 5000 })

  // Half a sentence spliced into the document is the failure this guards.
  const after = await getMarkdownContent(page, app)
  expect(after).toBe(before)
  expect(after).not.toContain(TRUNCATED)
  await expect(dialog.getByRole('button', { name: 'Replace selection' })).toBeHidden()

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})

test('a rejected key surfaces as an authentication error', async() => {
  test.skip(!encryptionAvailable, 'safeStorage has no backend, so no key can be stored')
  mode = 'unauthorized'
  const before = await getMarkdownContent(page, app)

  const dialog = await runPrompt()
  const error = dialog.locator('.ai-error')
  await expect(error).toBeVisible({ timeout: 15000 })
  await expect(error).toContainText(/key|authenticat/i, { timeout: 5000 })
  expect(await getMarkdownContent(page, app)).toBe(before)

  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
})
