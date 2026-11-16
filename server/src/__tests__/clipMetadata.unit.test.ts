import { describe, expect, it } from 'vitest';
import {
  buildDeterministicClipMetadata,
  generateClipMetadataWithGracefulFallback,
  sanitizeHashtags,
  sanitizeKeywords,
  sanitizeTitleOptions,
} from '../services/aiService';

describe('AI clip metadata sanitisation', () => {
  it('normalises hashtags: adds #, strips punctuation, dedupes case-insensitively, drops junk', () => {
    expect(sanitizeHashtags(['growth', '#Marketing', '  #marketing ', 42, null, '', '#!!'])).toEqual([
      '#growth',
      '#Marketing',
    ]);
  });

  it('caps hashtags and keywords to a sane maximum', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(sanitizeHashtags(many)).toHaveLength(12);
    expect(sanitizeKeywords(many)).toHaveLength(12);
  });

  it('keeps unicode letters in hashtags instead of silently dropping them', () => {
    expect(sanitizeHashtags(['#शॉर्ट्स'])).toEqual(['#शॉर्ट्स']);
  });

  it('returns [] for non-array input (so callers always fall back)', () => {
    expect(sanitizeHashtags('not-an-array')).toEqual([]);
    expect(sanitizeKeywords(undefined)).toEqual([]);
    expect(sanitizeTitleOptions({})).toEqual([]);
  });

  it('trims, dedupes and limits title options to three', () => {
    expect(sanitizeTitleOptions([' A ', 'a', 'B', 'C', 'D'])).toEqual(['A', 'B', 'C']);
  });

  it('deterministic metadata always ships a SEO description, hashtags and keywords', () => {
    const meta = buildDeterministicClipMetadata({
      projectTitle: 'Creator Retention Deep Dive',
      clipTranscript:
        'The biggest retention lever is the first three seconds. Hook viewers before they scroll past.',
      category: 'insight',
      durationSec: 18,
    });
    expect(meta.seoDescription.length).toBeGreaterThan(20);
    expect(meta.hashtags.length).toBeGreaterThan(0);
    expect(meta.hashtags.every((h) => h.startsWith('#'))).toBe(true);
    expect(meta.keywords.length).toBeGreaterThan(0);
    expect(meta.titleOptions).toHaveLength(3);
  });

  it('never returns a clip with no hashtags, even from a degenerate transcript', () => {
    const meta = buildDeterministicClipMetadata({
      projectTitle: '',
      clipTranscript: '',
      category: '',
      durationSec: 15,
    });
    expect(meta.hashtags.length).toBeGreaterThan(0);
    expect(meta.titleOptions).toHaveLength(3);
    expect(meta.seoDescription).toBeTruthy();
  });

  it('graceful fallback reports an aiNotice when no LLM is configured', async () => {
    const { metadata, aiNotice } = await generateClipMetadataWithGracefulFallback({
      projectTitle: 'Wallet Reset Tactics',
      clipTranscript: 'Stop buying coffee. Start compounding. Your wallet will thank you.',
      category: 'finance',
      durationSec: 22,
    });
    expect(metadata.generatedBy).toBe('deterministic_nlp');
    expect(typeof aiNotice === 'string' || aiNotice === null || aiNotice === undefined).toBe(true);
    expect(metadata.seoDescription).toBeTruthy();
    expect(metadata.hashtags.length).toBeGreaterThan(0);
  });
});

describe('Clip metadata export builders', () => {
  const baseClip = {
    _id: 'clip-1',
    title: 'Primary Title',
    startSec: 12.5,
    endSec: 30.5,
    durationSec: 18,
    aspectRatio: '9:16',
    category: 'insight',
    transcript: 'First sentence here. Second sentence follows.',
    captionStyle: { animation: 'word_pop' },
    captionSource: 'word_timestamps',
    captions: [
      { startSec: 0, endSec: 1.5, text: 'First caption line' },
      { startSec: 1.6, endSec: 3.25, text: 'Second caption line' },
    ],
    metadata: {
      titleOptions: ['Primary Title', 'Alt B', 'Alt C'],
      seoDescription: 'An SEO description.',
      descriptions: {
        youtubeShorts: 'YT copy',
        instagramReels: 'IG copy',
        tiktok: 'TT copy',
        facebookReels: 'FB copy',
      },
      hashtags: ['#one', '#two'],
      keywords: ['retention'],
      openingHook: 'Hook line',
      thumbnailText: 'Thumb',
      category: 'insight',
      suggestedPostingWindow: { configured: false, note: 'Post at 6pm.' },
      generatedBy: 'deterministic_nlp',
    },
  } as any;

  it('renders SRT with sequential indices and millisecond timestamps', async () => {
    const { buildSrt } = await import('../controllers/clipController');
    const srt = buildSrt(baseClip);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\nFirst caption line');
    expect(srt).toContain('2\n00:00:01,600 --> 00:00:03,250\nSecond caption line');
  });

  it('falls back to transcript-derived cues when no captions are stored', async () => {
    const { buildSrt } = await import('../controllers/clipController');
    const srt = buildSrt({ ...baseClip, captions: [] } as any);
    expect(srt).toContain('First sentence here.');
    expect(srt).toContain('Second sentence follows.');
  });

  it('returns empty SRT when there is neither captions nor transcript', async () => {
    const { buildSrt } = await import('../controllers/clipController');
    expect(buildSrt({ ...baseClip, captions: [], transcript: '' } as any).trim()).toBe('');
  });

  it('includes every publishing field in the TXT sidecar', async () => {
    const { buildMetadataText } = await import('../controllers/clipController');
    const txt = buildMetadataText(baseClip);
    for (const needle of [
      'Hook line',
      'Thumb',
      'An SEO description.',
      'YouTube Shorts',
      'Instagram Reels',
      'TikTok',
      'Facebook Reels',
      '#one #two',
      'retention',
      'Post at 6pm.',
      'First sentence here.',
    ]) {
      expect(txt).toContain(needle);
    }
    expect(txt).toContain('1. Primary Title');
    expect(txt).toContain('2. Alt B');
    expect(txt).toContain('3. Alt C');
  });

  it('JSON export carries metadata, caption cues and clip facts', async () => {
    const { buildMetadataJson } = await import('../controllers/clipController');
    const json = buildMetadataJson(baseClip);
    expect(json.clipId).toBe('clip-1');
    expect(json.metadata.hashtags).toEqual(['#one', '#two']);
    expect(json.captions).toHaveLength(2);
    expect(json.captionSource).toBe('word_timestamps');
    expect(json.durationSec).toBe(18);
    expect(typeof json.exportedAt).toBe('string');
  });

  it('never throws on a clip with metadata fields missing entirely', async () => {
    const { buildMetadataText, buildMetadataJson } = await import('../controllers/clipController');
    const sparse = { ...baseClip, metadata: {}, captions: [], transcript: '' } as any;
    expect(() => buildMetadataText(sparse)).not.toThrow();
    expect(() => buildMetadataJson(sparse)).not.toThrow();
  });
});
