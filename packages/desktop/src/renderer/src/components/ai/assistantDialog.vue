<template>
  <el-dialog
    v-model="visible"
    :title="dialogTitle"
    :close-on-click-modal="false"
    width="720px"
    class="ai-assistant-dialog"
    @closed="reset"
  >
    <div
      v-if="needsCustomPrompt"
      class="ai-field"
    >
      <label for="ai-custom-prompt">Instruction</label>
      <el-input
        id="ai-custom-prompt"
        ref="customPromptInput"
        v-model="customPrompt"
        type="textarea"
        :rows="3"
        placeholder="e.g. Rewrite this as a numbered checklist"
        @keydown.enter.meta.prevent="submitCustomPrompt"
        @keydown.enter.ctrl.prevent="submitCustomPrompt"
      />
    </div>

    <div class="ai-panes">
      <section class="ai-pane">
        <h5>Original</h5>
        <pre class="ai-text">{{ request?.selection }}</pre>
      </section>
      <section class="ai-pane">
        <h5>
          Rewrite
          <span
            v-if="resultModel"
            class="ai-model"
          >{{ resultModel }}</span>
        </h5>
        <div
          v-if="status === 'loading'"
          v-loading="true"
          class="ai-text ai-loading"
          element-loading-text="Rewriting…"
        />
        <el-input
          v-else-if="status === 'ready'"
          v-model="replacement"
          type="textarea"
          :rows="12"
          class="ai-result-input"
        />
        <pre
          v-else
          class="ai-text ai-placeholder"
        >{{ placeholderText }}</pre>
      </section>
    </div>

    <el-alert
      v-if="errorMessage"
      :title="errorMessage"
      type="error"
      :closable="false"
      show-icon
      class="ai-error"
    />

    <template #footer>
      <el-button
        v-if="status === 'loading'"
        @click="cancel"
      >
        Cancel
      </el-button>
      <template v-else>
        <el-button @click="visible = false">
          Discard
        </el-button>
        <el-button
          v-if="needsCustomPrompt && status === 'idle'"
          type="primary"
          :disabled="!customPrompt.trim()"
          @click="submitCustomPrompt"
        >
          Run
        </el-button>
        <el-button
          v-else
          :disabled="status !== 'ready'"
          @click="retry"
        >
          Try again
        </el-button>
        <el-button
          v-if="status === 'ready'"
          type="primary"
          :disabled="!replacement.trim()"
          @click="accept"
        >
          Replace selection
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { AIProviderId } from '@shared/types/ai'
import bus from '../../bus'
import { usePreferencesStore } from '@/store/preferences'
import {
  describeError,
  findPrompt,
  resolvePersonaPath,
  runCompletion,
  settingsFromPreferences
} from '@/services/aiAssistant'
import type { DocumentRange } from '@/util/documentRange'

// The rewrite is previewed here rather than applied straight to the document:
// the operation is non-deterministic and destroys the original, so the user
// gets to read the result — and edit it — before it lands. The result pane is
// an editable textarea for exactly that reason.

/** Selection snapshot captured by the editor when the action was invoked. */
interface AiRequestPayload {
  promptId: string
  selection: string
  range: DocumentRange
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

const preferences = usePreferencesStore()

const visible = ref(false)
const status = ref<Status>('idle')
const request = ref<AiRequestPayload | null>(null)
const replacement = ref('')
const resultModel = ref('')
const errorMessage = ref('')
const customPrompt = ref('')
const customPromptInput = ref<{ focus: () => void } | null>(null)

/** Set while a request is in flight so Cancel can abort the main-process call. */
let cancelInFlight: (() => void) | null = null

const activePrompt = computed(() =>
  request.value ? findPrompt(preferences, request.value.promptId) : undefined
)

/** An empty prompt id is the "ask me for an instruction" entry point. */
const needsCustomPrompt = computed(() => Boolean(request.value) && !activePrompt.value)

const dialogTitle = computed(() =>
  activePrompt.value ? `AI · ${activePrompt.value.label}` : 'AI · Custom prompt'
)

const placeholderText = computed(() => {
  if (status.value === 'error') return ''
  return needsCustomPrompt.value
    ? 'Enter an instruction above, then choose Run.'
    : 'Waiting for the model…'
})

const reset = (): void => {
  cancelInFlight?.()
  cancelInFlight = null
  status.value = 'idle'
  request.value = null
  replacement.value = ''
  resultModel.value = ''
  errorMessage.value = ''
  customPrompt.value = ''
}

const execute = async (template: string): Promise<void> => {
  const payload = request.value
  if (!payload) return

  status.value = 'loading'
  errorMessage.value = ''
  replacement.value = ''
  resultModel.value = ''

  const settings = settingsFromPreferences(preferences)
  // A prompt may name its own persona; a custom one-off falls back to the
  // default persona.
  const personaPath = resolvePersonaPath(preferences, activePrompt.value?.id)
  const run = runCompletion(settings, template, payload.selection, personaPath)
  cancelInFlight = run.cancel

  const outcome = await run.result
  cancelInFlight = null

  // The user may have discarded the dialog while the request was in flight;
  // `reset` already cleared `request`, and writing state now would resurrect a
  // closed dialog's contents.
  if (!request.value) return

  if (outcome.ok) {
    replacement.value = outcome.text
    resultModel.value = outcome.model
    status.value = 'ready'
    return
  }

  status.value = 'error'
  errorMessage.value = describeError(outcome.error, settings.provider as AIProviderId)
}

/**
 * Fire-and-forget entry point for `execute`, which resolves rather than throws
 * on provider failures. A rejection here therefore means the bridge itself
 * broke, and surfacing it beats leaving the dialog stuck on "Rewriting…".
 */
const start = (template: string): void => {
  execute(template).catch((error: unknown) => {
    status.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : String(error)
  })
}

const submitCustomPrompt = (): void => {
  const template = customPrompt.value.trim()
  if (!template) return
  start(template)
}

const retry = (): void => {
  const template = activePrompt.value?.template ?? customPrompt.value.trim()
  if (template) start(template)
}

const accept = (): void => {
  const payload = request.value
  if (!payload || !replacement.value.trim()) return
  // The editor re-verifies the range still holds the original text before
  // splicing, so a document edited during the request fails safe there.
  bus.emit('ai::apply-result', {
    range: payload.range,
    original: payload.selection,
    replacement: replacement.value
  })
  visible.value = false
}

const cancel = (): void => {
  cancelInFlight?.()
  cancelInFlight = null
  status.value = 'idle'
}

const open = (payload: unknown): void => {
  reset()
  request.value = payload as AiRequestPayload
  visible.value = true

  const prompt = activePrompt.value
  if (prompt) {
    start(prompt.template)
  } else {
    nextTick(() => customPromptInput.value?.focus())
  }
}

onMounted(() => {
  bus.on('ai::open-dialog', open)
})

onBeforeUnmount(() => {
  bus.off('ai::open-dialog', open)
  cancelInFlight?.()
})
</script>

<style scoped>
.ai-panes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.ai-pane h5 {
  margin: 0 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--editorColor50);
}

.ai-model {
  margin-left: 6px;
  text-transform: none;
  letter-spacing: 0;
  opacity: 0.65;
}

.ai-text {
  height: 260px;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  font-family: var(--codeFontFamily, monospace);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--floatBgColor);
  border: 1px solid var(--itemBgColor);
  border-radius: 4px;
}

.ai-placeholder {
  color: var(--editorColor50);
}

.ai-loading {
  display: flex;
}

.ai-field {
  margin-bottom: 16px;
}

.ai-field label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--editorColor50);
}

.ai-error {
  margin-top: 16px;
}

.ai-result-input :deep(textarea) {
  height: 260px;
  font-family: var(--codeFontFamily, monospace);
  font-size: 13px;
  line-height: 1.5;
}
</style>
