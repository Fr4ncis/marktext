import { beforeEach, describe, expect, it, vi } from 'vitest'

// AiActionCommand is the keyboard-driven counterpart to the editor context
// menu's AI submenu. It has no rendering — it builds a subcommand list from the
// user's usable prompts, guards on `aiEnabled`, and funnels every selection to
// the single `ai::run-prompt` bus event. This file pins that orchestration: the
// four boundaries it reaches across (the bus, the notification service, the
// `delay` helper, and `usablePrompts`) are mocked, and the preferences store is
// a controllable stub, so the command is driven exactly as the palette drives
// it. The prompt library and the reconcile logic stay under aiAssistant's own
// tests; here we only assert how the command wires them together.

// vi.mock factories are hoisted above top-level declarations, so the spies they
// reference must be created with vi.hoisted (which runs first) rather than a
// plain const.
const { emit, notify, usablePrompts } = vi.hoisted(() => ({
  emit: vi.fn(),
  notify: vi.fn(),
  usablePrompts: vi.fn()
}))

// aiActions.ts imports the bus as `../bus`, which resolves to `@/bus`
// (@ = src/renderer/src); mock it by the resolved alias so vitest intercepts it.
vi.mock('@/bus', () => ({ default: { emit } }))
vi.mock('@/services/notification', () => ({ default: { notify } }))
// delay() would otherwise sleep 100ms between closing and reopening the palette.
vi.mock('@/util', () => ({ delay: vi.fn(() => Promise.resolve()) }))
// The reconcile/enabled filtering lives in aiAssistant's own tests; here we hand
// back a fixed usable list so the subcommand assembly is what's under test.
vi.mock('@/services/aiAssistant', () => ({ usablePrompts }))

let usable: Array<{ id: string; label: string }>
let aiEnabled: boolean
vi.mock('@/store/preferences', () => ({
  usePreferencesStore: () => ({ aiEnabled })
}))

// Import after the mocks are registered.
import AiActionCommand from '@/commands/aiActions'

describe('AiActionCommand', () => {
  let command: AiActionCommand

  beforeEach(() => {
    emit.mockClear()
    notify.mockClear()
    usablePrompts.mockReset()
    usablePrompts.mockImplementation(() => usable)
    usable = [
      { id: 'rewrite', label: 'Rewrite' },
      { id: 'summarize', label: 'Summarize' }
    ]
    aiEnabled = true
    command = new AiActionCommand()
  })

  it('rebuilds the subcommand list from usable prompts and appends the custom sentinel', async() => {
    await command.run()

    // One entry per usable prompt, plus the trailing "Custom prompt…" entry.
    expect(command.subcommands).toHaveLength(3)
    expect(command.subcommands.slice(0, 2)).toEqual([
      { id: 'ai.run-prompt-rewrite', description: 'Rewrite', value: 'rewrite' },
      { id: 'ai.run-prompt-summarize', description: 'Summarize', value: 'summarize' }
    ])
    const custom = command.subcommands[2]
    expect(custom.id).toBe('ai.run-prompt-custom')
    // The empty-string sentinel value is what tells the handler to prompt for a
    // one-off instruction rather than run a stored prompt.
    expect(custom.value).toBe('')
    expect(command.subcommandSelectedIndex).toBe(-1)
  })

  it('reflects a changed prompt library on each run rather than caching', async() => {
    await command.run()
    expect(command.subcommands).toHaveLength(3)

    usable = [{ id: 'translate', label: 'Translate' }]
    await command.run()

    expect(command.subcommands).toHaveLength(2)
    expect(command.subcommands[0].value).toBe('translate')
  })

  it('opens the command palette when the assistant is enabled', async() => {
    await command.execute()

    expect(notify).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('show-command-palette', command)
  })

  it('notifies and does not open the palette when the assistant is disabled', async() => {
    aiEnabled = false

    await command.execute()

    expect(emit).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    const opts = notify.mock.calls[0][0]
    expect(opts.type).toBe('warning')
    expect(opts.message).toMatch(/turned off/i)
  })

  it('emits ai::run-prompt with the selected prompt value', async() => {
    await command.run()

    await command.executeSubcommand('ai.run-prompt-summarize')
    expect(emit).toHaveBeenCalledWith('ai::run-prompt', 'summarize')

    emit.mockClear()
    // The custom sentinel forwards the empty-string value verbatim.
    await command.executeSubcommand('ai.run-prompt-custom')
    expect(emit).toHaveBeenCalledWith('ai::run-prompt', '')
  })

  it('ignores an unknown subcommand id instead of emitting a stale selection', async() => {
    await command.run()

    await command.executeSubcommand('ai.run-prompt-does-not-exist')
    expect(emit).not.toHaveBeenCalled()
  })

  it('clears the subcommand list on unload', async() => {
    await command.run()
    expect(command.subcommands.length).toBeGreaterThan(0)

    command.unload()
    expect(command.subcommands).toEqual([])
  })
})
