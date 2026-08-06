import type { CodeMirrorLike } from './editingSurface'

// `editor.vue` is never unmounted — source mode simply overlays it — so it stays
// the owner of the AI handlers in both modes. It therefore needs a way to reach
// the CodeMirror instance that `sourceCode.vue` creates. A registry keeps that
// one dependency explicit instead of having `editor.vue` reach into the DOM for
// `.source-code .CodeMirror`, which would silently break if the markup moved.
//
// A module-level single slot is enough: each editor window is its own renderer
// context, and only one source editor can exist at a time (it is `v-if`'d).

let current: CodeMirrorLike | null = null

export const registerSourceEditor = (cm: CodeMirrorLike | null): void => {
  current = cm
}

export const getSourceEditor = (): CodeMirrorLike | null => current
