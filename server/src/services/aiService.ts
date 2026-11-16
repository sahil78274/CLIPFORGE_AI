import { env } from '../config/env';
import type { IClipMetadata } from '../models/Clip';
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

/** Normalizes LLM/user hashtag output: trims, dedupes, guarantees a leading `#`, drops junk. */
export function sanitizeHashtags(raw: unknown, max = 12): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const body = item
      .trim()
      .replace(/^#+/, '')
      // Keep letters, digits, underscore and combining marks (e.g. Devanagari matras).
      .replace(/[^\p{L}\p{N}\p{M}_]/gu, '');
    if (!body) continue;
    const tag = `#${body}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** Normalizes keyword output: non-empty strings only, trimmed and deduped. */
export function sanitizeKeywords(raw: unknown, max = 12): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const kw = item.trim();
    if (!kw) continue;
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= max) break;
  }
  return out;
}

/** Normalizes title options: non-empty strings, trimmed, at most 3. */
export function sanitizeTitleOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 3) break;
  }
  return out;
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
    seoDescription: `${trimmedHook}\n\nIn this ${Math.round(
      input.durationSec
    )}-second highlight from "${input.projectTitle}", we break down ${topKeywords
      .slice(0, 3)
      .join(', ')}. ${hashtags
      .slice(0, 5)
      .join(' ')}`.slice(0, 900),
    hashtags,
    keywords: topKeywords,
    openingHook: trimmedHook,
    thumbnailText: thumbWords || 'KEY TAKEAWAY',
    category: input.category || 'Educational / Insight',
    suggestedPostingWindow: {
      configured: false,
      note: 'Channel-specific audience analytics are not connected. General creator short-form engagement windows are 11:30–13:30 and 18:30–21:00 in your primary audience timezone.',
      windowsByPlatform: {
        youtubeShorts: '12:00–14:00 & 19:00–21:00 local audience time',
        instagramReels: '11:30–13:30 & 18:30–20:30 local audience time',
        tiktok: '18:00–21:30 local audience time',
        facebookReels: '12:00–14:00 & 19:00–20:30 local audience time',
      },
    },
    generatedBy: 'deterministic_nlp',
  };
}

class GeminiAIProvider implements AIProviderInterface {
  public readonly providerName = 'gemini' as const;
  public readonly modelName = env.GEMINI_MODEL;

  isConfigured(): boolean {
    return Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim().length > 10);
  }

  getSetupInstructions(): string {
    return 'Set GEMINI_API_KEY=<your-google-ai-studio-key> and AI_PROVIDER=gemini in .env, then restart the server.';
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
- seoDescription (one SEO-friendly 2-3 sentence description for the clip)
- descriptions: { youtubeShorts, instagramReels, tiktok, facebookReels }
- hashtags (array of 6-8 relevant hashtags starting with #)
- keywords (array of 5 keywords)
- openingHook (string)
- thumbnailText (2-4 uppercase words)
- category (string)`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.modelName
    )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Gemini API returned status ${res.status}`);
    }

    const data: any = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText);
    const fallback = buildDeterministicClipMetadata(input);

    const parsedTitles = sanitizeTitleOptions(parsed?.titleOptions);
    const parsedHashtags = sanitizeHashtags(parsed?.hashtags);
    const parsedKeywords = sanitizeKeywords(parsed?.keywords);

    return {
      // Only accept the model's titles when we actually got a usable set of 3.
      titleOptions: parsedTitles.length >= 3 ? parsedTitles : fallback.titleOptions,
      descriptions: {
        youtubeShorts:
          typeof parsed?.descriptions?.youtubeShorts === 'string' &&
          parsed.descriptions.youtubeShorts.trim()
            ? parsed.descriptions.youtubeShorts.trim()
            : fallback.descriptions.youtubeShorts,
        instagramReels:
          typeof parsed?.descriptions?.instagramReels === 'string' &&
          parsed.descriptions.instagramReels.trim()
            ? parsed.descriptions.instagramReels.trim()
            : fallback.descriptions.instagramReels,
        tiktok:
          typeof parsed?.descriptions?.tiktok === 'string' && parsed.descriptions.tiktok.trim()
            ? parsed.descriptions.tiktok.trim()
            : fallback.descriptions.tiktok,
        facebookReels:
          typeof parsed?.descriptions?.facebookReels === 'string' &&
          parsed.descriptions.facebookReels.trim()
            ? parsed.descriptions.facebookReels.trim()
            : fallback.descriptions.facebookReels,
      },
      seoDescription:
        typeof parsed?.seoDescription === 'string' && parsed.seoDescription.trim()
          ? parsed.seoDescription.trim().slice(0, 1200)
          : fallback.seoDescription,
      // An empty model array must still fall back, so a clip never ships with no hashtags.
      hashtags: parsedHashtags.length > 0 ? parsedHashtags : fallback.hashtags,
      keywords: parsedKeywords.length > 0 ? parsedKeywords : fallback.keywords,
      openingHook:
        typeof parsed?.openingHook === 'string' && parsed.openingHook.trim()
          ? parsed.openingHook.trim()
          : fallback.openingHook,
      thumbnailText:
        typeof parsed?.thumbnailText === 'string' && parsed.thumbnailText.trim()
          ? parsed.thumbnailText.trim()
          : fallback.thumbnailText,
      category:
        typeof parsed?.category === 'string' && parsed.category.trim()
          ? parsed.category.trim()
          : fallback.category,
      suggestedPostingWindow: fallback.suggestedPostingWindow,
      generatedBy: 'gemini',
    };
  }
}

class OpenAICompatibleProvider implements AIProviderInterface {
  public readonly providerName = 'openai_compatible' as const;
  public readonly modelName = env.OPENAI_MODEL;

  isConfigured(): boolean {
    return Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 8);
  }

  getSetupInstructions(): string {
    return 'Set AI_PROVIDER=openai_compatible, OPENAI_API_KEY=<key>, and OPENAI_BASE_URL in .env.';
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

    const res = await fetch(`${env.OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
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
              'Return JSON with titleOptions (3 strings), seoDescription (2-3 SEO sentences), descriptions ({youtubeShorts, instagramReels, tiktok, facebookReels}), hashtags, keywords, openingHook, thumbnailText, category.',
          },
          {
            role: 'user',
            content: `Project: ${input.projectTitle}\nTranscript: ${input.clipTranscript}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI-compatible API returned status ${res.status}`);
    }

    const data: any = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    const fallback = buildDeterministicClipMetadata(input);

    const parsedTitles = sanitizeTitleOptions(parsed?.titleOptions);
    const parsedHashtags = sanitizeHashtags(parsed?.hashtags);
    const parsedKeywords = sanitizeKeywords(parsed?.keywords);

    return {
      titleOptions: parsedTitles.length >= 3 ? parsedTitles : fallback.titleOptions,
      descriptions: {
        youtubeShorts:
          typeof parsed?.descriptions?.youtubeShorts === 'string' &&
          parsed.descriptions.youtubeShorts.trim()
            ? parsed.descriptions.youtubeShorts.trim()
            : fallback.descriptions.youtubeShorts,
        instagramReels:
          typeof parsed?.descriptions?.instagramReels === 'string' &&
          parsed.descriptions.instagramReels.trim()
            ? parsed.descriptions.instagramReels.trim()
            : fallback.descriptions.instagramReels,
        tiktok:
          typeof parsed?.descriptions?.tiktok === 'string' && parsed.descriptions.tiktok.trim()
            ? parsed.descriptions.tiktok.trim()
            : fallback.descriptions.tiktok,
        facebookReels:
          typeof parsed?.descriptions?.facebookReels === 'string' &&
          parsed.descriptions.facebookReels.trim()
            ? parsed.descriptions.facebookReels.trim()
            : fallback.descriptions.facebookReels,
      },
      seoDescription:
        typeof parsed?.seoDescription === 'string' && parsed.seoDescription.trim()
          ? parsed.seoDescription.trim().slice(0, 1200)
          : fallback.seoDescription,
      hashtags: parsedHashtags.length > 0 ? parsedHashtags : fallback.hashtags,
      keywords: parsedKeywords.length > 0 ? parsedKeywords : fallback.keywords,
      openingHook:
        typeof parsed?.openingHook === 'string' && parsed.openingHook.trim()
          ? parsed.openingHook.trim()
          : fallback.openingHook,
      thumbnailText:
        typeof parsed?.thumbnailText === 'string' && parsed.thumbnailText.trim()
          ? parsed.thumbnailText.trim()
          : fallback.thumbnailText,
      category:
        typeof parsed?.category === 'string' && parsed.category.trim()
          ? parsed.category.trim()
          : fallback.category,
      suggestedPostingWindow: fallback.suggestedPostingWindow,
      generatedBy: 'openai_compatible',
    };
  }
}

export function getAIProvider(): AIProviderInterface {
  if (env.AI_PROVIDER === 'openai_compatible') {
    return new OpenAICompatibleProvider();
  }
  return new GeminiAIProvider();
}

export async function generateClipMetadataWithGracefulFallback(input: {
  projectTitle: string;
  clipTranscript: string;
  category: string;
  durationSec: number;
}): Promise<{ metadata: IClipMetadata; aiNotice?: string }> {
  const provider = getAIProvider();
  if (!provider.isConfigured()) {
    return {
      metadata: buildDeterministicClipMetadata(input),
      aiNotice: `${provider.providerName.toUpperCase()} API credentials are NOT CONFIGURED (${provider.getSetupInstructions()}). Metadata generated via deterministic transcript NLP fallback.`,
    };
  }

  try {
    const metadata = await provider.generateClipMetadata(input);
    return { metadata };
  } catch (err: any) {
    return {
      metadata: buildDeterministicClipMetadata(input),
      aiNotice: `External AI provider unreachable (${err?.message || 'network restriction'}); used deterministic transcript NLP fallback.`,
    };
  }
}
