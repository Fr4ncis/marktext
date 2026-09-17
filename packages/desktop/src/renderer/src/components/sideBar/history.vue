<template>
  <div class="side-bar-history">
    <div class="header">
      <span class="title">History</span>
      <el-button
        v-if="hasHistory"
        text
        size="small"
        title="Save a named checkpoint of the document as it is now"
        @click="checkpoint"
      >
        Checkpoint
      </el-button>
    </div>

    <div
      v-if="!filePath"
      class="empty"
    >
      Save this document to start tracking versions.
    </div>

    <div
      v-else-if="!hasHistory"
      class="empty"
    >
      <p>No versions yet.</p>
      <p class="hint">
        A version is kept each time you save, after a large edit, and
        periodically while you work.
      </p>
      <el-button
        size="small"
        class="first-checkpoint"
        @click="checkpoint"
      >
        Save a checkpoint now
      </el-button>
    </div>

    <template v-else>
      <ol class="timeline">
        <li
          v-for="entry of timeline"
          :key="entry.seq"
          :class="['entry', `is-${entry.trigger}`, { 'is-selected': entry.seq === selectedSeq }]"
          @click="select(entry)"
        >
          <span class="dot" />
          <div class="entry-body">
            <div class="entry-head">
              <span class="entry-label">{{ describeTrigger(entry) }}</span>
              <span class="entry-age">{{ formatAge(entry.createdAt, now) }}</span>
            </div>
            <div class="entry-meta">
              {{ entry.lineCount }} lines · {{ formatBytes(entry.bytes) }}
            </div>
          </div>
        </li>
      </ol>

      <section
        v-if="selected"
        class="preview"
      >
        <div class="preview-head">
          <span>{{ describeTrigger(selected) }} · {{ exactTime(selected.createdAt) }}</span>
          <span
            v-if="diff"
            class="diff-counts"
          >
            <span class="added">+{{ diff.added }}</span>
            <span class="removed">−{{ diff.removed }}</span>
          </span>
        </div>

        <div
          v-if="loadingSeq === selected.seq"
          class="preview-body is-loading"
        >
          Loading…
        </div>
        <div
          v-else-if="selectedText === null"
          class="preview-body is-error"
        >
          This version could not be read; its file may have been removed.
        </div>
        <div
          v-else-if="diff && diff.added === 0 && diff.removed === 0"
          class="preview-body is-identical"
        >
          Identical to the document as it stands now.
        </div>
        <pre
          v-else
          class="preview-body diff"
        ><code
          v-for="(line, index) of visibleDiff"
          :key="index"
          :class="['diff-line', `op-${line.op}`]"
        >{{ prefix(line.op) }}{{ line.text }}</code></pre>

        <p
          v-if="diff && diff.lines.length > MAX_DIFF_LINES"
          class="preview-note"
        >
          Showing the first {{ MAX_DIFF_LINES }} of {{ diff.lines.length }} lines.
        </p>

        <div class="preview-actions">
          <el-button
            type="primary"
            size="small"
            :disabled="selectedText === null"
            @click="restore"
          >
            Restore this version
          </el-button>
          <el-button
            size="small"
            @click="rename"
          >
            Name…
          </el-button>
          <el-button
            text
            size="small"
            @click="remove"
          >
            Delete
          </el-button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessageBox } from 'element-plus'
import type { DiffOp, SnapshotMeta } from '@shared/types/history'
import { describeTrigger, formatAge } from '@shared/types/history'
import { useHistoryStore } from '@/store/history'
import bus from '../../bus'

// The timeline. Restoring needs the live editor, so it goes out on the bus and
// editor.vue performs the document change — this panel never touches Muya.

/** Diff lines rendered before truncating; a full diff can be enormous. */
const MAX_DIFF_LINES = 400

const historyStore = useHistoryStore()
const { filePath, timeline, hasHistory, selectedSeq, selectedText, selected, loadingSeq, diff } =
  storeToRefs(historyStore)

/** Ticks so relative ages stay honest without a re-render per second. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const visibleDiff = computed(() => diff.value?.lines.slice(0, MAX_DIFF_LINES) ?? [])

const prefix = (op: DiffOp): string => (op === 'insert' ? '+ ' : op === 'delete' ? '- ' : '  ')

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`

const exactTime = (createdAt: number): string =>
  new Date(createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })

const select = async (entry: SnapshotMeta): Promise<void> => {
  // Clicking the open entry closes it, so the timeline can be collapsed again.
  await historyStore.SELECT(entry.seq === selectedSeq.value ? null : entry.seq)
}

const restore = (): void => {
  if (selectedText.value === null) return
  bus.emit('history::restore', { text: selectedText.value })
}

const checkpoint = async (): Promise<void> => {
  try {
    const { value } = await ElMessageBox.prompt('Name this checkpoint', 'Save checkpoint', {
      confirmButtonText: 'Save',
      cancelButtonText: 'Cancel',
      inputPlaceholder: 'e.g. before the rewrite'
    })
    await historyStore.CAPTURE('manual', String(value ?? '').trim())
  } catch {
    // Cancelled — ElMessageBox rejects on dismiss.
  }
}

const rename = async (): Promise<void> => {
  const entry = selected.value
  if (!entry) return
  try {
    const { value } = await ElMessageBox.prompt('Name this version', 'Name version', {
      confirmButtonText: 'Save',
      cancelButtonText: 'Cancel',
      inputValue: entry.label ?? ''
    })
    await historyStore.LABEL(entry.seq, String(value ?? ''))
  } catch {
    // Cancelled.
  }
}

const remove = async (): Promise<void> => {
  const entry = selected.value
  if (entry) await historyStore.DELETE(entry.seq)
}

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
})
</script>

<style scoped>
.side-bar-history {
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
  line-height: 1.5;
  opacity: 0.7;
}

.empty .hint {
  margin-top: 8px;
  font-size: 12px;
}

.first-checkpoint {
  margin-top: 12px;
}

.timeline {
  flex: 0 1 auto;
  margin: 0;
  padding: 8px 0;
  overflow-y: auto;
  list-style: none;
}

.entry {
  position: relative;
  padding: 6px 12px 6px 28px;
  cursor: pointer;
}

.entry:hover {
  background: var(--itemBgColor);
}

.entry.is-selected {
  background: var(--itemBgColor);
}

/* The rail that makes the list read as a timeline rather than a list. */
.entry::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 15px;
  width: 1px;
  background: var(--sideBarBorderColor, var(--itemBgColor));
}

.entry:first-child::before {
  top: 12px;
}

.entry:last-child::before {
  bottom: calc(100% - 12px);
}

.dot {
  position: absolute;
  top: 10px;
  left: 11px;
  width: 9px;
  height: 9px;
  background: var(--sideBarColor);
  border: 2px solid var(--sideBarBgColor, var(--floatBgColor));
  border-radius: 50%;
  opacity: 0.45;
}

.entry.is-manual .dot,
.entry.is-save .dot {
  background: var(--themeColor);
  opacity: 1;
}

.entry.is-pre-ai .dot {
  background: var(--themeColor);
  opacity: 0.75;
}

.entry-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.entry-label {
  font-weight: 600;
  word-break: break-word;
}

.entry-age,
.entry-meta {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.6;
}

.preview {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  border-top: 1px solid var(--sideBarBorderColor, var(--itemBgColor));
}

.preview-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 11px;
  opacity: 0.75;
}

.diff-counts .added {
  color: var(--themeColor);
}

.diff-counts .removed {
  margin-left: 6px;
  color: var(--notiErrorBg, #d0021b);
}

.preview-body {
  flex: 1 1 auto;
  min-height: 80px;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-family: var(--codeFontFamily, monospace);
  font-size: 12px;
  line-height: 1.45;
}

.preview-body.is-loading,
.preview-body.is-identical,
.preview-body.is-error {
  font-family: inherit;
  opacity: 0.7;
}

.diff-line {
  display: block;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-line.op-insert {
  background: color-mix(in srgb, var(--themeColor) 18%, transparent);
}

.diff-line.op-delete {
  background: color-mix(in srgb, var(--notiErrorBg, #d0021b) 15%, transparent);
}

.diff-line.op-equal {
  opacity: 0.55;
}

.preview-note {
  margin: 0;
  padding: 0 12px 6px;
  font-size: 11px;
  opacity: 0.6;
}

.preview-actions {
  display: flex;
  align-items: center;
  /* The sidebar can be as narrow as 220px, where three buttons in a row do not
     fit and the trailing ones get clipped off the edge. Wrapping keeps every
     action reachable at any width. */
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--sideBarBorderColor, var(--itemBgColor));
}

.preview-actions :deep(.el-button + .el-button) {
  /* Element Plus adds a left margin between siblings, which fights the gap and
     pushes the row wider than its container once wrapped. */
  margin-left: 0;
}
</style>
