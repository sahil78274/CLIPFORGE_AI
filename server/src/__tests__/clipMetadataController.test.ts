import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  clipFindById,
  projectFindById,
  getStorageAdapter,
  reserveCreditsForJob,
  enqueueProcessingJob,
  getActiveQueueMode,
} = vi.hoisted(() => ({
  clipFindById: vi.fn(),
  projectFindById: vi.fn(),
  getStorageAdapter: vi.fn(() => ({ provider: 'local' })),
  reserveCreditsForJob: vi.fn(),
  enqueueProcessingJob: vi.fn(),
  getActiveQueueMode: vi.fn(),
}));

vi.mock('../models', () => ({
  Clip: { findById: clipFindById },
  ProcessingJob: {},
  Project: { findById: projectFindById },
}));

vi.mock('../services/storageService', () => ({
  createMediaAccessToken: vi.fn(),
  getStorageAdapter,
  localStorage: {},
  verifyMediaAccessToken: vi.fn(),
}));

vi.mock('../services/walletService', () => ({ reserveCreditsForJob }));
vi.mock('../queues/videoQueue', () => ({ enqueueProcessingJob, getActiveQueueMode }));

import { env } from '../config/env';
import { clipController } from '../controllers/clipController';
import { logger } from '../utils/logger';

const savedAIProvider = env.AI_PROVIDER;
const savedGeminiKey = env.GEMINI_API_KEY;
const savedGeminiModel = env.GEMINI_MODEL;

const generatedMetadata = {
  titleOptions: ['Gemini title one', 'Gemini title two', 'Gemini title three'],
  descriptions: {
    youtubeShorts: 'Gemini YouTube description',
    instagramReels: 'Gemini Instagram description',
    tiktok: 'Gemini TikTok caption',
    facebookReels: 'Gemini Facebook description',
  },
  hashtags: ['#gemini', '#creator', '#shorts', '#reels', '#video', '#insight'],
  keywords: ['gemini', 'creator', 'shorts', 'video', 'insight'],
  openingHook: 'Gemini opening hook',
  thumbnailText: 'GEMINI METADATA',
  category: 'education',
};

function createClip() {
  return {
    _id: 'clip-id',
    userId: 'user-id',
    projectId: 'project-id',
    title: 'Existing clip title',
    transcript: 'A transcript for metadata generation.',
    category: 'insight',
    durationSec: 20,
    status: 'rendering',
    metadata: {},
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    toObject() {
      return {
        _id: this._id,
        userId: this.userId,
        projectId: this.projectId,
        title: this.title,
        status: this.status,
        metadata: this.metadata,
      };
    },
  };
}

function createRequest() {
  return {
    user: { _id: 'user-id' },
    params: { id: 'clip-id' },
  } as any;
}

describe('clip metadata regeneration API persistence', () => {
  beforeEach(() => {
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = '';
    env.GEMINI_MODEL = 'gemini-controller-test-model';
    clipFindById.mockReset();
    projectFindById.mockReset();
    getStorageAdapter.mockClear();
    reserveCreditsForJob.mockReset();
    enqueueProcessingJob.mockReset();
    getActiveQueueMode.mockReset();
  });

  afterEach(() => {
    env.AI_PROVIDER = savedAIProvider;
    env.GEMINI_API_KEY = savedGeminiKey;
    env.GEMINI_MODEL = savedGeminiModel;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns and saves all Gemini-generated fields without labeling them as fallback', async () => {
    const clip = createClip();
    clipFindById.mockResolvedValue(clip);
    projectFindById.mockResolvedValue({ title: 'Test project' });
    env.GEMINI_API_KEY = 'fake-gemini-key-for-controller-test';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify(generatedMetadata) }] } },
            ],
          }),
      })
    );

    const json = vi.fn();
    await clipController.regenerateMetadata(createRequest(), { json } as any);

    const body = json.mock.calls[0][0];
    expect(clip.save).toHaveBeenCalledOnce();
    expect(clip.markModified).toHaveBeenCalledWith('metadata');
    expect(clip.metadata).toMatchObject({ ...generatedMetadata, generatedBy: 'gemini' });
    expect(clip.metadata.fallbackReason).toBeUndefined();
    expect(body.data.aiNotice).toBeUndefined();
    expect(body.data.clip.metadata).toMatchObject({
      ...generatedMetadata,
      generatedBy: 'gemini',
    });
    expect(body.data.clip.metadata.fallbackReason).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the accurate not-configured reason and saves it with deterministic metadata', async () => {
    const clip = createClip();
    clipFindById.mockResolvedValue(clip);
    projectFindById.mockResolvedValue({ title: 'Test project' });
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const json = vi.fn();
    await clipController.regenerateMetadata(createRequest(), { json } as any);

    const body = json.mock.calls[0][0];
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clip.save).toHaveBeenCalledOnce();
    expect(clip.metadata.generatedBy).toBe('deterministic_nlp');
    expect(clip.metadata.fallbackReason).toMatchObject({
      provider: 'gemini',
      code: 'not_configured',
    });
    expect(body.data.aiNotice).toContain('credentials are not configured');
    expect(body.data.clip.metadata.fallbackReason.message).toBe(body.data.aiNotice);
    expect(warnSpy).toHaveBeenCalledWith(
      'AI metadata generation used deterministic transcript NLP fallback',
      expect.objectContaining({ provider: 'gemini', reason: 'not_configured', clipId: 'clip-id' })
    );
  });
});
