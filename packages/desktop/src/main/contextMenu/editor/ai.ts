import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import type { AIPrompt } from '../../../shared/types/ai'
import { reconcilePrompts } from '../../../shared/types/ai'

// The AI submenu carries prompt *ids* only. The renderer owns the selection and
// the prompt bodies, so main never needs the document text to build this.

/** Sentinel id meaning "ask the user for a one-off instruction". */
const CUSTOM_PROMPT_ID = ''

const runPromptItem = (label: string, promptId: string): MenuItemConstructorOptions => ({
  label,
  click(_menuItem, targetWindow) {
    if (targetWindow) {
      ;(targetWindow as BrowserWindow).webContents.send('mt::ai::run-prompt', promptId)
    }
  }
})

/**
 * Builds the AI submenu from the stored prompt library.
 *
 * Returns null when the feature is off or every prompt has been disabled —
 * an empty submenu is worse than no submenu.
 */
export const buildAiSubmenu = (
  aiEnabled: boolean,
  storedPrompts: AIPrompt[] | undefined,
  hasSelection: boolean
): MenuItemConstructorOptions | null => {
  if (!aiEnabled) return null

  const prompts = reconcilePrompts(storedPrompts).filter((prompt) => prompt.enabled)
  if (prompts.length === 0) return null

  const submenu: MenuItemConstructorOptions[] = prompts.map((prompt) =>
    runPromptItem(prompt.label, prompt.id)
  )
  submenu.push({ type: 'separator' })
  submenu.push(runPromptItem('Custom prompt…', CUSTOM_PROMPT_ID))

  return {
    label: 'AI',
    // Every action rewrites a selection, so the whole submenu is inert without
    // one. Disabling the parent explains that better than silent no-ops.
    enabled: hasSelection,
    submenu
  }
}
