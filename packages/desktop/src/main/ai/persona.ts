import fs from 'node:fs/promises'
import path from 'node:path'
import type { AIErrorPayload } from '../../shared/types/ai'
import { assembleSystemPrompt } from '../../shared/types/ai'
import { aiError } from './errors'

// Persona text lives in a Markdown file the user owns, read at send time so
// editing it takes effect on the very next request with no reload.

/**
 * Guards against a persona file that is not what the user meant to point at —
 * a video, a database dump. Well beyond any real style guide.
 */
export const MAX_PERSONA_BYTES = 512 * 1024

export type PersonaResolution =
  | { ok: true; systemPrompt: string }
  | { ok: false; error: AIErrorPayload }

/**
 * Reads a persona file and assembles the system prompt.
 *
 * A missing or unreadable persona is reported rather than quietly skipped: the
 * user configured a voice, and silently sending the request without it would
 * return text in the wrong register with no indication why.
 */
export const resolveSystemPrompt = async(personaPath?: string): Promise<PersonaResolution> => {
  if (!personaPath) return { ok: true, systemPrompt: assembleSystemPrompt(null) }

  let stats: Awaited<ReturnType<typeof fs.stat>>
  try {
    stats = await fs.stat(personaPath)
  } catch {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        `Persona file not found: ${personaPath}. Update it in Preferences → AI, or clear the persona.`
      )
    }
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      error: aiError('invalid-request', `Persona path is not a file: ${personaPath}`)
    }
  }

  if (stats.size > MAX_PERSONA_BYTES) {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        `Persona file is ${Math.round(stats.size / 1024)} kB, above the ${
          MAX_PERSONA_BYTES / 1024
        } kB limit. Check that ${path.basename(personaPath)} is the file you meant.`
      )
    }
  }

  try {
    const text = await fs.readFile(personaPath, 'utf8')
    return { ok: true, systemPrompt: assembleSystemPrompt(text) }
  } catch (error) {
    return {
      ok: false,
      error: aiError(
        'invalid-request',
        `Persona file could not be read: ${(error as Error).message}`
      )
    }
  }
}
