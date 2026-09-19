import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, compileScript } from 'vue/compiler-sfc'
import ts from 'typescript'
import { computed, nextTick, ref } from 'vue'

// The apply-to-document path is the correctness-critical seam: a rewrite must
// only reach the editor when the completion succeeded. `execute` lives as a
// <script setup> closure in assistantDialog.vue, and the desktop unit runner
// ships no @vitejs/plugin-vue / @vue/test-utils, so the SFC cannot be mounted.
// Following source-code-image-action.spec.ts, compile the *real* source at
// runtime, swap its imports for injected stubs, and run setup() to drive the
// actual product logic (re-read every run, so it cannot drift).

const here = dirname(fileURLToPath(import.meta.url))
const vuePath = resolve(
  here,
  '../../../src/renderer/src/components/ai/assistantDialog.vue'
)

interface DialogBindings {
  status: { value: string }
  request: { value: unknown }
  replacement: { value: string }
  resultModel: { value: string }
  errorMessage: { value: string }
  open: (payload: unknown) => void
  accept: () => void
}

interface SetupModule {
  default: {
    setup: (props: unknown, ctx: { expose: () => void }) => DialogBindings
  }
}

const loadComponent = (deps: Record<string, unknown>) => {
  const src = readFileSync(vuePath, 'utf8')
  const { descriptor } = parse(src)
  const compiled = compileScript(descriptor, { id: 'test' })
  // Drop every import; bindings come from the injected `__deps` object. Imports
  // may span several lines (`import {\n a,\n b\n} from '...'`), so skip from an
  // `import` line through the line that closes it with `from '...'`.
  const lines = compiled.content.split('\n')
  const kept: string[] = []
  let inImport = false
  for (const line of lines) {
    if (inImport) {
      if (/from\s+['"].*['"]/.test(line)) inImport = false
      continue
    }
    if (/^\s*import\b/.test(line)) {
      // A single-line import both opens and closes on the same line.
      if (!/from\s+['"].*['"]/.test(line)) inImport = true
      continue
    }
    kept.push(line)
  }
  const noImports = kept.join('\n')
  const js = ts.transpileModule(noImports, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    '__deps',
    'exports',
    'module',
    `const { _defineComponent, computed, nextTick, onBeforeUnmount, onMounted, ref, bus,
      usePreferencesStore, describeError, findPrompt, resolvePersonaPath,
      runCompletion, settingsFromPreferences } = __deps
    ${js}
    return module.exports`
  ) as (
    deps: Record<string, unknown>,
    exports: object,
    module: object
  ) => SetupModule
  const m = { exports: {} as Record<string, unknown> }
  return factory(deps, m.exports, m).default
}

/** A prompt the dialog can resolve so `open` auto-runs (no custom-prompt gate). */
const PROMPT = { id: 'rewrite', label: 'Rewrite', template: 'Rewrite: {{selection}}' }

const REQUEST = {
  promptId: 'rewrite',
  selection: 'original text',
  range: { anchor: 0, head: 13 }
}

interface DepOverrides {
  outcome?: unknown
  emit?: (event: string, payload: unknown) => void
}

const makeDeps = (over: DepOverrides = {}) => {
  const result =
    over.outcome === undefined
      ? { ok: true, text: 'rewritten text', model: 'test-model' }
      : over.outcome
  return {
    _defineComponent: (o: unknown) => o,
    computed,
    nextTick: () => Promise.resolve(),
    onMounted: () => {},
    onBeforeUnmount: () => {},
    ref,
    bus: { on: () => {}, off: () => {}, emit: over.emit ?? (() => {}) },
    usePreferencesStore: () => ({}),
    describeError: (error: { message: string }) => `translated: ${error.message}`,
    findPrompt: () => PROMPT,
    resolvePersonaPath: () => undefined,
    runCompletion: () => ({ result: Promise.resolve(result), cancel: () => {} }),
    settingsFromPreferences: () => ({ provider: 'openai' })
  }
}

const boot = (deps: Record<string, unknown>): DialogBindings => {
  const comp = loadComponent(deps)
  return comp.setup({}, { expose: () => {} })
}

describe('assistantDialog execute/apply flow', () => {
  it('reaches ready and carries the completion text on success', async() => {
    const bindings = boot(makeDeps())
    bindings.open(REQUEST)
    await nextTick()
    await Promise.resolve()

    expect(bindings.status.value).toBe('ready')
    expect(bindings.replacement.value).toBe('rewritten text')
    expect(bindings.resultModel.value).toBe('test-model')
    expect(bindings.errorMessage.value).toBe('')
  })

  it('never emits ai::apply-result when the completion fails', async() => {
    const emit = vi.fn()
    const bindings = boot(
      makeDeps({
        outcome: {
          ok: false,
          error: { kind: 'invalid-request', message: 'hit the token limit' }
        },
        emit
      })
    )
    bindings.open(REQUEST)
    await nextTick()
    await Promise.resolve()

    expect(bindings.status.value).toBe('error')
    expect(bindings.errorMessage.value).toBe('translated: hit the token limit')
    expect(bindings.replacement.value).toBe('')
    // The apply-to-document bus event must not fire on a failed completion.
    expect(emit).not.toHaveBeenCalledWith('ai::apply-result', expect.anything())
  })

  it('accept() is inert while status is error (no apply on a failed rewrite)', async() => {
    const emit = vi.fn()
    const bindings = boot(
      makeDeps({
        outcome: {
          ok: false,
          error: { kind: 'invalid-request', message: 'truncated' }
        },
        emit
      })
    )
    bindings.open(REQUEST)
    await nextTick()
    await Promise.resolve()
    expect(bindings.status.value).toBe('error')

    // A stray accept() (e.g. a keybinding) must still not splice anything:
    // replacement is empty on the error path, so the guard short-circuits.
    bindings.accept()
    expect(emit).not.toHaveBeenCalled()
  })

  it('accept() emits ai::apply-result with the range once ready', async() => {
    const emit = vi.fn()
    const bindings = boot(makeDeps({ emit }))
    bindings.open(REQUEST)
    await nextTick()
    await Promise.resolve()
    expect(bindings.status.value).toBe('ready')

    bindings.accept()
    expect(emit).toHaveBeenCalledWith('ai::apply-result', {
      range: REQUEST.range,
      original: REQUEST.selection,
      replacement: 'rewritten text'
    })
  })
})
