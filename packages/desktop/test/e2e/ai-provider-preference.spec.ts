import { test, expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import {
  focusEditor,
  launchWithMarkdown,
  relaunchWithDoc,
  sendIpcToRenderer,
  waitForEditor
} from './helpers'

// Provider settings round trip: what the settings pane writes must reach the
// next request, be written to preferences.json, and still be in force after a
// restart.
//
// `ai-settings-from-preferences` unit-tests the mapping from the store to an
// `AIProviderSettings`, but that starts from a store that already holds the new
// values. The failure it cannot see is the one users report — a provider or
// model changed in Preferences that quietly reverts, or that never reaches
// main because it was only ever set on a renderer-local copy.

const ORIGINAL = 'hey so i got the thing you sent, thanks'
const REWRITTEN = 'The undersigned hereby acknowledges receipt of the aforementioned document.'

let server: http.Server
let app: ElectronApplication
let page: Page
let baseUrl: string
let userDataDir: string
let filePath: string

/** Model names on each request, in order, so a spec can assert what was used last. */
const models: string[] = []

const runPrompt = async(): Promise<ReturnType<Page['locator']>> => {
  await waitForEditor(page)
  // A relaunched window comes up with the restored sidebar rather than the
  // editor holding the selection, so put the caret in the document first —
  // `selectAll` alone is a no-op when focus is outside the editor, and the
  // prompt would then report "select some text first" instead of running.
  await focusEditor(page)
  await sendIpcToRenderer(app, 'mt::editor-edit-action', 'selectAll')
  await page.waitForTimeout(400)
  await sendIpcToRenderer(app, 'mt::ai::run-prompt', 'formal')
  return page.locator('.el-dialog:has-text("AI ·")')
}

/** Runs a prompt, discards the preview, and returns the model that went on the wire. */
const modelUsedByNextRequest = async(): Promise<string> => {
  const sent = models.length
  const dialog = await runPrompt()
  await expect(dialog.locator('textarea')).toHaveValue(REWRITTEN, { timeout: 15000 })
  expect(models.length).toBe(sent + 1)
  await dialog.getByRole('button', { name: 'Discard' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  return models[models.length - 1]
}

const readStoredPreferences = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(userDataDir, 'preferences.json'), 'utf8')) as Record<
    string,
    unknown
  >

test.beforeAll(async() => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { model?: string }
      models.push(body.model ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { role: 'assistant', content: REWRITTEN }, finish_reason: 'stop' }]
        })
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}/v1`

  const launched = await launchWithMarkdown(ORIGINAL)
  app = launched.app
  page = launched.page
  userDataDir = launched.userDataDir
  filePath = launched.filePath

  await page.evaluate(
    (config) => {
      window.electron.ipcRenderer.send('mt::set-user-preference', {
        aiEnabled: true,
        aiProvider: 'lmstudio',
        aiModel: 'stub-model-first',
        aiBaseUrl: config.baseUrl
      })
    },
    { baseUrl }
  )
  await page.waitForTimeout(800)
})

test.afterAll(async() => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('the configured model is the one sent to the provider', async() => {
  expect(await modelUsedByNextRequest()).toBe('stub-model-first')
})

test('changing provider and model in Preferences takes effect on the next request', async() => {
  await page.evaluate(() => {
    window.electron.ipcRenderer.send('mt::set-user-preference', {
      aiProvider: 'ollama',
      aiModel: 'stub-model-second'
    })
  })
  await page.waitForTimeout(800)

  // No reload, no restart: the very next request must carry the new model.
  expect(await modelUsedByNextRequest()).toBe('stub-model-second')

  // And the write reached main, not just the renderer's copy of the store.
  const stored = readStoredPreferences()
  expect(stored.aiProvider).toBe('ollama')
  expect(stored.aiModel).toBe('stub-model-second')
  expect(stored.aiBaseUrl).toBe(baseUrl)
})

test('the change survives a restart', async() => {
  await app.close()

  const relaunched = await relaunchWithDoc(filePath, userDataDir)
  app = relaunched.app
  page = relaunched.page

  // Startup used to delete every setting that static/preference.json did not
  // list, which was all nine `ai*` keys — so this came back as the schema
  // default (`anthropic` / `claude-opus-5`, assistant disabled) and the user's
  // configuration was gone. Assert the stored file first: it says whether the
  // settings survived the restart, where a failed request only says something
  // is wrong.
  const stored = readStoredPreferences()
  expect(stored.aiEnabled).toBe(true)
  expect(stored.aiProvider).toBe('ollama')
  expect(stored.aiModel).toBe('stub-model-second')
  expect(stored.aiBaseUrl).toBe(baseUrl)

  expect(await modelUsedByNextRequest()).toBe('stub-model-second')
})
