import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { AI_PROVIDER_IDS, PROVIDERS_REQUIRING_KEY } from '@shared/types/ai'

// keyStore had no spec at all, which is how `getCredentialStatus` came to list
// four provider keys literally: adding a provider left it reporting "no key
// saved" for a key that was in fact stored, and nothing failed. These specs pin
// the derivation so the next provider cannot reintroduce that.
//
// safeStorage only exists inside Electron, so encryption is stubbed here. The
// store's file layout is real: the point is the mapping from what is on disk to
// what the settings pane is told, not the crypto.

let tempDir: string
/** Stands in for the OS keychain; reversible so the round trip is observable. */
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => tempDir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buffer: Buffer) => buffer.toString().replace(/^enc:/, '')
  }
}))

vi.mock('electron-log', () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

const loadStore = async() => {
  vi.resetModules()
  return import('../../../src/main/ai/keyStore')
}

beforeEach(async() => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'marktext-keystore-'))
  encryptionAvailable = true
})

afterEach(async() => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('getCredentialStatus', () => {
  it('reports a key for every provider id, not a hardcoded subset', async() => {
    const { getCredentialStatus } = await loadStore()
    const status = await getCredentialStatus()

    // The regression this replaces: a provider absent from the returned object
    // reads in the settings pane as "no key saved", indistinguishable from a
    // provider whose key really is missing.
    expect(Object.keys(status).sort()).toEqual([...AI_PROVIDER_IDS].sort())
    for (const provider of AI_PROVIDER_IDS) {
      expect(status[provider], provider).toBe(false)
    }
  })

  it('flips to true only for the provider whose key was stored', async() => {
    const { setApiKey, getCredentialStatus } = await loadStore()
    await setApiKey('groq', 'gsk-secret')

    const status = await getCredentialStatus()
    expect(status.groq).toBe(true)
    for (const provider of AI_PROVIDER_IDS) {
      if (provider === 'groq') continue
      expect(status[provider], provider).toBe(false)
    }
  })

  it('reports false again once a key is cleared', async() => {
    const { setApiKey, getCredentialStatus } = await loadStore()
    await setApiKey('cerebras', 'csk-1')
    expect((await getCredentialStatus()).cerebras).toBe(true)

    // An empty key is how the settings pane removes a credential.
    await setApiKey('cerebras', '   ')
    expect((await getCredentialStatus()).cerebras).toBe(false)
  })
})

describe('setApiKey / getApiKey', () => {
  it('round-trips a key through the keychain stub', async() => {
    const { setApiKey, getApiKey } = await loadStore()
    await setApiKey('deepseek', 'sk-deepseek-1')
    expect(await getApiKey('deepseek')).toBe('sk-deepseek-1')
  })

  it('trims surrounding whitespace, so a pasted key with a newline still works', async() => {
    const { setApiKey, getApiKey } = await loadStore()
    await setApiKey('mistral', '  sk-mistral-1\n')
    expect(await getApiKey('mistral')).toBe('sk-mistral-1')
  })

  it('returns null for a provider with nothing stored', async() => {
    const { getApiKey } = await loadStore()
    expect(await getApiKey('openai')).toBeNull()
  })

  it('refuses to store a key when the OS keychain is unavailable', async() => {
    // Storing plaintext instead would be worse than failing: the user would
    // believe the key is protected when it is not.
    const { setApiKey, EncryptionUnavailableError } = await loadStore()
    encryptionAvailable = false
    await expect(setApiKey('openai', 'sk-plaintext')).rejects.toBeInstanceOf(
      EncryptionUnavailableError
    )
  })

  it('still clears a key when the keychain is unavailable', async() => {
    // Removal needs no encryption, and a user locked out of the keychain must
    // not also be locked out of deleting a stale key.
    const { setApiKey, getApiKey } = await loadStore()
    await setApiKey('openai', 'sk-1')
    encryptionAvailable = false
    await expect(setApiKey('openai', '')).resolves.toBeUndefined()
    encryptionAvailable = true
    expect(await getApiKey('openai')).toBeNull()
  })

  it('returns null rather than throwing when a stored key cannot be decrypted', async() => {
    // Legitimate when the store was copied from another machine or the keychain
    // was reset; the caller should fall through to "ask for a key".
    const { setApiKey, getApiKey } = await loadStore()
    await setApiKey('openai', 'sk-1')
    encryptionAvailable = false
    expect(await getApiKey('openai')).toBeNull()
  })
})

describe('requiresApiKey', () => {
  it('matches PROVIDERS_REQUIRING_KEY for every provider', async() => {
    const { requiresApiKey } = await loadStore()
    for (const provider of AI_PROVIDER_IDS) {
      expect(requiresApiKey(provider), provider).toBe(PROVIDERS_REQUIRING_KEY.includes(provider))
    }
  })

  it('exempts the two local providers', async() => {
    const { requiresApiKey } = await loadStore()
    expect(requiresApiKey('lmstudio')).toBe(false)
    expect(requiresApiKey('ollama')).toBe(false)
  })
})
