<template>
  <div
    v-if="visible"
    ref="card"
    class="ai-comment-composer"
    :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    @keydown.esc.stop.prevent="cancel"
  >
    <header class="composer-head">
      <span class="quoted">“{{ truncatedSelection }}”</span>
    </header>

    <el-input
      ref="input"
      v-model="draft"
      type="textarea"
      :rows="2"
      :placeholder="placeholder"
      resize="none"
      @keydown.enter.exact.prevent="submit"
    />

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
import type { AiCommentKind } from '@shared/types/aiComments'
import bus from '../../bus'

// The Word-style composer: select text, get a card next to it, type an
// instruction or a note. The editor owns the selection and performs the
// document edit; this component only collects what the user typed.

/** Payload the editor sends when the user asks to comment on a selection. */
interface ComposerRequest {
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

const visible = ref(false)
const draft = ref('')
const kind = ref<AiCommentKind>('ai')
const selection = ref('')
const position = ref({ top: 0, left: 0 })
const card = ref<HTMLDivElement | null>(null)
const input = ref<{ focus: () => void } | null>(null)

const placeholder = computed(() =>
  kind.value === 'ai' ? 'Tell the AI what to change…' : 'Leave yourself a note…'
)

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

const reset = (): void => {
  visible.value = false
  draft.value = ''
  kind.value = 'ai'
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

const open = (payload: unknown): void => {
  const request = payload as ComposerRequest
  reset()
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

.composer-actions {
  display: flex;
  align-items: center;
  margin-top: 10px;
}

.composer-actions .spacer {
  flex: 1;
}
</style>
