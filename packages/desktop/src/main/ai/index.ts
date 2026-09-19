import { BrowserWindow, dialog, ipcMain } from 'electron'
import log from 'electron-log'
import type {
  AIPrompt,
  AICompletionRequest,
  AICompletionResult,
  AIConnectionTestResult,
  AICredentialStatus,
  AIProviderId,
  AIProviderSettings,
  AIShellKeyCandidate,
  AIShellKeyImportResult
} from '../../shared/types/ai'
import { DEFAULT_BASE_URLS } from '../../shared/types/ai'
import { aiError } from './errors'
import {
  EncryptionUnavailableError,
  getApiKey,
  getCredentialStatus,
  isEncryptionAvailable,
  requiresApiKey,
  setApiKey
} from './keyStore'
import { completeWithAnthropic } from './providers/anthropic'
import { completeWithOpenAICompatible } from './providers/openaiCompatible'
import { resolveSystemPrompt } from './persona'
import { importShellKeys, scanShellProfiles } from './shellProfile'
import { showSourceCodeContextMenu } from '../contextMenu/editor'

// All provider traffic terminates here. The renderer is sandboxed and cannot
// open sockets, so it hands over settings plus a request id and gets back a
// normalized result — API keys never cross the bridge in either direction.

/**
 * In-flight requests, so `mt::ai::cancel` can abort one the user dismissed.
 * Keyed by the renderer-supplied request id.
 */
const inFlight = new Map<string, AbortController>()

/** Falls back to the provider default when the user left the field blank. */
const resolveBaseUrl = (settings: AIProviderSettings): string =>
  settings.baseUrl.trim() || DEFAULT_BASE_URLS[settings.provider]

const runCompletion = async(
  settings: AIProviderSettings,
  request: AICompletionRequest,
  signal: AbortSignal
): Promise<AICompletionResult> => {
  const apiKey = await getApiKey(settings.provider)

  if (!apiKey && requiresApiKey(settings.provider)) {
    return {
      ok: false,
      error: aiError(
        'missing-credentials',
        `No API key is saved for ${settings.provider}. Add one in Preferences → AI.`
      )
    }
  }

  // The persona is read here rather than in the renderer so the file is only
  // ever touched by the process that owns disk access, and so a broken persona
  // fails before any request is billed.
  const persona = await resolveSystemPrompt(request.personaPath)
  if (!persona.ok) return { ok: false, error: persona.error }

  const resolved: AIProviderSettings = { ...settings, baseUrl: resolveBaseUrl(settings) }

  if (resolved.provider === 'anthropic') {
    // Guarded by the `requiresApiKey` check above — anthropic always needs one.
    return completeWithAnthropic(
      resolved,
      request,
      apiKey as string,
      signal,
      persona.systemPrompt
    )
  }
  return completeWithOpenAICompatible(resolved, request, apiKey, signal, persona.systemPrompt)
}

/**
 * Runs a completion under a timeout, tracking the controller so the renderer
 * can cancel it. Always clears both the timer and the registry entry, so a
 * dismissed dialog cannot leak either.
 */
const completeWithTimeout = async(
  requestId: string,
  settings: AIProviderSettings,
  request: AICompletionRequest
): Promise<AICompletionResult> => {
  const controller = new AbortController()
  inFlight.set(requestId, controller)
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)

  try {
    return await runCompletion(settings, request, controller.signal)
  } finally {
    clearTimeout(timer)
    inFlight.delete(requestId)
  }
}

export const registerAiHandlers = (): void => {
  ipcMain.handle(
    'mt::ai::complete',
    async(
      _event,
      requestId: string,
      settings: AIProviderSettings,
      request: AICompletionRequest
    ): Promise<AICompletionResult> => {
      try {
        return await completeWithTimeout(requestId, settings, request)
      } catch (error) {
        // Providers already normalize their own failures; reaching here means
        // something unexpected broke, and the renderer still needs a result
        // object rather than a rejected invoke.
        log.error('[ai] Completion failed unexpectedly.', error)
        return { ok: false, error: aiError('unknown', (error as Error).message) }
      }
    }
  )

  ipcMain.on('mt::ai::cancel', (_event, requestId: string) => {
    inFlight.get(requestId)?.abort()
  })

  ipcMain.on(
    'mt::ai::source-context-menu',
    (
      event,
      position: { x: number; y: number },
      hasSelection: boolean,
      // The renderer owns the prompt library (same as it owns provider
      // settings for `mt::ai::complete`); main only builds the menu.
      ai: { enabled: boolean; prompts: AIPrompt[] | undefined }
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      // The renderer measures in CSS pixels; `popup` positions in window
      // coordinates, so the two only agree at 100% zoom.
      const zoom = win.webContents.getZoomFactor()
      showSourceCodeContextMenu(
        win,
        { x: Math.round(position.x * zoom), y: Math.round(position.y * zoom) },
        hasSelection,
        ai
      )
    }
  )

  ipcMain.handle(
    'mt::ai::test-connection',
    async(_event, settings: AIProviderSettings): Promise<AIConnectionTestResult> => {
      // A real round trip is the only way to prove the key, base URL, and model
      // name all work together; a reachability ping would pass with a bad model.
      const result = await completeWithTimeout(`test-${Date.now()}`, settings, {
        prompt: 'Reply with the single word: ok',
        selection: 'ok'
      })
      return result.ok ? { ok: true, model: result.model } : { ok: false, error: result.error }
    }
  )

  ipcMain.handle(
    'mt::ai::set-key',
    async(
      _event,
      provider: AIProviderId,
      key: string
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      try {
        await setApiKey(provider, key)
        return { ok: true }
      } catch (error) {
        if (error instanceof EncryptionUnavailableError) {
          return { ok: false, message: error.message }
        }
        log.error('[ai] Unable to save API key.', error)
        return { ok: false, message: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'mt::ai::credential-status',
    async(): Promise<AICredentialStatus> => getCredentialStatus()
  )

  ipcMain.handle(
    'mt::ai::scan-shell-profile',
    async(): Promise<AIShellKeyCandidate[]> => scanShellProfiles()
  )

  ipcMain.handle(
    'mt::ai::import-shell-keys',
    async(_event, variables: string[]): Promise<AIShellKeyImportResult[]> =>
      importShellKeys(variables)
  )

  ipcMain.handle('mt::ai::encryption-available', (): boolean => isEncryptionAvailable())

  ipcMain.handle('mt::ai::choose-persona-file', async(event): Promise<string> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return ''
    const { filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a persona file',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }]
    })
    return filePaths?.[0] ?? ''
  })
}
