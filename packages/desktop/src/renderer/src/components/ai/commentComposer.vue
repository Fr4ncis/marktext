<template>
  <div
    v-if="visible"
    ref="card"
    class="ai-comment-composer"
    :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    @keydown.esc.stop.prevent="cancel"
  >
    <header class="composer-head">
      <span
        v-if="scope === 'document'"
        class="whole-document"
      >Whole document</span>
      <span
        v-else
        class="quoted"
      >“{{ truncatedSelection }}”</span>
    </header>

    <el-input
      ref="input"
      v-model="draft"
      type="textarea"
      :rows="2"
      :placeholder="placeholder"
      resize="none"
      @keydown.enter.exact.prevent="submit"
      @keydown.enter.meta.prevent="suggest"
      @keydown.enter.ctrl.prevent="suggest"
    />

    <ul
      v-if="suggestions.length"
      class="suggestions"
    >
      <li
        v-for="option in suggestions"
        :key="option.id"
        class="suggestion-option"
        :class="[`is-${option.status}`]"
        :role="option.status === 'ready' ? 'button' : undefined"
        :tabindex="option.status === 'ready' ? 0 : undefined"
        :title="option.status === 'ready' ? 'Replace the selection with this' : undefined"
        @click="choose(option)"
        @keydown.enter.prevent="choose(option)"
      >
        <span class="option-label">{{ option.label }}</span>
        <span
          v-if="option.status === 'loading'"
          class="option-text option-pending"
        >Thinking…</span>
        <span
          v-else-if="option.status === 'ready'"
          class="option-text"
        >{{ option.text }}</span>
        <span
          v-else
          class="option-text option-failed"
        >{{ option.error }}</span>
      </li>
    </ul>

    <footer class="composer-actions">
      <el-radio-group
        v-model="kind"
        size="small"
      >
        <el-radio-button value="ai">
          Ask AI
        </el-radio-button>
        <el-radio-button value="note">
          Note
        </el-radio-button>
      </el-radio-group>
      <span class="spacer" />
      <el-button
        text
        size="small"
        @click="cancel"
      >
        Cancel
      </el-button>
      <el-button
        v-if="canSuggest"
        size="small"
        :disabled="!draft.trim() || suggesting"
        :title="suggestButtonTitle"
        @click="suggest"
      >
        {{ suggestions.length ? 'Try again' : 'Suggest' }}
      </el-button>
      <el-button
        type="primary"
        size="small"
        :disabled="!draft.trim()"
        @click="submit"
      >
        Comment
      </el-button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AIProviderId, SuggestionStyleId } from '@shared/types/ai'
import { SUGGESTION_STYLES, buildSuggestionTemplate } from '@shared/types/ai'
import type { AiCommentKind, AiCommentScope } from '@shared/types/aiComments'
import bus from '../../bus'
import { usePreferencesStore } from '@/store/preferences'
import {
  describeError,
  resolvePersonaPath,
  runCompletion,
  settingsFromPreferences
} from '@/services/aiAssistant'

// The Word-style composer: select text, get a card next to it, type an
// instruction or a note. The editor owns the selection and performs the
// document edit; this component only collects what the user typed.
//
// For an instruction on a span there is also a faster path than a comment:
// Suggest rewrites the selection three ways right here in the card, and picking
// one replaces the selection at once — no marker, no trip to the sidebar.

/** Payload the editor sends when the user asks to comment on a selection. */
interface ComposerRequest {
  /** `document` when there was no selection — an unpaired, file-wide comment. */
  scope: AiCommentScope
  selection: string
  /** Viewport rect of the selection, used to place the card beside it. */
  rect: { top: number; bottom: number; left: number; right: number }
  /** Right edge of the text column, so the card can clear the prose. */
  columnRight: number
}

/** Gap between the selection and the card, in pixels. */
const OFFSET = 12
const CARD_WIDTH = 320
/** Rough card height, used only to keep it inside the viewport. */
const CARD_HEIGHT = 190

interface SuggestionOption {
  id: SuggestionStyleId
  label: string
  status: 'loading' | 'ready' | 'error'
  text: string
  error: string
}

const preferences = usePreferencesStore()

const visible = ref(false)
const draft = ref('')
const kind = ref<AiCommentKind>('ai')
const scope = ref<AiCommentScope>('span')
const selection = ref('')
const position = ref({ top: 0, left: 0 })
const card = ref<HTMLDivElement | null>(null)
const input = ref<{ focus: () => void } | null>(null)
const suggestions = ref<SuggestionOption[]>([])

/** Aborts every suggestion request still in flight. */
let cancelSuggestions: (() => void) | null = null
/** Bumped on every run, so a reply from a superseded run is dropped. */
let suggestionRun = 0

/** Suggestions rewrite a selection, so they need one, and a note never asks the model. */
const canSuggest = computed(() => scope.value === 'span' && kind.value === 'ai')
const suggestButtonTitle = computed(() =>
  suggestions.value.length
    ? 'Ask for three new options'
    : 'Rewrite the selection three ways and pick one (⌘/Ctrl+Enter)'
)
const suggesting = computed(() => suggestions.value.some((option) => option.status === 'loading'))

const placeholder = computed(() => {
  if (scope.value === 'document') {
    return kind.value === 'ai'
      ? 'Tell the AI what to change across the document…'
      : 'Leave a note about the document…'
  }
  return kind.value === 'ai' ? 'Tell the AI what to change…' : 'Leave yourself a note…'
})

const truncatedSelection = computed(() =>
  selection.value.length > 80 ? `${selection.value.slice(0, 80)}…` : selection.value
)

/**
 * Places the card level with the selection but clear of the text.
 *
 * Anchoring to the selection's own right edge puts the card on top of the
 * sentence being commented on, which is the one thing it must not cover. So it
 * prefers the empty margin beside the text column — the same place Word and
 * Docs put comments — and only falls back to hugging the selection when the
 * window is too narrow for that.
 */
const placeCard = (rect: ComposerRequest['rect'], columnRight: number): void => {
  const clampTop = (value: number): number =>
    Math.min(Math.max(OFFSET, value), Math.max(OFFSET, window.innerHeight - CARD_HEIGHT - OFFSET))

  // Best case: a true margin beside the text, like Word and Docs.
  const marginLeft = columnRight + OFFSET
  if (marginLeft + CARD_WIDTH + OFFSET <= window.innerWidth) {
    position.value = { top: clampTop(rect.top), left: marginLeft }
    return
  }

  // Otherwise drop below the selection rather than beside it. A narrow window
  // has no clear margin, and covering the sentence being commented on is worse
  // than covering the line after it.
  const left = Math.min(
    Math.max(OFFSET, rect.left),
    Math.max(OFFSET, window.innerWidth - CARD_WIDTH - OFFSET)
  )
  const below = rect.bottom + OFFSET
  // Flip above when the selection sits near the bottom of the window.
  const top =
    below + CARD_HEIGHT + OFFSET <= window.innerHeight
      ? below
      : Math.max(OFFSET, rect.top - CARD_HEIGHT - OFFSET)

  position.value = { top: clampTop(top), left }
}

const stopSuggestions = (): void => {
  cancelSuggestions?.()
  cancelSuggestions = null
  suggestionRun++
  suggestions.value = []
}

/** The options can grow the card past the bottom of the window; lift it back in. */
const keepCardInView = (): void => {
  nextTick(() => {
    const height = card.value?.getBoundingClientRect().height ?? CARD_HEIGHT
    const overflow = position.value.top + height + OFFSET - window.innerHeight
    if (overflow > 0) {
      position.value = { ...position.value, top: Math.max(OFFSET, position.value.top - overflow) }
    }
  })
}

const reset = (): void => {
  stopSuggestions()
  visible.value = false
  draft.value = ''
  kind.value = 'ai'
  scope.value = 'span'
  selection.value = ''
}

const cancel = (): void => {
  reset()
  // Return focus to the document so the user can keep typing immediately.
  bus.emit('editor-focus')
}

const submit = (): void => {
  const instruction = draft.value.trim()
  if (!instruction) return
  bus.emit('ai-comments::create', { kind: kind.value, instruction })
  reset()
}

const suggest = (): void => {
  const instruction = draft.value.trim()
  if (!instruction || !canSuggest.value) return
  stopSuggestions()
  const run = suggestionRun

  const settings = settingsFromPreferences(preferences)
  const personaPath = resolvePersonaPath(preferences, undefined)
  suggestions.value = SUGGESTION_STYLES.map((style) => ({
    id: style.id,
    label: style.label,
    status: 'loading',
    text: '',
    error: ''
  }))
  keepCardInView()

  const running = SUGGESTION_STYLES.map((style) =>
    runCompletion(
      settings,
      buildSuggestionTemplate(instruction, style.id),
      selection.value,
      personaPath
    )
  )
  cancelSuggestions = () => running.forEach((completion) => completion.cancel())

  running.forEach((completion, index) => {
    completion.result
      .then((outcome) => {
        if (run !== suggestionRun) return
        const option = suggestions.value[index]
        const text = outcome.ok ? outcome.text.trim() : ''
        // Two styles can still land on the same words; one copy is enough.
        const duplicate = suggestions.value.some(
          (other) => other !== option && other.status === 'ready' && other.text.trim() === text
        )
        if (text && !duplicate) {
          option.status = 'ready'
          option.text = outcome.ok ? outcome.text : ''
        } else {
          option.status = 'error'
          if (!outcome.ok) {
            option.error = describeError(outcome.error, settings.provider as AIProviderId)
          } else {
            option.error = duplicate ? 'Same as another option.' : 'The model returned nothing.'
          }
        }
        keepCardInView()
      })
      .catch((error: unknown) => {
        if (run !== suggestionRun) return
        const option = suggestions.value[index]
        option.status = 'error'
        option.error = error instanceof Error ? error.message : String(error)
      })
  })
}

const choose = (option: SuggestionOption): void => {
  if (option.status !== 'ready') return
  bus.emit('ai-comments::apply-suggestion', { replacement: option.text })
  reset()
}

const open = (payload: unknown): void => {
  const request = payload as ComposerRequest
  reset()
  scope.value = request.scope
  selection.value = request.selection
  placeCard(request.rect, request.columnRight)
  visible.value = true
  nextTick(() => input.value?.focus())
}

/** Any click outside the card dismisses it, as a popover should. */
const onPointerDown = (event: MouseEvent): void => {
  if (!visible.value) return
  if (card.value && !card.value.contains(event.target as Node)) reset()
}

onMounted(() => {
  bus.on('ai-comments::compose', open)
  document.addEventListener('mousedown', onPointerDown, true)
})

onBeforeUnmount(() => {
  stopSuggestions()
  bus.off('ai-comments::compose', open)
  document.removeEventListener('mousedown', onPointerDown, true)
})
</script>

<style scoped>
.ai-comment-composer {
  position: fixed;
  z-index: 2000;
  /* border-box so the rendered width really is CARD_WIDTH — the placement
     clamp measures against that constant, and content-box sizing would add
     padding and border on top, pushing the card past the viewport edge and
     clipping the Comment button. */
  box-sizing: border-box;
  width: 320px;
  padding: 12px;
  background: var(--floatBgColor);
  border: 1px solid var(--floatBorderColor, var(--itemBgColor));
  border-radius: 6px;
  box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
}

.composer-head {
  margin-bottom: 8px;
}

.whole-document {
  font-size: 12px;
  font-weight: 600;
  color: var(--editorColor50);
}

.quoted {
  font-size: 12px;
  line-height: 1.4;
  color: var(--editorColor50);
  /* The quote is context, not content — never let it push the input off-card. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.suggestions {
  max-height: 260px;
  margin: 10px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.suggestion-option {
  padding: 7px 9px;
  margin-bottom: 6px;
  font-size: 13px;
  line-height: 1.45;
  border: 1px solid var(--itemBgColor);
  border-radius: 5px;
}

.suggestion-option.is-ready {
  cursor: pointer;
}

.suggestion-option.is-ready:hover,
.suggestion-option.is-ready:focus-visible {
  border-color: var(--themeColor);
  outline: none;
}

.option-label {
  display: block;
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--editorColor50);
}

.option-text {
  color: var(--editorColor);
  white-space: pre-wrap;
  word-break: break-word;
}

.option-pending,
.option-failed {
  color: var(--editorColor50);
}

.composer-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  row-gap: 8px;
  margin-top: 10px;
}

/* Kind gets a row to itself: with Suggest beside Cancel and Comment, the
   card is too narrow for all four controls on one line. */
.composer-actions .el-radio-group {
  flex: 1 0 100%;
}

.composer-actions .spacer {
  flex: 1;
}
</style>
