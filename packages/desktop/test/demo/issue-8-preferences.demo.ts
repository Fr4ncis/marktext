import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, relaunchWithDoc } from '../e2e/helpers'
import { Recorder } from './recorder'

// Records the walkthrough for Fr4ncis/marktext#8 — every AI preference deleted
// at startup — as evidence a reader can watch instead of reproducing.
//
// The recording is in three acts: the bug happening in the real Preferences
// pane, the e2e spec failing against the same pre-fix state and passing once it
// is restored, then the fixed build doing what the user asked for.
//
// Act one needs a pre-fix build. The fix is one file's contents
// (static/preference.json), so the demo stages the pre-fix version of that file
// and restores it in a `finally` — there is no second checkout to build, and the
// app reads the file at startup rather than bundling it, so no rebuild either.

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const DEFAULTS_FILE = path.resolve(__dirname, '../../static/preference.json')
const DEFAULTS_REL = 'packages/desktop/static/preference.json'
/** The commit that added the AI defaults; its parent is the state that loses them. */
const FIX_COMMIT = '5c2c6d57'

const MODEL = 'qwen3-coder-30b'
const BASE_URL = 'http://127.0.0.1:1234/v1'
const OUT_FILE = path.join(REPO_ROOT, 'dist', 'issue-8-preferences.mp4')

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 }).toString()

/** The `ai*` entries of a profile's preferences.json, for a title card. */
const aiSettingsOnDisk = (userDataDir: string): string[] => {
  const file = path.join(userDataDir, 'preferences.json')
  if (!fs.existsSync(file)) return ['(no preferences.json yet)']
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  return Object.entries(parsed)
    .filter(([key]) => /^ai(Enabled|Provider|Model|BaseUrl)$/.test(key))
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)
}

const openAiPane = async(app: ElectronApplication, main: Page): Promise<Page> => {
  await main.evaluate(() => window.electron.ipcRenderer.send('mt::open-setting-window'))
  const prefs = await app.waitForEvent('window', { timeout: 20000 })
  await prefs.waitForLoadState('domcontentloaded')
  await prefs.waitForTimeout(1200)
  await prefs.getByText('AI', { exact: true }).click()
  await prefs.waitForTimeout(600)
  return prefs
}

/** What the pane currently shows, in the order a reader would check it. */
const paneState = async(prefs: Page): Promise<{ enabled: boolean; selects: string[]; inputs: string[] }> => {
  const enabled = await prefs.locator('.pref-ai .el-switch.is-checked').count()
  const selects = await prefs.locator('.pref-ai .el-select__wrapper').allInnerTexts()
  const inputs = prefs.locator('.pref-ai .el-input__inner')
  // Only the first two matter here: Model, then Base URL. The rest of the
  // inputs on this pane are the prompt library.
  const values: string[] = []
  for (let i = 0; i < Math.min(2, await inputs.count()); i++) {
    values.push(await inputs.nth(i).inputValue())
  }
  return { enabled: enabled > 0, selects, inputs: values }
}

/** Drives the pane the way a user would: switch on, pick provider, type both fields. */
const configure = async(prefs: Page, recorder: Recorder): Promise<void> => {
  await recorder.caption(
    'Turn the assistant on and pick a provider',
    'Preferences → AI'
  )
  await prefs.locator('.pref-ai .el-switch').click()
  await prefs.waitForTimeout(700)

  await prefs.locator('.pref-ai .el-select__wrapper').first().click()
  await prefs.waitForTimeout(500)
  await prefs.locator('.el-select-dropdown__item', { hasText: 'LM Studio (local)' }).first().click()
  await prefs.waitForTimeout(900)

  await recorder.caption(
    'Type the model and the local server URL',
    'LM Studio serves whatever the user has loaded, so both are typed by hand'
  )
  const inputs = prefs.locator('.pref-ai .el-input__inner')
  await inputs.nth(0).fill(MODEL)
  await inputs.nth(0).press('Enter')
  await prefs.waitForTimeout(600)
  await inputs.nth(1).fill(BASE_URL)
  await inputs.nth(1).press('Enter')
  await prefs.waitForTimeout(1200)
}

/** Runs the round-trip spec in a child process and returns its output. */
const runSpec = (): { ok: boolean; lines: string[] } => {
  try {
    const out = execFileSync(
      'pnpm',
      [
        '-C', 'packages/desktop',
        'exec', 'playwright', 'test',
        '-c', 'test/e2e/playwright.config.ts',
        'ai-provider-preference'
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        // Plain output: the run's text ends up rendered into a title card, where
        // colour escapes would show up as literal `[32m` noise.
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      }
    )
    return { ok: true, lines: out.split('\n') }
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string }
    return { ok: false, lines: `${shell.stdout ?? ''}${shell.stderr ?? ''}`.split('\n') }
  }
}

/** Strips the colour escapes Playwright writes even with NO_COLOR in some paths. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

/** Picks the lines from a Playwright run that say what happened. */
const summarise = (lines: string[], limit = 12): string[] =>
  lines
    .map((line) => line.replace(ANSI, '').replace(/\s+$/, ''))
    .filter((line) =>
      /✓|✘|Error:|Expected|Received|passed|failed|toBe|ai-provider-preference\.spec/.test(line)
    )
    .map((line) => line.trim().slice(0, 92))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, limit)

test('issue #8 walkthrough: AI settings wiped on restart', async() => {
  const fixedDefaults = fs.readFileSync(DEFAULTS_FILE, 'utf8')
  const preFixDefaults = git('show', `${FIX_COMMIT}^:${DEFAULTS_REL}`)
  expect(preFixDefaults).not.toContain('aiProvider')
  expect(fixedDefaults).toContain('aiProvider')

  const recorder = new Recorder(path.join(os.tmpdir(), 'mt-demo-issue-8'), 6)

  try {
    recorder.card(
      [
        'Issue #8',
        '',
        'AI settings are silently wiped on every restart',
        '',
        'github.com/Fr4ncis/marktext/issues/8'
      ],
      { seconds: 4 }
    )
    recorder.card(
      [
        'Act 1 — the bug, in the pre-fix build',
        '',
        `static/preference.json at ${FIX_COMMIT}^`,
        'lists no ai* keys, so Preference.init() deletes them all at startup.'
      ],
      { seconds: 4.5, fontSize: 26 }
    )

    // ── Act 1: pre-fix ────────────────────────────────────────────────────
    fs.writeFileSync(DEFAULTS_FILE, preFixDefaults)

    const first = await launchWithMarkdown('# Handbook\n\nExpenses are reimbursed within thirty days.\n')
    recorder.use(first.page)
    let prefs = await openAiPane(first.app, first.page)
    recorder.use(prefs)
    recorder.startClip('act1-configure')
    await recorder.caption('A fresh profile, on the build without the fix', 'Preferences → AI')
    await recorder.hold(2000)
    await configure(prefs, recorder)

    await recorder.caption('Saved. This is what the settings pane now shows.')
    await recorder.hold(2000)
    const configured = await paneState(prefs)
    expect(configured.enabled).toBe(true)
    expect(configured.inputs[0]).toBe(MODEL)
    await recorder.stopClip()

    recorder.card(
      ['preferences.json in the profile directory:', '', ...aiSettingsOnDisk(first.userDataDir)],
      { seconds: 4, fontSize: 24 }
    )
    recorder.card(['Quit MarkText, then open it again.', '', 'Same profile. Nothing else touched.'], {
      seconds: 3.5,
      fontSize: 26
    })

    await first.app.close()

    const second = await relaunchWithDoc(first.filePath, first.userDataDir)
    recorder.use(second.page)
    prefs = await openAiPane(second.app, second.page)
    recorder.use(prefs)
    recorder.startClip('act1-after-restart')
    await recorder.caption('After the restart', 'Preferences → AI, same profile')
    await recorder.hold(2500)

    const reverted = await paneState(prefs)
    await recorder.caption(
      `Provider: ${reverted.selects[0]} · Model: ${reverted.inputs[0] || reverted.selects[1]} · Assistant: ${reverted.enabled ? 'on' : 'off'}`,
      'Everything configured a moment ago is gone — no error, no log line'
    )
    await recorder.hold(3500)
    await recorder.stopClip()
    // The bug, asserted rather than only filmed.
    expect(reverted.enabled).toBe(false)
    expect(reverted.selects[0]).toBe('Anthropic')

    recorder.card(
      ['preferences.json after the restart:', '', ...aiSettingsOnDisk(second.userDataDir)],
      { seconds: 4.5, fontSize: 24 }
    )
    await second.app.close()

    // ── Act 2: the automation ─────────────────────────────────────────────
    recorder.card(
      [
        'Act 2 — what the automation says',
        '',
        'test/e2e/ai-provider-preference.spec.ts',
        'Preferences → next request → preferences.json → survives a restart'
      ],
      { seconds: 4.5, fontSize: 26 }
    )

    const failing = runSpec()
    recorder.card(['Against the pre-fix state:', '', ...summarise(failing.lines)], {
      seconds: 8,
      fontSize: 18,
      color: '0xff8a80'
    })
    expect(failing.ok).toBe(false)

    fs.writeFileSync(DEFAULTS_FILE, fixedDefaults)
    const passing = runSpec()
    recorder.card(['With the fix in place:', '', ...summarise(passing.lines)], {
      seconds: 7,
      fontSize: 18,
      color: '0x9ae6b4'
    })
    expect(passing.ok).toBe(true)

    // ── Act 3: fixed ──────────────────────────────────────────────────────
    recorder.card(['Act 3 — the same steps on the fixed build'], { seconds: 3, fontSize: 28 })

    const third = await launchWithMarkdown('# Handbook\n\nExpenses are reimbursed within thirty days.\n')
    recorder.use(third.page)
    prefs = await openAiPane(third.app, third.page)
    recorder.use(prefs)
    recorder.startClip('act3-configure')
    await configure(prefs, recorder)
    await recorder.caption('Saved, as before. Now quit and reopen.')
    await recorder.hold(2000)
    await recorder.stopClip()
    await third.app.close()

    const fourth = await relaunchWithDoc(third.filePath, third.userDataDir)
    recorder.use(fourth.page)
    prefs = await openAiPane(fourth.app, fourth.page)
    recorder.use(prefs)
    recorder.startClip('act3-after-restart')
    await recorder.caption('After the restart', 'Preferences → AI, same profile')
    await recorder.hold(2500)

    const kept = await paneState(prefs)
    await recorder.caption(
      `Provider: ${kept.selects[0]} · Model: ${kept.inputs[0]} · Assistant: ${kept.enabled ? 'on' : 'off'}`,
      'The configuration survived the restart'
    )
    await recorder.hold(3500)
    await recorder.stopClip()
    expect(kept.enabled).toBe(true)
    expect(kept.selects[0]).toBe('LM Studio (local)')
    expect(kept.inputs[0]).toBe(MODEL)
    expect(kept.inputs[1]).toBe(BASE_URL)

    recorder.card(
      [
        'Fixed in 5c2c6d57',
        '',
        'static/preference.json carries the nine ai* defaults,',
        'and preference-defaults-parity.spec.ts pins the two files',
        'against each other so it cannot happen again.'
      ],
      { seconds: 5, fontSize: 24 }
    )
    await fourth.app.close()

    const file = recorder.assemble(OUT_FILE)
    console.log('VIDEO:', file, `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`)
  } finally {
    // The staged pre-fix file must never outlive the run.
    fs.writeFileSync(DEFAULTS_FILE, fixedDefaults)
  }
})
