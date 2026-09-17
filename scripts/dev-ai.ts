/**
 * Launches MarkText for manual AI testing: an isolated profile, a scratch
 * document already open, AI switched on, and the API key already in the
 * keychain.
 *
 * The point is that none of this touches your real MarkText profile — the
 * whole thing lives in `.dev-profile/` and `--reset` throws it away.
 *
 *   pnpm run dev:ai                  # launch (seeds on first run)
 *   pnpm run dev:ai -- --reset       # start from a clean profile
 *   pnpm run dev:ai -- --provider anthropic
 *
 * The API key is read from `.dev-profile/api-key` (gitignored) or `$MT_AI_KEY`,
 * never from a command-line flag — argv lands in your shell history and in the
 * process list.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = path.join(repoRoot, 'packages', 'desktop')
const profileDir = path.join(repoRoot, '.dev-profile')
const playgroundPath = path.join(profileDir, 'playground.md')
const keyFilePath = path.join(profileDir, 'api-key')
const credentialsPath = path.join(profileDir, 'ai-credentials.json')
const preferencesPath = path.join(profileDir, 'preferences.json')

type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'lmstudio'

/** Providers that authenticate with no credential, so the key step is skipped. */
const KEYLESS: ProviderId[] = ['lmstudio']

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const reset = argv.includes('--reset')
const provider = (flag('provider') ?? 'anthropic') as ProviderId
const model = flag('model')

// Content chosen to exercise every AI entry point in one file: prose worth
// rewriting, a span comment and a note that are already anchored (both stay
// `pending` on load — a first scan never spends requests), and a
// document-scope marker.
const PLAYGROUND = `# AI playground

Select any of this text and try a prompt, or right-click for the AI submenu.
Everything below is scratch — edit it freely, it persists between runs.

## Rewrite me

hey so i wanted to check in about the thing we talked about last week, lmk if
you got a sec to chat about it sometime, no rush obviously but would be good

## Already carries comments

<!--ai: make this one sentence-->The quarterly report is attached. It covers
the period from January through March. It includes the revenue breakdown.<!--/ai-->

<!--note: check these numbers against finance's copy-->Revenue grew 12% year
over year.<!--/note-->

## Try in source mode

Toggle source-code mode (View menu, or the shortcut) and repeat the above —
prompts, comments and the timeline all work there too.

<!--ai/: does this document have a consistent voice throughout?-->
`

const log = (message: string): void => process.stdout.write(`${message}\n`)

if (reset && fs.existsSync(profileDir)) {
  fs.rmSync(profileDir, { recursive: true, force: true })
  log('· removed .dev-profile')
}
fs.mkdirSync(profileDir, { recursive: true })

if (!fs.existsSync(playgroundPath)) {
  fs.writeFileSync(playgroundPath, PLAYGROUND)
  log(`· created ${path.relative(repoRoot, playgroundPath)}`)
}

// ---------------------------------------------------------------------------
// Preferences
//
// electron-store validates against schema.json and stamps a migration version.
// A file written without that stamp reads as version 0.0.0 and the app refuses
// to start, so seed it explicitly; on later runs merge rather than overwrite so
// anything toggled in Settings survives.

const appVersion = JSON.parse(
  fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8')
).version as string

const aiPreferences: Record<string, unknown> = {
  aiEnabled: true,
  aiProvider: provider,
  ...(model ? { aiModel: model } : {})
}

const existing = fs.existsSync(preferencesPath)
  ? (JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) as Record<string, unknown>)
  : { __internal__: { migrations: { version: appVersion } } }

fs.writeFileSync(preferencesPath, JSON.stringify({ ...existing, ...aiPreferences }, null, 2))
log(`· preferences: aiEnabled, provider=${provider}${model ? `, model=${model}` : ''}`)

// ---------------------------------------------------------------------------
// API key
//
// safeStorage encrypts against the OS keychain and only exists inside Electron,
// so the key cannot be seeded from plain Node. Run the real Electron binary
// once against this profile to write the ciphertext, exactly as the settings
// pane would.

const electronBinary = (): string => {
  if (process.platform === 'win32') return path.join(desktopDir, 'node_modules/.bin/electron.cmd')
  const pathTxt = path.join(repoRoot, 'node_modules/electron/path.txt')
  const relative = fs.readFileSync(pathTxt, 'utf8').trim()
  return path.join(repoRoot, 'node_modules/electron/dist', relative)
}

const readKey = (): string | undefined => {
  const fromEnv = process.env.MT_AI_KEY?.trim()
  if (fromEnv) return fromEnv
  if (fs.existsSync(keyFilePath)) {
    const fromFile = fs.readFileSync(keyFilePath, 'utf8').trim()
    if (fromFile) return fromFile
  }
  return undefined
}

const seedApiKey = (key: string): void => {
  const seederPath = path.join(profileDir, '.seed-key.cjs')
  // Runs as its own tiny Electron app pointed at the same userData dir, so the
  // ciphertext is bound to the same keychain entry the dev app will read.
  fs.writeFileSync(
    seederPath,
    `const { app, safeStorage } = require('electron')
const fs = require('node:fs')
app.setPath('userData', ${JSON.stringify(profileDir)})
app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    process.stderr.write('SEED_FAIL: OS encryption unavailable\\n')
    app.exit(1)
    return
  }
  const store = fs.existsSync(${JSON.stringify(credentialsPath)})
    ? JSON.parse(fs.readFileSync(${JSON.stringify(credentialsPath)}, 'utf8'))
    : {}
  store[${JSON.stringify(provider)}] = safeStorage
    .encryptString(process.env.MT_SEED_KEY)
    .toString('base64')
  fs.writeFileSync(${JSON.stringify(credentialsPath)}, JSON.stringify(store, null, 2), { mode: 0o600 })
  process.stdout.write('SEED_OK\\n')
  app.exit(0)
})
`
  )

  const result = spawnSync(electronBinary(), [seederPath], {
    env: { ...process.env, MT_SEED_KEY: key },
    encoding: 'utf8'
  })
  fs.rmSync(seederPath, { force: true })

  if (result.stdout?.includes('SEED_OK')) {
    log(`· API key encrypted into the keychain for ${provider}`)
    return
  }
  log(`! could not seed the API key: ${result.stderr?.trim() || 'unknown error'}`)
  log('  Enter it in Settings → AI instead; it persists in this profile.')
}

if (KEYLESS.includes(provider)) {
  log(`· ${provider} needs no API key`)
} else {
  const key = readKey()
  if (key) {
    seedApiKey(key)
  } else if (fs.existsSync(credentialsPath)) {
    log('· reusing the API key already stored in this profile')
  } else {
    log(`! no API key found — put one in ${path.relative(repoRoot, keyFilePath)} or set $MT_AI_KEY`)
    log('  (or enter it once in Settings → AI; it persists in this profile)')
  }
}

// ---------------------------------------------------------------------------

log('')
log(`Launching with profile ${path.relative(repoRoot, profileDir)} …`)

const child = spawn(
  'pnpm',
  ['--filter', 'marktext', 'dev', '--', `--user-data-dir=${profileDir}`, playgroundPath],
  { cwd: repoRoot, stdio: 'inherit' }
)
child.on('exit', (code) => process.exit(code ?? 0))
