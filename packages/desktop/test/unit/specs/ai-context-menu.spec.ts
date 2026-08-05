import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { AIPrompt } from '@shared/types/ai'
import { BUILTIN_PROMPTS } from '@shared/types/ai'
import { buildAiSubmenu } from '../../../src/main/contextMenu/editor/ai'

const submenuLabels = (item: MenuItemConstructorOptions | null): string[] =>
  ((item?.submenu as MenuItemConstructorOptions[]) ?? [])
    .filter((entry) => entry.type !== 'separator')
    .map((entry) => String(entry.label))

describe('buildAiSubmenu', () => {
  it('returns null when the feature is off', () => {
    // The submenu must not appear at all until the user opts in.
    expect(buildAiSubmenu(false, undefined, true)).toBeNull()
  })

  it('lists the built-in prompts plus a custom entry when enabled', () => {
    const labels = submenuLabels(buildAiSubmenu(true, undefined, true))
    expect(labels).toEqual([...BUILTIN_PROMPTS.map((p) => p.label), 'Custom prompt…'])
  })

  it('omits prompts the user disabled', () => {
    const stored: AIPrompt[] = BUILTIN_PROMPTS.map((prompt) => ({
      ...prompt,
      enabled: prompt.id === 'concise'
    }))
    expect(submenuLabels(buildAiSubmenu(true, stored, true))).toEqual([
      'Make concise',
      'Custom prompt…'
    ])
  })

  it('returns null when every prompt is disabled', () => {
    // An "AI" menu containing only a separator would be worse than no menu.
    const stored: AIPrompt[] = BUILTIN_PROMPTS.map((prompt) => ({ ...prompt, enabled: false }))
    expect(buildAiSubmenu(true, stored, true)).toBeNull()
  })

  it('disables the submenu without a selection', () => {
    // Every action rewrites selected text, so the menu is inert without one.
    expect(buildAiSubmenu(true, undefined, false)?.enabled).toBe(false)
    expect(buildAiSubmenu(true, undefined, true)?.enabled).toBe(true)
  })

  it('gives the custom entry an empty prompt id', () => {
    const entries = (buildAiSubmenu(true, undefined, true)
      ?.submenu ?? []) as MenuItemConstructorOptions[]
    const custom = entries[entries.length - 1]
    expect(custom.label).toBe('Custom prompt…')

    // The click handler is the only place the id travels, so assert it by
    // capturing what gets sent to the renderer.
    const sent: unknown[] = []
    const fakeWindow = {
      webContents: {
        send: (...args: unknown[]) => {
          sent.push(args)
        }
      }
    }
    custom.click?.(
      {} as never,
      fakeWindow as never,
      {} as never
    )
    expect(sent).toEqual([['mt::ai::run-prompt', '']])
  })

  it('sends the prompt id for a named action', () => {
    const entries = (buildAiSubmenu(true, undefined, true)
      ?.submenu ?? []) as MenuItemConstructorOptions[]
    const sent: unknown[] = []
    const fakeWindow = { webContents: { send: (...args: unknown[]) => sent.push(args) } }

    entries[0].click?.({} as never, fakeWindow as never, {} as never)
    expect(sent).toEqual([['mt::ai::run-prompt', BUILTIN_PROMPTS[0].id]])
  })
})
