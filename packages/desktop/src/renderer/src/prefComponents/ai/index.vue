<template>
  <div class="pref-ai">
    <h4>AI assistant</h4>

    <compound>
      <template #head>
        <bool
          description="Enable the AI assistant"
          :bool="aiEnabled"
          :on-change="(value) => setPreference('aiEnabled', value)"
        />
      </template>
      <template #children>
        <cur-select
          description="Provider"
          :value="aiProvider"
          :options="providerOptions"
          :disable="!aiEnabled"
          :on-change="handleProviderChange"
        />
        <text-box
          description="Model"
          :input="aiModel"
          :disable="!aiEnabled"
          :on-change="(value) => setPreference('aiModel', value)"
        />
        <text-box
          description="Base URL"
          :notes="baseUrlNotes"
          :input="aiBaseUrl"
          :disable="!aiEnabled"
          :on-change="(value) => setPreference('aiBaseUrl', value)"
        />
      </template>
    </compound>

    <section
      v-if="aiEnabled"
      class="ai-section"
    >
      <h6 class="title">
        API key
      </h6>
      <div
        v-if="!encryptionAvailable"
        class="description ai-warning"
      >
        Your system has no OS keychain available, so API keys cannot be stored
        securely and saving will fail. On Linux, start a keyring service
        (gnome-keyring or kwallet) and restart MarkText.
      </div>
      <div
        v-else-if="!providerNeedsKey"
        class="description"
      >
        {{ providerLabel }} runs locally and needs no API key.
      </div>
      <template v-else>
        <div class="description">
          Stored encrypted by your operating system's keychain, outside
          preferences.json. It is never displayed again after saving.
        </div>
        <div class="ai-key-row">
          <el-input
            v-model="apiKeyDraft"
            type="password"
            show-password
            :placeholder="keyPlaceholder"
            class="ai-key-input"
          />
          <el-button
            :disabled="!apiKeyDraft.trim()"
            @click="saveApiKey"
          >
            Save key
          </el-button>
          <el-button
            :disabled="!hasStoredKey"
            @click="clearApiKey"
          >
            Remove
          </el-button>
        </div>
      </template>

      <div class="ai-key-row">
        <el-button
          :loading="testing"
          @click="testConnection"
        >
          Test connection
        </el-button>
        <span
          v-if="testMessage"
          :class="['ai-test-result', testOk ? 'is-ok' : 'is-error']"
        >{{ testMessage }}</span>
      </div>
    </section>

    <section
      v-if="aiEnabled"
      class="ai-section"
    >
      <h6 class="title">
        Request limits
      </h6>
      <range
        description="Max tokens"
        :value="aiMaxTokens"
        :min="256"
        :max="32000"
        :step="256"
        :on-change="(value) => setPreference('aiMaxTokens', value)"
      />
      <range
        description="Timeout (seconds)"
        :value="Math.round(aiTimeoutMs / 1000)"
        :min="5"
        :max="300"
        :step="5"
        :on-change="(value) => setPreference('aiTimeoutMs', value * 1000)"
      />
    </section>

    <section
      v-if="aiEnabled"
      class="ai-section"
    >
      <h6 class="title">
        Prompts
      </h6>
      <div class="description">
        Prompts appear in the editor's right-click AI menu and in the command
        palette. Use <code>{{ SELECTION_PLACEHOLDER }}</code> to control where
        the selected text is inserted; without it the selection is appended
        after the instruction.
      </div>

      <el-table
        :data="prompts"
        style="width: 100%"
      >
        <el-table-column
          label="On"
          width="60"
        >
          <template #default="scope">
            <el-checkbox
              :model-value="scope.row.enabled"
              @change="(value: string | number | boolean) =>
                updatePrompt(scope.row.id, { enabled: Boolean(value) })"
            />
          </template>
        </el-table-column>
        <el-table-column
          label="Label"
          width="200"
        >
          <template #default="scope">
            <el-input
              :model-value="scope.row.label"
              size="small"
              @change="(value: string) => updatePrompt(scope.row.id, { label: value })"
            />
          </template>
        </el-table-column>
        <el-table-column label="Instruction">
          <template #default="scope">
            <el-input
              :model-value="scope.row.template"
              type="textarea"
              :autosize="{ minRows: 1, maxRows: 4 }"
              size="small"
              @change="(value: string) => updatePrompt(scope.row.id, { template: value })"
            />
          </template>
        </el-table-column>
        <el-table-column
          label=""
          width="90"
        >
          <template #default="scope">
            <el-button
              v-if="scope.row.builtin"
              text
              size="small"
              title="Restore this built-in prompt's original wording"
              @click="resetPrompt(scope.row.id)"
            >
              Reset
            </el-button>
            <el-button
              v-else
              text
              size="small"
              title="Delete this prompt"
              @click="deletePrompt(scope.row.id)"
            >
              Delete
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-button
        class="ai-add-prompt"
        @click="addPrompt"
      >
        Add prompt
      </el-button>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePreferencesStore } from '@/store/preferences'
import type { PreferencesState } from '@/store/preferences'
import type { AIPrompt, AIProviderId } from '@shared/types/ai'
import {
  BUILTIN_PROMPTS,
  DEFAULT_BASE_URLS,
  DEFAULT_MODELS,
  PROVIDERS_REQUIRING_KEY,
  SELECTION_PLACEHOLDER,
  reconcilePrompts
} from '@shared/types/ai'
import { settingsFromPreferences, describeError } from '@/services/aiAssistant'
import notice from '@/services/notification'
import Compound from '../common/compound/index.vue'
import CurSelect from '../common/select/index.vue'
import Bool from '../common/bool/index.vue'
import TextBox from '../common/textBox/index.vue'
import Range from '../common/range/index.vue'
import type { PrefSelectOption } from '../common/types'

const preferenceStore = usePreferencesStore()
const { aiEnabled, aiProvider, aiModel, aiBaseUrl, aiMaxTokens, aiTimeoutMs, aiPrompts } =
  storeToRefs(preferenceStore)

const providerOptions: PrefSelectOption[] = [
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'LM Studio (local)', value: 'lmstudio' }
]

const apiKeyDraft = ref('')
const hasStoredKey = ref(false)
const encryptionAvailable = ref(true)
const testing = ref(false)
const testMessage = ref('')
const testOk = ref(false)

const currentProvider = computed(() => aiProvider.value as AIProviderId)
const providerNeedsKey = computed(() => PROVIDERS_REQUIRING_KEY.includes(currentProvider.value))
const providerLabel = computed(
  () => providerOptions.find((option) => option.value === aiProvider.value)?.label ?? ''
)

const keyPlaceholder = computed(() =>
  hasStoredKey.value ? 'A key is saved — enter a new one to replace it' : 'Paste your API key'
)

const baseUrlNotes = computed(
  () => `Leave blank to use ${DEFAULT_BASE_URLS[currentProvider.value]}`
)

/** Always render against the reconciled list so new built-ins show up. */
const prompts = computed(() => reconcilePrompts(aiPrompts.value))

const setPreference = (type: keyof PreferencesState, value: unknown): void => {
  preferenceStore.SET_SINGLE_PREFERENCE({ type, value })
}

const refreshCredentialStatus = async (): Promise<void> => {
  const status = await window.aiAssistant.credentialStatus()
  hasStoredKey.value = status[currentProvider.value]
}

/**
 * Switching provider also swaps the model and clears the base URL, because a
 * model name is provider-specific — leaving `gpt-4o` selected after switching
 * to Anthropic guarantees a 404 the user has to diagnose.
 */
const handleProviderChange = async (value: string | number | boolean): Promise<void> => {
  const provider = String(value) as AIProviderId
  setPreference('aiProvider', provider)
  setPreference('aiModel', DEFAULT_MODELS[provider])
  setPreference('aiBaseUrl', '')
  apiKeyDraft.value = ''
  testMessage.value = ''
  await refreshCredentialStatus()
}

const saveApiKey = async (): Promise<void> => {
  const result = await window.aiAssistant.setApiKey(currentProvider.value, apiKeyDraft.value)
  if (!result.ok) {
    notice.notify({ title: 'AI assistant', type: 'error', message: result.message })
    return
  }
  apiKeyDraft.value = ''
  await refreshCredentialStatus()
  notice.notify({ title: 'AI assistant', type: 'primary', message: 'API key saved.' })
}

const clearApiKey = async (): Promise<void> => {
  await window.aiAssistant.setApiKey(currentProvider.value, '')
  await refreshCredentialStatus()
  notice.notify({ title: 'AI assistant', type: 'primary', message: 'API key removed.' })
}

const testConnection = async (): Promise<void> => {
  testing.value = true
  testMessage.value = ''
  try {
    const result = await window.aiAssistant.testConnection(
      settingsFromPreferences(preferenceStore)
    )
    testOk.value = result.ok
    testMessage.value = result.ok
      ? `Connected — responded as ${result.model}.`
      : describeError(result.error, currentProvider.value)
  } finally {
    testing.value = false
  }
}

// Prompt edits are written back as a whole array: the store persists whole
// preference values, and the library is small enough that a diff would only
// add ways to get out of sync.
const commitPrompts = (next: AIPrompt[]): void => {
  setPreference('aiPrompts', next)
}

const updatePrompt = (id: string, patch: Partial<AIPrompt>): void => {
  commitPrompts(prompts.value.map((p) => (p.id === id ? { ...p, ...patch } : p)))
}

const deletePrompt = (id: string): void => {
  commitPrompts(prompts.value.filter((p) => p.id !== id))
}

const resetPrompt = (id: string): void => {
  const original = BUILTIN_PROMPTS.find((p) => p.id === id)
  if (!original) return
  commitPrompts(prompts.value.map((p) => (p.id === id ? { ...original } : p)))
}

const addPrompt = (): void => {
  // Timestamped id keeps custom prompts distinct from built-in ids and from
  // each other without needing a counter persisted anywhere.
  const id = `custom-${Date.now()}`
  commitPrompts([
    ...prompts.value,
    { id, label: 'New prompt', template: '', builtin: false, enabled: true }
  ])
}

onMounted(async () => {
  encryptionAvailable.value = await window.aiAssistant.isEncryptionAvailable()
  await refreshCredentialStatus()
})
</script>

<style scoped>
.pref-ai .ai-section {
  margin-top: 32px;
}

.pref-ai .title {
  margin: 0 0 8px;
}

.pref-ai .description {
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--editorColor50);
}

.pref-ai .ai-warning {
  color: var(--notiErrorBg, #d0021b);
}

.ai-key-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.ai-key-input {
  max-width: 380px;
}

.ai-test-result {
  font-size: 13px;
}

.ai-test-result.is-ok {
  color: var(--themeColor);
}

.ai-test-result.is-error {
  color: var(--notiErrorBg, #d0021b);
}

.ai-add-prompt {
  margin-top: 12px;
}
</style>
