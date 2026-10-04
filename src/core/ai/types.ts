/**
 * Provider-neutral AI interfaces. The UI and core never import a provider SDK;
 * providers are adapters in the main process implementing AIProvider.
 */

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;
export type AIProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AICompletionRequest {
  system: string;
  messages: AIMessage[];
  maxTokens: number;
  temperature?: number;
  /** Ask the provider for JSON output where it supports a JSON mode. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface AICompletionResult {
  text: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

export interface AIProvider {
  readonly id: AIProviderId;
  readonly model: string;
  complete(req: AICompletionRequest): Promise<AICompletionResult>;
}

/**
 * Default model per provider; always overridable in Settings. The OpenAI and Gemini
 * defaults could not be verified against live model lists in the development
 * environment — confirm them in Settings for your account.
 */
export const DEFAULT_MODELS: Record<AIProviderId, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
};

export const PROVIDER_LABELS: Record<AIProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};
