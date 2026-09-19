import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import log from 'electron-log'
import type {
  AIProviderId,
  AIShellKeyCandidate,
  AIShellKeyImportResult
} from '../../shared/types/ai'
import { AI_PROVIDER_IDS, PROVIDER_ENV_VARS } from '../../shared/types/ai'
import { EncryptionUnavailableError, getApiKey, setApiKey } from './keyStore'

// Importing provider keys out of the user's shell profile.
//
// `process.env` is not a substitute: an app launched from Finder or the Dock
// inherits launchd's environment rather than an interactive shell's, so the
// variables are absent in exactly the case this feature exists for.
//
// The files are parsed, never executed. Sourcing a real rc file would run
// arbitrary code — plugin managers, `eval`, curl pipelines — with the app's
// privileges, to obtain a handful of string assignments.

/** Profiles to scan, in the order shells would read them. */
const PROFILE_FILES = ['.zshenv', '.zshrc', '.bashrc', '.bash_profile', '.profile'] as const

/**
 * Matches an assignment this parser understands:
 *
 *   export NAME=value
 *   export NAME="value"
 *       export NAME='value'
 *
 * Anchored at the line start (after whitespace) so a `#` comment or an
 * assignment buried inside a function body or conditional is not picked up.
 * `declare -x` and `setenv` are deliberately unhandled: rare enough that
 * guessing wrong is worse than the user pasting the key.
 */
const EXPORT_LINE = /^[ \t]*export[ \t]+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * Strips one layer of matching surrounding quotes and nothing else.
 *
 * An API key is opaque, so the remainder is taken verbatim — including a `#`
 * and anything after it. Treating that as a trailing comment would silently
 * truncate any key containing one, and a truncated key fails as an
 * authentication error the user cannot explain.
 */
const unquote = (raw: string): string => {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * Exported assignments in one profile's text, last occurrence winning — the
 * same precedence a shell applies when a file assigns a name twice.
 *
 * Pure and exported so the parsing rules are testable without a home directory.
 */
export const parseExportedKeys = (text: string): Map<string, string> => {
  const found = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = EXPORT_LINE.exec(line)
    if (!match) continue
    const [, name, rawValue] = match
    const value = unquote(rawValue)
    if (value) found.set(name, value)
    else found.delete(name)
  }
  return found
}

/** Which provider a variable name belongs to, or null if it is not a key we use. */
const providerForVariable = (variable: string): AIProviderId | null =>
  AI_PROVIDER_IDS.find((provider) => PROVIDER_ENV_VARS[provider].includes(variable)) ?? null

/**
 * Display form of a secret: enough to recognise which key it is, not enough to
 * use. Short values are hidden outright rather than half-revealed.
 */
export const maskSecret = (value: string): string =>
  value.length <= 12 ? '•'.repeat(Math.max(value.length, 4)) : `${value.slice(0, 4)}…${value.slice(-4)}`

/**
 * Reads the profiles and returns what could be imported, without any secret.
 *
 * A file read failure is skipped rather than surfaced: a missing .bashrc on a
 * zsh machine is the normal case, not an error worth a dialog.
 */
const collectFromProfiles = async(): Promise<Map<string, { value: string; file: string }>> => {
  const home = os.homedir()
  const collected = new Map<string, { value: string; file: string }>()

  for (const name of PROFILE_FILES) {
    const file = path.join(home, name)
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const [variable, value] of parseExportedKeys(text)) {
      // Later files win, matching the read order above.
      collected.set(variable, { value, file })
    }
  }

  return collected
}

/** Candidates for the import dialog. Carries masked values only. */
export const scanShellProfiles = async(): Promise<AIShellKeyCandidate[]> => {
  const collected = await collectFromProfiles()
  const candidates: AIShellKeyCandidate[] = []

  for (const [variable, { value, file }] of collected) {
    const provider = providerForVariable(variable)
    if (!provider) continue
    candidates.push({
      provider,
      variable,
      masked: maskSecret(value),
      file,
      alreadySet: Boolean(await getApiKey(provider))
    })
  }

  // Stable order so the dialog does not reshuffle between opens.
  return candidates.sort((a, b) => a.variable.localeCompare(b.variable))
}

/**
 * Imports the named variables, re-reading the profiles so no secret had to be
 * held anywhere outside this process.
 *
 * Each key is reported separately: an unavailable OS keychain fails every write
 * for the same reason, but a partial success still tells the user which keys
 * landed rather than collapsing to one error.
 */
export const importShellKeys = async(variables: string[]): Promise<AIShellKeyImportResult[]> => {
  const collected = await collectFromProfiles()
  const results: AIShellKeyImportResult[] = []

  for (const variable of variables) {
    const provider = providerForVariable(variable)
    const entry = collected.get(variable)

    if (!provider || !entry) {
      // The profile changed between scan and confirm, or the renderer sent a
      // name that is not a provider key.
      results.push({
        variable,
        provider: provider ?? 'anthropic',
        ok: false,
        message: `${variable} is no longer exported in your shell profile.`
      })
      continue
    }

    try {
      await setApiKey(provider, entry.value)
      results.push({ variable, provider, ok: true })
    } catch (error) {
      // Never log the value — only which variable failed.
      log.error(`[ai] Importing ${variable} failed.`, error)
      results.push({
        variable,
        provider,
        ok: false,
        message:
          error instanceof EncryptionUnavailableError
            ? error.message
            : 'The key could not be saved.'
      })
    }
  }

  return results
}
