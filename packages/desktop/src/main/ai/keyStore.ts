import fs from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import log from 'electron-log'
import type { AICredentialStatus, AIProviderId } from '../../shared/types/ai'
import { AI_PROVIDER_IDS, PROVIDERS_REQUIRING_KEY } from '../../shared/types/ai'

// API keys are deliberately kept out of preferences.json: users paste that file
// into bug reports, sync it between machines, and back it up. Ciphertext lives
// in its own file, encrypted by the OS keychain (Keychain / DPAPI / libsecret)
// via Electron's safeStorage.
//
// safeStorage is unavailable on Linux boxes with no keyring daemon. Rather than
// silently downgrade to plaintext — which would defeat the point and surprise a
// user who chose encrypted storage — writes fail loudly there and the settings
// pane surfaces the reason.

const CREDENTIALS_FILENAME = 'ai-credentials.json'

/** Base64 ciphertext per provider. Absent key means "no credential stored". */
type CredentialFile = Partial<Record<AIProviderId, string>>

const credentialsPath = (): string => path.join(app.getPath('userData'), CREDENTIALS_FILENAME)

export class EncryptionUnavailableError extends Error {
  constructor() {
    super(
      'OS-level encryption is unavailable, so the API key was not saved. On Linux this usually means no keyring service (gnome-keyring or kwallet) is running.'
    )
    this.name = 'EncryptionUnavailableError'
  }
}

const readFileOrEmpty = async(): Promise<CredentialFile> => {
  try {
    const raw = await fs.readFile(credentialsPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as CredentialFile
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // A corrupt store must not wedge the feature — the user can re-enter the
      // key, and overwriting is safe because the file holds nothing else.
      log.error('[ai] Unable to read credential store; treating it as empty.', error)
    }
    return {}
  }
}

const writeFile = async(contents: CredentialFile): Promise<void> => {
  // 0o600: the ciphertext is useless without the OS keychain, but there is no
  // reason for other local accounts to read it.
  await fs.writeFile(credentialsPath(), JSON.stringify(contents, null, 2), { mode: 0o600 })
}

export const isEncryptionAvailable = (): boolean => safeStorage.isEncryptionAvailable()

/**
 * Stores `key` for `provider`. An empty or whitespace-only key clears the entry
 * instead, which is how the settings pane removes a credential.
 */
export const setApiKey = async(provider: AIProviderId, key: string): Promise<void> => {
  const trimmed = key.trim()
  const store = await readFileOrEmpty()

  if (!trimmed) {
    delete store[provider]
    await writeFile(store)
    return
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError()
  }

  store[provider] = safeStorage.encryptString(trimmed).toString('base64')
  await writeFile(store)
}

/**
 * Returns the decrypted key, or null when none is stored or decryption fails.
 *
 * Decryption fails legitimately when the store was written on another machine
 * or after the OS keychain was reset; a null return sends the caller down the
 * same "ask the user for a key" path as a missing entry.
 */
export const getApiKey = async(provider: AIProviderId): Promise<string | null> => {
  const store = await readFileOrEmpty()
  const encrypted = store[provider]
  if (!encrypted) return null

  if (!safeStorage.isEncryptionAvailable()) {
    log.warn(`[ai] Cannot decrypt the ${provider} key: OS encryption is unavailable.`)
    return null
  }

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch (error) {
    log.error(`[ai] Stored ${provider} key could not be decrypted.`, error)
    return null
  }
}

/**
 * Which providers have a key on file. Used to render the settings pane.
 *
 * Derived from `AI_PROVIDER_IDS` rather than listed literally: a hardcoded
 * object silently reports `false` for every provider added after it was
 * written, which reads in the UI as "no key saved" for a key that is in fact
 * stored.
 */
export const getCredentialStatus = async(): Promise<AICredentialStatus> => {
  const store = await readFileOrEmpty()
  return Object.fromEntries(
    AI_PROVIDER_IDS.map((provider) => [provider, Boolean(store[provider])])
  ) as AICredentialStatus
}

/** Whether `provider` needs a key at all — LM Studio serves unauthenticated. */
export const requiresApiKey = (provider: AIProviderId): boolean =>
  PROVIDERS_REQUIRING_KEY.includes(provider)
