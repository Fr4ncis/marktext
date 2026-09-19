// Cross-process types for the AI assistant.
//
// The renderer is sandboxed, so every provider call is made from the main
// process and crosses the `mt::ai::*` IPC channels declared in ./ipc.ts.
// Nothing here may import from `electron` — preload and renderer both
// consume this module.

/** Providers the assistant can talk to. */
export type AIProviderId =
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'lmstudio'
  | 'google'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'cerebras'
  | 'ollama'

/**
 * Every provider id, in the order the settings pane offers them: hosted
 * providers first, local ones last.
 *
 * Exported so the tables below and `getCredentialStatus` can be derived from a
 * single list rather than restated per provider — a hardcoded restatement is
 * what silently reported "no key on file" for any provider added.
 */
export const AI_PROVIDER_IDS: readonly AIProviderId[] = [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'groq',
  'deepseek',
  'mistral',
  'cerebras',
  'lmstudio',
  'ollama'
]

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
export const OPENAI_COMPATIBLE_PROVIDERS: readonly AIProviderId[] = AI_PROVIDER_IDS.filter(
  (id) => id !== 'anthropic'
)

/** Human-readable provider names. The settings pane offers these verbatim. */
export const PROVIDER_LABELS: Record<AIProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  google: 'Google AI (Gemini)',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  cerebras: 'Cerebras',
  lmstudio: 'LM Studio (local)',
  ollama: 'Ollama (local)'
}

/**
 * Endpoint used when `baseUrl` is blank. The two local providers serve on
 * loopback, so their defaults are the ports their installers use.
 *
 * Google's entry is its OpenAI-compatibility endpoint rather than the native
 * `generativelanguage` REST shape, which is what lets it share the adapter.
 */
export const DEFAULT_BASE_URLS: Record<AIProviderId, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  ollama: 'http://127.0.0.1:11434/v1'
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
  google: 'gemini-2.5-pro',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  mistral: 'mistral-large-latest',
  cerebras: 'llama-3.3-70b',
  lmstudio: 'local-model',
  ollama: 'llama3.3'
}

/**
 * Providers that authenticate with a key. The two local ones serve
 * unauthenticated, so the settings pane hides the key field for them.
 */
export const PROVIDERS_REQUIRING_KEY: readonly AIProviderId[] = AI_PROVIDER_IDS.filter(
  (id) => id !== 'lmstudio' && id !== 'ollama'
)

/**
 * One selectable model. `tokenLimitField` overrides the provider-level default
 * for the output-length parameter.
 *
 * That parameter is per-model rather than per-provider — OpenAI's GPT-5 family
 * takes `max_completion_tokens` while older deployments behind an
 * OpenAI-compatible host still take `max_tokens` — so it is carried on the
 * model entry instead of being inferred from the name. See
 * `resolveTokenLimitField` in main/ai/providers/openaiCompatible.ts.
 */
export interface AIModelOption {
  id: string
  label: string
  tokenLimitField?: 'max_tokens' | 'max_completion_tokens'
}

/**
 * Models offered per provider. The settings pane presents these as suggestions
 * and still accepts a typed value, because providers ship models faster than
 * this app ships releases.
 *
 * The local providers serve whatever the user has pulled or loaded, so they
 * carry no list — there is nothing to curate, and a stale guess would be worse
 * than the free-text field.
 */
export const PROVIDER_MODELS: Record<AIProviderId, readonly AIModelOption[]> = {
  anthropic: [
    { id: 'claude-opus-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
  ],
  openai: [
    { id: 'gpt-5.6', label: 'GPT-5.6', tokenLimitField: 'max_completion_tokens' },
    { id: 'gpt-5.6-mini', label: 'GPT-5.6 mini', tokenLimitField: 'max_completion_tokens' },
    { id: 'gpt-5', label: 'GPT-5', tokenLimitField: 'max_completion_tokens' }
  ],
  openrouter: [
    { id: 'anthropic/claude-opus-5', label: 'Opus 5' },
    { id: 'anthropic/claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'openai/gpt-5.6', label: 'GPT-5.6', tokenLimitField: 'max_completion_tokens' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
    { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
    { id: 'qwen/qwen-2.5-72b-instruct', label: 'Qwen 2.5 72B' }
  ],
  google: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' },
    { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant' }
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }
  ],
  mistral: [
    { id: 'mistral-large-latest', label: 'Mistral Large' },
    { id: 'mistral-small-latest', label: 'Mistral Small' },
    { id: 'codestral-latest', label: 'Codestral' }
  ],
  cerebras: [
    { id: 'llama-3.3-70b', label: 'Llama 3.3 70B' },
    { id: 'llama3.1-8b', label: 'Llama 3.1 8B' }
  ],
  lmstudio: [],
  ollama: []
}

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
  },
  {
    id: 'translate-es',
    label: 'Translate to Spanish',
    template:
      'Translate the following markdown into Spanish, preserving all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'translate-fr',
    label: 'Translate to French',
    template:
      'Translate the following markdown into French, preserving all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'translate-de',
    label: 'Translate to German',
    template:
      'Translate the following markdown into German, preserving all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'translate-zh',
    label: 'Translate to Chinese',
    template:
      'Translate the following markdown into Chinese, preserving all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'translate-ja',
    label: 'Translate to Japanese',
    template:
      'Translate the following markdown into Japanese, preserving all markdown formatting.',
    builtin: true,
    enabled: true
  },
  {
    id: 'translate-pt',
    label: 'Translate to Portuguese',
    template:
      'Translate the following markdown into Portuguese, preserving all markdown formatting.',
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
 * Fence between the rendered instruction and the raw selection in the user
 * message. It gives the model an unambiguous boundary so a selection that
 * itself contains prose reading like an instruction cannot bleed into the
 * command — the reason a template that omits {@link SELECTION_PLACEHOLDER}
 * still gets the selection attached rather than inlined.
 */
export const PROMPT_SELECTION_SEPARATOR = '\n\n---\n\n'

/**
 * Assembles the single user-role message every provider sends: the rendered
 * instruction, the separator, then the selection verbatim. Kept here — shared
 * by the OpenAI-compatible and Anthropic adapters — so the string that carries
 * the user's document to the model is defined once and is unit-testable,
 * rather than duplicated inline in each provider where a drift in one would go
 * unnoticed.
 */
export const buildUserMessage = (request: AICompletionRequest): string =>
  `${request.prompt}${PROMPT_SELECTION_SEPARATOR}${request.selection}`

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
