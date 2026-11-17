import { env } from '../config/env';
import type {
  IClipMetadata,
  IMetadataFallbackReason,
  MetadataFallbackCode,
} from '../models/Clip';
import { logger } from '../utils/logger';
import { NotConfiguredError } from '../utils/errors';

export interface AIProviderInterface {
  readonly providerName: 'gemini' | 'openai_compatible';
  readonly modelName: string;
  isConfigured(): boolean;
  getSetupInstructions(): string;
  generateClipMetadata(input: {
    projectTitle: string;
    clipTranscript: string;
    category: string;
    durationSec: number;
  }): Promise<IClipMetadata>;
}

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'your', 'have', 'for', 'are', 'was',
  'were', 'will', 'about', 'into', 'when', 'what', 'where', 'which', 'their', 'there',
  'they', 'them', 'then', 'than', 'just', 'like', 'more', 'most', 'some', 'very', 'only',
  'also', 'been', 'being', 'over', 'such', 'make', 'made', 'here', 'know', 'every',
]);

const DEFAULT_SUGGESTED_POSTING_WINDOW: IClipMetadata['suggestedPostingWindow'] = {
  configured: false,
  note: 'Channel-specific audience analytics are not connected. General creator short-form engagement windows are 11:30–13:30 and 18:30–21:00 in your primary audience timezone.',
  windowsByPlatform: {
    youtubeShorts: '12:00–14:00 & 19:00–21:00 local audience time',
    instagramReels: '11:30–13:30 & 18:30–20:30 local audience time',
    tiktok: '18:00–21:30 local audience time',
    facebookReels: '12:00–14:00 & 19:00–20:30 local audience time',
  },
};

function getSuggestedPostingWindow(): IClipMetadata['suggestedPostingWindow'] {
  return {
    ...DEFAULT_SUGGESTED_POSTING_WINDOW,
    windowsByPlatform: { ...DEFAULT_SUGGESTED_POSTING_WINDOW.windowsByPlatform },
  };
}

export function buildDeterministicClipMetadata(input: {
  projectTitle: string;
  clipTranscript: string;
  category: string;
  durationSec: number;
}): IClipMetadata {
  const cleanTranscript = (input.clipTranscript || '').replace(/\s+/g, ' ').trim();
  const sentences = cleanTranscript
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const firstSentence =
    sentences[0] || `Key ${input.category} takeaway from ${input.projectTitle}`;
  const trimmedHook =
    firstSentence.length > 90 ? `${firstSentence.slice(0, 87)}...` : firstSentence;

  const words = `${input.projectTitle} ${cleanTranscript}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));

  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const topKeywords = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w]) => w);

  if (topKeywords.length === 0) {
    topKeywords.push('creator', 'insights', 'shorts');
  }

  const hashtags = [
    ...topKeywords.slice(0, 5).map((k) => `#${k}`),
    '#shorts',
    '#reels',
    '#creatorinsights',
  ];

  const primaryTopic = topKeywords[0]
    ? topKeywords[0].charAt(0).toUpperCase() + topKeywords[0].slice(1)
    : 'Key Insight';

  const titleOptions = [
    `${primaryTopic}: ${trimmedHook.slice(0, 58)}`,
    `${input.projectTitle} — ${input.category.charAt(0).toUpperCase() + input.category.slice(1)} Highlight`,
    `Why ${primaryTopic} Matters (${Math.round(input.durationSec)}s Breakdown)`,
  ];

  const thumbWords = topKeywords
    .slice(0, 3)
    .map((w) => w.toUpperCase())
    .join(' • ');

  return {
    titleOptions,
    descriptions: {
      youtubeShorts: `${trimmedHook}\n\nExcerpt from "${input.projectTitle}". Watch the full breakdown and subscribe for more insights.\n\n${hashtags
        .slice(0, 5)
        .join(' ')}`,
      instagramReels: `${trimmedHook}\n.\nFrom: ${input.projectTitle}\nSave this clip for later and share your take below.\n.\n${hashtags.join(
        ' '
      )}`,
      tiktok: `${trimmedHook} — ${input.projectTitle} ${hashtags.slice(0, 6).join(' ')}`,
      facebookReels: `${trimmedHook}\n\nClipped from ${input.projectTitle}. Follow our page for full episodes. ${hashtags
        .slice(0, 4)
        .join(' ')}`,
    },
    hashtags,
    keywords: topKeywords,
    openingHook: trimmedHook,
    thumbnailText: thumbWords || 'KEY TAKEAWAY',
    category: input.category || 'Educational / Insight',
    suggestedPostingWindow: getSuggestedPostingWindow(),
    generatedBy: 'deterministic_nlp',
  };
}

class MetadataProviderFailure extends Error {
  constructor(
    readonly code: Exclude<MetadataFallbackCode, 'not_configured'>,
    readonly statusCode?: number
  ) {
    super(code);
    this.name = 'MetadataProviderFailure';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readResponseJson(response: Response): Promise<unknown> {
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new MetadataProviderFailure('network_error');
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new MetadataProviderFailure('malformed_response');
  }
}

function extractGeminiText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.candidates)) {
    throw new MetadataProviderFailure('malformed_response');
  }

  const candidate = data.candidates[0];
  const content = isRecord(candidate) ? candidate.content : undefined;
  const parts = isRecord(content) ? content.parts : undefined;
  if (!Array.isArray(parts)) throw new MetadataProviderFailure('malformed_response');

  const text = parts
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  if (!text) throw new MetadataProviderFailure('malformed_response');
  return text;
}

function extractOpenAIText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.choices)) {
    throw new MetadataProviderFailure('malformed_response');
  }
  const choice = data.choices[0];
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== 'string' || !content.trim()) {
    throw new MetadataProviderFailure('malformed_response');
  }
  return content.trim();
}

function parseModelJson(text: string): Record<string, unknown> {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const jsonText = fenced ? fenced[1] : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new MetadataProviderFailure('malformed_response');
  }
  if (!isRecord(parsed)) throw new MetadataProviderFailure('malformed_response');
  return parsed;
}

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.map(requireNonEmptyString);
  return strings.every((item): item is string => item !== null) ? strings : null;
}

function normalizeGeneratedMetadata(
  parsed: Record<string, unknown>,
  provider: AIProviderInterface['providerName']
): IClipMetadata {
  const titleOptions = requireStringArray(parsed.titleOptions);
  const descriptionData = isRecord(parsed.descriptions) ? parsed.descriptions : null;
  const descriptions = descriptionData
    ? {
        youtubeShorts: requireNonEmptyString(descriptionData.youtubeShorts),
        instagramReels: requireNonEmptyString(descriptionData.instagramReels),
        tiktok: requireNonEmptyString(descriptionData.tiktok),
        facebookReels: requireNonEmptyString(descriptionData.facebookReels),
      }
    : null;
  const hashtags = requireStringArray(parsed.hashtags);
  const keywords = requireStringArray(parsed.keywords);
  const openingHook = requireNonEmptyString(parsed.openingHook);
  const thumbnailText = requireNonEmptyString(parsed.thumbnailText);
  const category = requireNonEmptyString(parsed.category);

  if (
    !titleOptions ||
    titleOptions.length !== 3 ||
    !descriptions ||
    !descriptions.youtubeShorts ||
    !descriptions.instagramReels ||
    !descriptions.tiktok ||
    !descriptions.facebookReels ||
    !hashtags ||
    hashtags.length < 6 ||
    hashtags.length > 8 ||
    hashtags.some((tag) => !tag.startsWith('#')) ||
    !keywords ||
    keywords.length !== 5 ||
    !openingHook ||
    !thumbnailText ||
    !category
  ) {
    throw new MetadataProviderFailure('incomplete_response');
  }

  return {
    titleOptions,
    descriptions: {
      youtubeShorts: descriptions.youtubeShorts,
      instagramReels: descriptions.instagramReels,
      tiktok: descriptions.tiktok,
      facebookReels: descriptions.facebookReels,
    },
    hashtags,
    keywords,
    openingHook,
    thumbnailText,
    category,
    suggestedPostingWindow: getSuggestedPostingWindow(),
    generatedBy: provider,
  };
}

class GeminiAIProvider implements AIProviderInterface {
  public readonly providerName = 'gemini' as const;
  public readonly modelName = env.GEMINI_MODEL;

  isConfigured(): boolean {
    return Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim().length > 10);
  }

  getSetupInstructions(): string {
    return 'Set GEMINI_API_KEY and AI_PROVIDER=gemini in server/.env (or the repository-root .env), then restart the server.';
  }

  async generateClipMetadata(input: {
    projectTitle: string;
    clipTranscript: string;
    category: string;
    durationSec: number;
  }): Promise<IClipMetadata> {
    if (!this.isConfigured()) {
      throw new NotConfiguredError(
        `Gemini API credentials are NOT CONFIGURED. ${this.getSetupInstructions()}`,
        'AI_NOT_CONFIGURED'
      );
    }

    const prompt = `Generate structured short-form video metadata as strict JSON for this clip.
Project: ${input.projectTitle}
Category: ${input.category}
Duration: ${input.durationSec}s
Transcript: ${input.clipTranscript}

Return JSON with keys:
- titleOptions (array of 3 concise titles, no clickbait)
- descriptions: { youtubeShorts, instagramReels, tiktok, facebookReels }
- hashtags (array of 6-8 relevant hashtags starting with #)
- keywords (array of 5 keywords)
- openingHook (string)
- thumbnailText (2-4 uppercase words)
- category (string)`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.modelName
    )}:generateContent`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.4,
          },
        }),
      });
    } catch {
      throw new MetadataProviderFailure('network_error');
    }

    if (!res.ok) {
      throw new MetadataProviderFailure('http_error', res.status);
    }

    const data = await readResponseJson(res);
    const parsed = parseModelJson(extractGeminiText(data));
    return normalizeGeneratedMetadata(parsed, this.providerName);
  }
}

class OpenAICompatibleProvider implements AIProviderInterface {
  public readonly providerName = 'openai_compatible' as const;
  public readonly modelName = env.OPENAI_MODEL;

  isConfigured(): boolean {
    return Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 8);
  }

  getSetupInstructions(): string {
    return 'Set AI_PROVIDER=openai_compatible, OPENAI_API_KEY, and OPENAI_BASE_URL in server/.env (or the repository-root .env).';
  }

  async generateClipMetadata(input: {
    projectTitle: string;
    clipTranscript: string;
    category: string;
    durationSec: number;
  }): Promise<IClipMetadata> {
    if (!this.isConfigured()) {
      throw new NotConfiguredError(
        `OpenAI-compatible AI credentials are NOT CONFIGURED. ${this.getSetupInstructions()}`,
        'AI_NOT_CONFIGURED'
      );
    }

    let res: Response;
    try {
      res = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Return JSON with titleOptions (3 strings), descriptions ({youtubeShorts, instagramReels, tiktok, facebookReels}), hashtags, keywords, openingHook, thumbnailText, category.',
            },
            {
              role: 'user',
              content: `Project: ${input.projectTitle}\nTranscript: ${input.clipTranscript}`,
            },
          ],
        }),
      });
    } catch {
      throw new MetadataProviderFailure('network_error');
    }

    if (!res.ok) {
      throw new MetadataProviderFailure('http_error', res.status);
    }

    const data = await readResponseJson(res);
    const parsed = parseModelJson(extractOpenAIText(data));
    return normalizeGeneratedMetadata(parsed, this.providerName);
  }
}

export function getAIProvider(): AIProviderInterface {
  if (env.AI_PROVIDER === 'openai_compatible') {
    return new OpenAICompatibleProvider();
  }
  return new GeminiAIProvider();
}

export interface MetadataGenerationContext {
  jobId?: string;
  clipId?: string;
  clipIndex?: number;
}

function providerLabel(provider: AIProviderInterface): string {
  return provider.providerName === 'gemini' ? 'Gemini' : 'OpenAI-compatible provider';
}

function fallbackMessage(
  provider: AIProviderInterface,
  code: MetadataFallbackCode,
  statusCode?: number
): string {
  const label = providerLabel(provider);
  switch (code) {
    case 'not_configured':
      return `${label} credentials are not configured. ${provider.getSetupInstructions()} Deterministic transcript NLP fallback was used.`;
    case 'http_error':
      return `${label} returned HTTP ${statusCode ?? 'error'}; deterministic transcript NLP fallback was used.`;
    case 'network_error':
      return `Could not reach ${label} because of a network or transport error; deterministic transcript NLP fallback was used.`;
    case 'malformed_response':
      return `${label} returned a malformed response; deterministic transcript NLP fallback was used.`;
    case 'incomplete_response':
      return `${label} response was missing or had invalid required metadata fields; deterministic transcript NLP fallback was used.`;
    case 'provider_error':
      return `${label} metadata generation failed; deterministic transcript NLP fallback was used.`;
  }
}

function createFallbackResult(
  provider: AIProviderInterface,
  input: Parameters<AIProviderInterface['generateClipMetadata']>[0],
  code: MetadataFallbackCode,
  context: MetadataGenerationContext,
  statusCode?: number
): { metadata: IClipMetadata; aiNotice: string } {
  const reason: IMetadataFallbackReason = {
    provider: provider.providerName,
    code,
    message: fallbackMessage(provider, code, statusCode),
    ...(statusCode ? { statusCode } : {}),
  };
  const logMeta: Record<string, unknown> = {
    provider: provider.providerName,
    model: provider.modelName,
    reason: code,
    ...(statusCode ? { statusCode } : {}),
    ...(context.jobId ? { jobId: context.jobId } : {}),
    ...(context.clipId ? { clipId: context.clipId } : {}),
    ...(context.clipIndex !== undefined ? { clipIndex: context.clipIndex } : {}),
  };

  // Deliberately log only allowlisted diagnostic fields. Never log raw exceptions,
  // response bodies, request headers, prompts, transcripts, or provider credentials.
  logger.warn('AI metadata generation used deterministic transcript NLP fallback', logMeta);

  return {
    metadata: { ...buildDeterministicClipMetadata(input), fallbackReason: reason },
    aiNotice: reason.message,
  };
}

export async function generateClipMetadataWithGracefulFallback(
  input: {
    projectTitle: string;
    clipTranscript: string;
    category: string;
    durationSec: number;
  },
  context: MetadataGenerationContext = {},
  selectedProvider?: AIProviderInterface
): Promise<{ metadata: IClipMetadata; aiNotice?: string }> {
  const provider = selectedProvider || getAIProvider();
  if (!provider.isConfigured()) {
    return createFallbackResult(provider, input, 'not_configured', context);
  }

  try {
    const metadata = await provider.generateClipMetadata(input);
    return { metadata };
  } catch (error) {
    if (error instanceof NotConfiguredError || (error as { code?: string })?.code === 'AI_NOT_CONFIGURED') {
      return createFallbackResult(provider, input, 'not_configured', context);
    }
    if (error instanceof MetadataProviderFailure) {
      return createFallbackResult(provider, input, error.code, context, error.statusCode);
    }
    return createFallbackResult(provider, input, 'provider_error', context);
  }
}
