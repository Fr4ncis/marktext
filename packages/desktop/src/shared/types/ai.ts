// Cross-process types for the AI assistant.
//
// The renderer is sandboxed, so every provider call is made from the main
// process and crosses the `mt::ai::*` IPC channels declared in ./ipc.ts.
// Nothing here may import from `electron` — preload and renderer both
// consume this module.

/** Providers the assistant can talk to. */
export type AIProviderId = 'anthropic' | 'openai' | 'openrouter' | 'lmstudio'

/**
 * Placeholder substituted with the user's selection when a prompt template is
 * rendered. A template that omits it gets the selection appended instead, so a
 * bare instruction like "Make this formal" still works.
 */
export const SELECTION_PLACEHOLDER = '{{selection}}'

/**
 * A named instruction the user can run against a selection.
 *
 * `builtin` entries ship with the app: they can be edited or hidden but not
 * deleted, so a user who breaks one can restore it. `id` is stable across
 * edits — the context menu and command palette address prompts by it.
 */
export interface AIPrompt {
  id: string
  label: string
  template: string
  builtin: boolean
  /** Hidden prompts stay in preferences but are not offered in any menu. */
  enabled: boolean
  /**
   * Persona to use for this prompt instead of the default. Absent means "use
   * whatever the default persona is", which is what almost every prompt wants.
   */
  personaId?: string
}

/** Everything the main process needs to reach a provider, minus the API key. */
export interface AIProviderSettings {
  provider: AIProviderId
  model: string
  /**
   * Overrides the provider's default endpoint. Required for `lmstudio`, which
   * has no canonical host; ignored for `anthropic`.
   */
  baseUrl: string
  /** Upper bound on a single completion. */
  maxTokens: number
  /** Aborts a request that produces no response within this many milliseconds. */
  timeoutMs: number
}

/** A rendered prompt plus the text it applies to. */
export interface AICompletionRequest {
  /** Fully rendered instruction — the placeholder is already substituted. */
  prompt: string
  /** The selection, passed separately so providers can frame it as user input. */
  selection: string
  /**
   * Markdown file holding the persona for this request. Read in main at send
   * time, so editing the file takes effect on the next request with no reload.
   */
  personaPath?: string
}

/**
 * A reusable voice or domain brief, stored as a Markdown file the user owns.
 *
 * The text lives on disk rather than in preferences because these are expected
 * to be long — house style guides, domain glossaries — and preferences.json is
 * a file users paste into bug reports.
 */
export interface AIPersona {
  id: string
  name: string
  /** Absolute path to the .md file holding the persona text. */
  filePath: string
}

export type AICompletionResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: AIErrorPayload }

/**
 * Provider failures normalized into a shape the renderer can act on without
 * knowing which SDK produced them.
 */
export interface AIErrorPayload {
  kind: AIErrorKind
  message: string
  /** HTTP status when the failure came from a response, else undefined. */
  status?: number
}

export type AIErrorKind =
  /** No API key stored for the selected provider. */
  | 'missing-credentials'
  /** Key was rejected (401/403). */
  | 'authentication'
  /** Provider rate limit (429). */
  | 'rate-limit'
  /** Request was malformed or the model rejected it (4xx other than above). */
  | 'invalid-request'
  /** Provider-side failure (5xx) or overload. */
  | 'provider-unavailable'
  /** Could not reach the host at all — wrong base URL, LM Studio not running. */
  | 'network'
  /** Exceeded `timeoutMs`, or the user cancelled. */
  | 'aborted'
  /** Anything not otherwise classified. */
  | 'unknown'

/** Result of a "does this configuration work" probe from the settings pane. */
export type AIConnectionTestResult =
  | { ok: true; model: string }
  | { ok: false; error: AIErrorPayload }

/** Whether a key is on file for each provider. Never carries the key itself. */
export type AICredentialStatus = Record<AIProviderId, boolean>

/**
 * Providers whose API is OpenAI's `/chat/completions`. `anthropic` is the only
 * one that isn't, and it goes through the official SDK instead.
 */
export const OPENAI_COMPATIBLE_PROVIDERS: readonly AIProviderId[] = [
  'openai',
  'openrouter',
  'lmstudio'
]

/** Endpoint used when `baseUrl` is blank. LM Studio is local-only by nature. */
export const DEFAULT_BASE_URLS: Record<AIProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  lmstudio: 'http://127.0.0.1:1234/v1'
}

/**
 * Sensible starting model per provider. LM Studio serves whatever the user has
 * loaded, so its default is a placeholder the user is expected to replace.
 *
 * The OpenAI default tracks the model its docs recommend "for most workloads".
 * Note that every current OpenAI model is in the GPT-5 family and therefore
 * requires `max_completion_tokens` rather than `max_tokens` — see
 * `resolveTokenLimitField` in main/ai/providers/openaiCompatible.ts.
 */
export const DEFAULT_MODELS: Record<AIProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.6',
  openrouter: 'anthropic/claude-opus-5',
  lmstudio: 'local-model'
}

/** Providers that authenticate with a key. LM Studio runs unauthenticated. */
export const PROVIDERS_REQUIRING_KEY: readonly AIProviderId[] = [
  'anthropic',
  'openai',
  'openrouter'
]

/**
 * Shipped prompt library. Kept here rather than in the JSON schema so both
 * processes agree on the exact wording, and so a preferences file written by an
 * older version can be reconciled against the current set on load.
 */
export const BUILTIN_PROMPTS: readonly AIPrompt[] = [
  {
    id: 'concise',
    label: 'Make concise',
    template:
      'Rewrite the following markdown to be as concise as possible while keeping every fact and all markdown formatting intact.',
    builtin: true,
    enabled: true
  },
  {
    id: 'formal',
    label: 'Make formal',
    template:
      'Rewrite the following markdown in a formal, professional register. Preserve the meaning and all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'casual',
    label: 'Make casual',
    template:
      'Rewrite the following markdown in a relaxed, conversational tone. Preserve the meaning and all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'proofread',
    label: 'Fix spelling & grammar',
    template:
      'Correct spelling, grammar, and punctuation in the following markdown. Change nothing else — keep the wording, voice, and markdown formatting as they are.',
    builtin: true,
    enabled: true
  },
  {
    id: 'expand',
    label: 'Expand',
    template:
      'Expand the following markdown with more detail and supporting explanation, staying on topic and preserving markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'summarize',
    label: 'Summarize',
    template:
      'Summarize the following markdown into a short paragraph that captures its key points.',
    builtin: true,
    enabled: true
  },
  {
    id: 'bullets',
    label: 'Convert to bullet points',
    template:
      'Rewrite the following markdown as a flat markdown bullet list, one point per line, preserving every fact.',
    builtin: true,
    enabled: true
  },
  {
    id: 'translate-en',
    label: 'Translate to English',
    template:
      'Translate the following markdown into English, preserving all markdown formatting.',
    builtin: true,
    enabled: true
  }
]

/**
 * The machine contract for every rewrite, appended after any persona.
 *
 * The output replaces a document selection verbatim, so the model must return
 * only the rewritten text — a preamble like "Here is the revised version:"
 * would be pasted into the user's document. A persona can shape voice and
 * supply domain knowledge, but it can never remove these rules, because a
 * chatty persona would otherwise corrupt every Accept.
 */
export const REWRITE_CONTRACT = [
  'You rewrite excerpts of a markdown document.',
  '',
  'Return only the rewritten excerpt. Do not add a preamble, explanation, or',
  'commentary, and do not wrap the result in a code fence unless the original',
  'excerpt was itself a fenced code block. Preserve the markdown formatting of',
  'the original — headings stay headings, lists stay lists, links stay links —',
  'unless the instruction explicitly asks you to change it.',
  '',
  'If the instruction cannot be applied to the excerpt, return the excerpt',
  'unchanged rather than explaining why.'
].join('\n')

/** Separator between the persona and the contract in the assembled prompt. */
const PERSONA_SEPARATOR = '\n\n---\n\n'

/**
 * Builds the system prompt sent to the provider.
 *
 * The persona leads so it reads as the model's standing brief, and the contract
 * always follows so the result stays safe to paste into the document. An absent
 * or blank persona yields the contract alone, which is the pre-persona
 * behaviour.
 */
export const assembleSystemPrompt = (personaText?: string | null): string => {
  const persona = (personaText ?? '').trim()
  return persona ? `${persona}${PERSONA_SEPARATOR}${REWRITE_CONTRACT}` : REWRITE_CONTRACT
}

/** Renders a prompt template against a selection. */
export const renderPromptTemplate = (template: string, selection: string): string => {
  if (template.includes(SELECTION_PLACEHOLDER)) {
    return template.split(SELECTION_PLACEHOLDER).join(selection)
  }
  return template
}

/**
 * Merges stored prompts with {@link BUILTIN_PROMPTS}. User edits to a builtin
 * win, builtins missing from storage are appended (so a new release's prompts
 * appear for existing users), and unknown builtin ids are dropped as removed.
 */
export const reconcilePrompts = (stored: readonly AIPrompt[] | undefined): AIPrompt[] => {
  const byId = new Map((stored ?? []).map((prompt) => [prompt.id, prompt]))
  const merged: AIPrompt[] = BUILTIN_PROMPTS.map((builtin) => {
    const existing = byId.get(builtin.id)
    byId.delete(builtin.id)
    return existing ? { ...existing, builtin: true } : { ...builtin }
  })
  // Whatever is left is user-authored; `builtin` is forced false so a crafted
  // preferences file cannot mark a custom prompt undeletable.
  for (const custom of byId.values()) {
    merged.push({ ...custom, builtin: false })
  }
  return merged
}
