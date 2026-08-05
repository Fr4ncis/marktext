import bus from '../bus'
import notice from '@/services/notification'
import { delay } from '@/util'
import { usePreferencesStore } from '@/store/preferences'
import { usablePrompts } from '@/services/aiAssistant'

// Keyboard-driven counterpart to the editor context menu's AI submenu. Both
// end at the same `ai::run-prompt` bus event, so the selection handling and the
// preview dialog have exactly one implementation.

interface AiSubcommand {
  id: string
  description: string
  value: string
}

/** Sentinel prompt id meaning "ask the user for a one-off instruction". */
const CUSTOM_PROMPT_ID = ''

class AiActionCommand {
  id: string
  description: string
  placeholder: string
  shortcut: string | null
  subcommands: AiSubcommand[]
  subcommandSelectedIndex: number

  constructor() {
    this.id = 'ai.run-prompt'
    this.description = 'AI: rewrite selection'
    this.placeholder = 'Select an AI action'
    this.shortcut = null
    this.subcommands = []
    this.subcommandSelectedIndex = -1
  }

  // The prompt library is user-editable, so the subcommand list is rebuilt on
  // every invocation rather than cached at construction.
  run = async(): Promise<void> => {
    const preferences = usePreferencesStore()
    this.subcommands = usablePrompts(preferences).map((prompt) => ({
      id: `ai.run-prompt-${prompt.id}`,
      description: prompt.label,
      value: prompt.id
    }))
    this.subcommands.push({
      id: 'ai.run-prompt-custom',
      description: 'Custom prompt…',
      value: CUSTOM_PROMPT_ID
    })
    this.subcommandSelectedIndex = -1
  }

  execute = async(): Promise<void> => {
    const preferences = usePreferencesStore()
    if (!preferences.aiEnabled) {
      notice.notify({
        title: 'AI assistant',
        type: 'warning',
        message: 'The AI assistant is turned off. Enable it in Preferences → AI.'
      })
      return
    }
    // Matches the spellchecker command: let the palette close before reopening
    // it on the subcommand list.
    await delay(100)
    bus.emit('show-command-palette', this)
  }

  executeSubcommand = async(id: string): Promise<void> => {
    const command = this.subcommands.find((cmd) => cmd.id === id)
    if (!command) return
    bus.emit('ai::run-prompt', command.value)
  }

  unload = (): void => {
    this.subcommands = []
  }
}

export default AiActionCommand
