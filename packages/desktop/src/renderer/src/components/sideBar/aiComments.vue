<template>
  <div class="side-bar-ai-comments">
    <div class="header">
      <span class="title">AI comments</span>
      <el-button
        v-if="hasRunnable"
        text
        size="small"
        @click="runAll"
      >
        Run {{ runnableCount }} pending
      </el-button>
    </div>

    <div
      v-if="!aiEnabled"
      class="empty"
    >
      The AI assistant is turned off. Enable it in Preferences → AI.
    </div>

    <div
      v-else-if="comments.length === 0"
      class="empty"
    >
      <p>No comments in this document.</p>
      <p class="hint">
        Select some text and press <kbd>{{ shortcut }}</kbd> to comment on it,
        or write <code>&lt;!--ai: your instruction--&gt;</code> above a paragraph.
        Either way the rewrite runs in the background while you keep working.
      </p>
    </div>

    <ul
      v-else
      class="comment-list"
    >
      <li
        v-for="comment of comments"
        :key="comment.id"
        :class="['comment', `is-${comment.status}`]"
      >
        <div class="comment-head">
          <span class="instruction">{{ comment.instruction }}</span>
          <span class="status">{{ statusLabel(comment) }}</span>
        </div>

        <p
          v-if="comment.kind === 'note'"
          class="kind-hint"
        >
          Note — not sent to the model.
        </p>

        <p
          class="target"
          :title="comment.target"
        >
          {{ comment.target || 'No paragraph beneath this comment.' }}
        </p>

        <p
          v-if="comment.status === 'ready'"
          class="suggestion"
        >
          {{ comment.suggestion }}
        </p>

        <p
          v-if="comment.status === 'failed'"
          class="error"
        >
          {{ comment.error }}
        </p>

        <div class="actions">
          <template v-if="comment.status === 'ready'">
            <el-button
              type="primary"
              size="small"
              @click="accept(comment)"
            >
              Accept
            </el-button>
            <el-button
              size="small"
              @click="reject(comment)"
            >
              Reject
            </el-button>
          </template>
          <el-button
            v-else-if="comment.kind === 'ai' && comment.status !== 'running'"
            size="small"
            :disabled="!comment.target"
            @click="run(comment)"
          >
            {{ comment.status === 'pending' ? 'Run' : 'Retry' }}
          </el-button>
          <el-button
            v-if="comment.status !== 'running'"
            text
            size="small"
            title="Delete the marker, leaving the text unchanged"
            @click="dismiss(comment)"
          >
            Dismiss
          </el-button>
        </div>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import type { TrackedAiComment } from '@shared/types/aiComments'
import { useAiCommentsStore } from '@/store/aiComments'
import { usePreferencesStore } from '@/store/preferences'
import bus from '../../bus'

// Review surface for the document's AI comments. Applying a suggestion needs
// the live editor, so accept/dismiss go out on the bus and editor.vue performs
// the document edit — the panel never touches Muya.

const aiCommentsStore = useAiCommentsStore()
const { comments } = storeToRefs(aiCommentsStore)
const { aiEnabled } = storeToRefs(usePreferencesStore())

/** Notes never run, so they are not counted as work waiting to be done. */
const runnableCount = computed(
  () =>
    comments.value.filter(
      (c) => c.kind === 'ai' && c.status === 'pending' && c.target.trim()
    ).length
)

const shortcut = navigator.platform.includes('Mac') ? '\u2318\u2325M' : 'Ctrl+Alt+M'
const hasRunnable = computed(() => runnableCount.value > 0)

const statusLabel = (comment: TrackedAiComment): string => {
  switch (comment.status) {
    case 'running':
      return 'Working…'
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Failed'
    case 'rejected':
      return 'Rejected'
    case 'note':
      return 'Note'
    default:
      return comment.target.trim() ? 'Pending' : 'No target'
  }
}

const runAll = (): void => aiCommentsStore.RUN_ALL()
const run = (comment: TrackedAiComment): void => aiCommentsStore.RUN(comment.id)
const reject = (comment: TrackedAiComment): void => aiCommentsStore.REJECT(comment.id)

const accept = (comment: TrackedAiComment): void => {
  bus.emit('ai-comments::accept', comment)
}

const dismiss = (comment: TrackedAiComment): void => {
  bus.emit('ai-comments::dismiss', comment)
}
</script>

<style scoped>
.side-bar-ai-comments {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: 13px;
  color: var(--sideBarColor);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sideBarBorderColor, var(--itemBgColor));
}

.header .title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.7;
}

.empty {
  padding: 16px 12px;
  opacity: 0.7;
  line-height: 1.5;
}

.empty .hint {
  margin-top: 8px;
  font-size: 12px;
}

.empty code {
  font-family: var(--codeFontFamily, monospace);
  word-break: break-all;
}

.comment-list {
  flex: 1;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.comment {
  padding: 10px 12px;
  border-bottom: 1px solid var(--sideBarBorderColor, var(--itemBgColor));
  border-left: 3px solid transparent;
}

.comment.is-ready {
  border-left-color: var(--themeColor);
}

.comment.is-running {
  border-left-color: var(--sideBarTextColor, #909399);
}

.comment.is-failed {
  border-left-color: var(--notiErrorBg, #d0021b);
}

.comment.is-rejected {
  opacity: 0.55;
}

.comment.is-note {
  border-left-color: var(--sideBarTextColor, #909399);
}

.kind-hint {
  margin: 4px 0 0;
  font-size: 11px;
  opacity: 0.6;
}

.comment-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.instruction {
  font-weight: 600;
  word-break: break-word;
}

.status {
  flex-shrink: 0;
  font-size: 11px;
  text-transform: uppercase;
  opacity: 0.6;
}

.target,
.suggestion,
.error {
  margin: 6px 0 0;
  line-height: 1.45;
  /* Long paragraphs would push the actions out of reach; two lines is enough
     to recognise which paragraph a comment refers to. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.target {
  opacity: 0.6;
}

.suggestion {
  padding: 6px 8px;
  background: var(--floatBgColor);
  border-radius: 3px;
}

.error {
  color: var(--notiErrorBg, #d0021b);
}

.actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
</style>
