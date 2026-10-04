import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { AICompletionRequest, AICompletionResult, AIProvider, AIProviderId } from '../../core/ai/types';
import { IotosError } from '../../core/errors';

/**
 * Provider adapters. Each uses the vendor's official SDK and maps errors to
 * IotosError so the rest of the app is provider-agnostic.
 */

export interface ProviderConfig {
  apiKey: string;
  model: string;
  /** Override for tests or proxies. */
  baseUrl?: string;
  timeoutMs?: number;
}

function providerError(provider: string, status: number | undefined, message: string): IotosError {
  const hint =
    status === 401 || status === 403
      ? 'Check the API key in Settings → AI.'
      : status === 404
        ? 'Check the model name in Settings → AI.'
        : status === 429
          ? 'Rate limited by the provider; wait and retry.'
          : status !== undefined && status >= 500
            ? 'The provider is having problems; retry later.'
            : undefined;
  return new IotosError('AI_PROVIDER_ERROR', `${provider}: ${message}`, { details: { status }, hint });
}

/** Models that accept the server-side refusal fallback parameter. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;
  constructor(private readonly cfg: ProviderConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 10 * 60_000, maxRetries: 2, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  get model(): string {
    return this.cfg.model;
  }
  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    try {
      // Current Claude models reject sampling parameters, so `temperature` is not sent.
      // Server-side fallbacks re-run a refused request on a fallback model automatically.
      const fallback = FALLBACK_MODELS.has(this.cfg.model);
      const res = await this.client.beta.messages.create(
        {
          model: this.cfg.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        req.signal ? { signal: req.signal } : undefined,
      );
      if (res.stop_reason === 'refusal') {
        throw new IotosError('AI_PROVIDER_ERROR', 'The model declined this request.', { details: { category: res.stop_details?.category ?? null } });
      }
      // Thinking blocks (always on for this model family) are not part of the answer.
      const text = res.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        model: res.model,
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        ...(res.stop_reason ? { stopReason: res.stop_reason } : {}),
      };
    } catch (err) {
      if (err instanceof IotosError) throw err;
      if (err instanceof Anthropic.APIUserAbortError) throw new IotosError('TOOL_CANCELLED', 'AI request cancelled');
      if (err instanceof Anthropic.APIError) throw providerError('Anthropic', err.status, err.message);
      throw providerError('Anthropic', undefined, (err as Error).message);
    }
  }
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;
  constructor(private readonly cfg: ProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 10 * 60_000, maxRetries: 2, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) });
  }
  get model(): string {
    return this.cfg.model;
  }
  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.cfg.model,
          max_completion_tokens: req.maxTokens,
          messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
          ...(req.json ? { response_format: { type: 'json_object' as const } } : {}),
        },
        req.signal ? { signal: req.signal } : undefined,
      );
      const choice = res.choices[0];
      return {
        text: choice?.message.content ?? '',
        model: res.model,
        ...(res.usage ? { usage: { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens } } : {}),
        ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
      };
    } catch (err) {
      if (err instanceof OpenAI.APIUserAbortError) throw new IotosError('TOOL_CANCELLED', 'AI request cancelled');
      if (err instanceof OpenAI.APIError) throw providerError('OpenAI', err.status, err.message);
      throw providerError('OpenAI', undefined, (err as Error).message);
    }
  }
}

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini' as const;
  private readonly client: GoogleGenAI;
  constructor(private readonly cfg: ProviderConfig) {
    this.client = new GoogleGenAI({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { httpOptions: { baseUrl: cfg.baseUrl } } : {}) });
  }
  get model(): string {
    return this.cfg.model;
  }
  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    try {
      const res = await this.client.models.generateContent({
        model: this.cfg.model,
        contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens,
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
          ...(req.signal ? { abortSignal: req.signal } : {}),
        },
      });
      return {
        text: res.text ?? '',
        model: this.cfg.model,
        ...(res.usageMetadata ? { usage: { inputTokens: res.usageMetadata.promptTokenCount, outputTokens: res.usageMetadata.candidatesTokenCount } } : {}),
        ...(res.candidates?.[0]?.finishReason ? { stopReason: String(res.candidates[0].finishReason) } : {}),
      };
    } catch (err) {
      if (req.signal?.aborted) throw new IotosError('TOOL_CANCELLED', 'AI request cancelled');
      const status = (err as { status?: number }).status;
      throw providerError('Gemini', typeof status === 'number' ? status : undefined, (err as Error).message);
    }
  }
}

export function createProvider(id: AIProviderId, cfg: ProviderConfig): AIProvider {
  switch (id) {
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'openai':
      return new OpenAIProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
  }
}
