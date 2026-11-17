import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, loadBackendEnvironment } from '../config/env';
import {
  generateClipMetadataWithGracefulFallback,
  getAIProvider,
} from '../services/aiService';
import { logger } from '../utils/logger';

const savedAIProvider = env.AI_PROVIDER;
const savedGeminiKey = env.GEMINI_API_KEY;
const savedGeminiModel = env.GEMINI_MODEL;

const metadataInput = {
  projectTitle: 'Test project',
  clipTranscript: 'A test transcript for Gemini.',
  category: 'insight',
  durationSec: 20,
};

const sampleMetadata = {
  titleOptions: ['Test title one', 'Test title two', 'Test title three'],
  descriptions: {
    youtubeShorts: 'YouTube description',
    instagramReels: 'Instagram description',
    tiktok: 'TikTok description',
    facebookReels: 'Facebook description',
  },
  hashtags: ['#clipforge', '#creator', '#video', '#shorts', '#reels', '#insights'],
  keywords: ['clipforge', 'creator', 'video', 'shorts', 'insights'],
  openingHook: 'A test hook',
  thumbnailText: 'TEST CLIP',
  category: 'insight',
};

function mockGeminiResponse(modelText: string) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: modelText }] } }],
      }),
  };
}

describe('backend dotenv and Gemini metadata generation', () => {
  afterEach(() => {
    env.AI_PROVIDER = savedAIProvider;
    env.GEMINI_API_KEY = savedGeminiKey;
    env.GEMINI_MODEL = savedGeminiModel;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads repository-root .env first and lets it fill blank values before server/.env', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-env-root-test-'));
    const serverRoot = path.join(tempRoot, 'server');
    const configDir = path.join(serverRoot, 'src', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"name":"test-root"}');
    fs.writeFileSync(path.join(serverRoot, 'package.json'), '{"name":"@clipforge/server"}');
    fs.writeFileSync(
      path.join(tempRoot, '.env'),
      [
        'AI_PROVIDER=gemini',
        'GEMINI_API_KEY=fake-root-key-for-tests-only',
        'GEMINI_MODEL=gemini-root-test-model',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(serverRoot, '.env'),
      ['AI_PROVIDER=openai_compatible', 'GEMINI_API_KEY=fake-server-key-for-tests-only'].join('\n')
    );

    const previousCwd = process.cwd();
    const testEnv: NodeJS.ProcessEnv = {
      AI_PROVIDER: '',
      GEMINI_API_KEY: '',
      GEMINI_MODEL: '',
    };
    try {
      process.chdir(serverRoot);
      const loaded = loadBackendEnvironment(configDir, testEnv);
      expect(loaded.projectRoot).toBe(tempRoot);
      expect(loaded.rootEnvLoaded).toBe(true);
      expect(loaded.serverEnvLoaded).toBe(true);
      expect(testEnv.AI_PROVIDER).toBe('gemini');
      expect(testEnv.GEMINI_API_KEY).toBe('fake-root-key-for-tests-only');
      expect(testEnv.GEMINI_MODEL).toBe('gemini-root-test-model');
      env.AI_PROVIDER = testEnv.AI_PROVIDER as 'gemini' | 'openai_compatible';
      env.GEMINI_API_KEY = testEnv.GEMINI_API_KEY || '';
      env.GEMINI_MODEL = testEnv.GEMINI_MODEL || '';
      expect(getAIProvider().providerName).toBe('gemini');
      expect(getAIProvider().isConfigured()).toBe(true);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('loads server/.env as the fallback config and selects configured Gemini credentials', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-env-server-test-'));
    const serverRoot = path.join(tempRoot, 'server');
    const configDir = path.join(serverRoot, 'src', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"name":"test-root"}');
    fs.writeFileSync(path.join(serverRoot, 'package.json'), '{"name":"@clipforge/server"}');
    fs.writeFileSync(
      path.join(serverRoot, '.env'),
      [
        'AI_PROVIDER=gemini',
        'GEMINI_API_KEY=fake-server-key-for-tests-only',
        'GEMINI_MODEL=gemini-server-test-model',
      ].join('\n')
    );

    const previousCwd = process.cwd();
    const testEnv: NodeJS.ProcessEnv = {
      AI_PROVIDER: '',
      GEMINI_API_KEY: '',
      GEMINI_MODEL: '',
    };
    try {
      process.chdir(serverRoot);
      const loaded = loadBackendEnvironment(configDir, testEnv);
      expect(loaded.rootEnvLoaded).toBe(false);
      expect(loaded.serverEnvLoaded).toBe(true);
      expect(testEnv.AI_PROVIDER).toBe('gemini');
      expect(testEnv.GEMINI_API_KEY).toBe('fake-server-key-for-tests-only');
      expect(testEnv.GEMINI_MODEL).toBe('gemini-server-test-model');

      env.AI_PROVIDER = testEnv.AI_PROVIDER as 'gemini' | 'openai_compatible';
      env.GEMINI_API_KEY = testEnv.GEMINI_API_KEY || '';
      env.GEMINI_MODEL = testEnv.GEMINI_MODEL || '';
      const provider = getAIProvider();
      expect(provider.providerName).toBe('gemini');
      expect(provider.modelName).toBe('gemini-server-test-model');
      expect(provider.isConfigured()).toBe(true);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('sends a configured Gemini REST request and parses every generated metadata field', async () => {
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = 'fake-gemini-key-for-tests-only';
    env.GEMINI_MODEL = 'gemini-test-model';

    const fetchMock = vi.fn().mockResolvedValue(mockGeminiResponse(JSON.stringify(sampleMetadata)));
    vi.stubGlobal('fetch', fetchMock);

    const provider = getAIProvider();
    expect(provider.providerName).toBe('gemini');
    expect(provider.isConfigured()).toBe(true);

    const metadata = await provider.generateClipMetadata(metadataInput);

    expect(metadata.generatedBy).toBe('gemini');
    expect(metadata.fallbackReason).toBeUndefined();
    expect(metadata.titleOptions).toEqual(sampleMetadata.titleOptions);
    expect(metadata.descriptions).toEqual(sampleMetadata.descriptions);
    expect(metadata.hashtags).toEqual(sampleMetadata.hashtags);
    expect(metadata.keywords).toEqual(sampleMetadata.keywords);
    expect(metadata.openingHook).toBe(sampleMetadata.openingHook);
    expect(metadata.thumbnailText).toBe(sampleMetadata.thumbnailText);
    expect(metadata.category).toBe(sampleMetadata.category);
    expect(metadata.suggestedPostingWindow.configured).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(requestUrl.hostname).toBe('generativelanguage.googleapis.com');
    expect(requestUrl.pathname).toBe('/v1beta/models/gemini-test-model:generateContent');
    expect(requestUrl.search).toBe('');
    expect(headers['x-goog-api-key']).toBe('fake-gemini-key-for-tests-only');
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(String(requestInit.body)).generationConfig.responseMimeType).toBe(
      'application/json'
    );
  });

  it('uses deterministic metadata with an explicit not-configured reason and does not call the provider', async () => {
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = '';
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateClipMetadataWithGracefulFallback(metadataInput);

    expect(getAIProvider().providerName).toBe('gemini');
    expect(getAIProvider().isConfigured()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.metadata.generatedBy).toBe('deterministic_nlp');
    expect(result.metadata.fallbackReason?.code).toBe('not_configured');
    expect(result.aiNotice).toContain('credentials are not configured');
    expect(result.aiNotice).toContain('server/.env');
    expect(warnSpy).toHaveBeenCalledWith(
      'AI metadata generation used deterministic transcript NLP fallback',
      expect.objectContaining({ provider: 'gemini', reason: 'not_configured' })
    );
  });

  it('reports HTTP failures accurately while keeping credentials out of diagnostics', async () => {
    const fakeKey = 'fake-gemini-key-for-tests-only';
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = fakeKey;
    env.GEMINI_MODEL = 'gemini-test-model';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'do not inspect body' })
    );

    const result = await generateClipMetadataWithGracefulFallback(metadataInput, {
      jobId: 'test-job-id',
      clipIndex: 2,
    });

    expect(result.metadata.generatedBy).toBe('deterministic_nlp');
    expect(result.metadata.fallbackReason).toMatchObject({
      provider: 'gemini',
      code: 'http_error',
      statusCode: 429,
    });
    expect(result.aiNotice).toContain('HTTP 429');
    expect(result.aiNotice).not.toContain(fakeKey);
    expect(warnSpy).toHaveBeenCalledWith(
      'AI metadata generation used deterministic transcript NLP fallback',
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-test-model',
        reason: 'http_error',
        statusCode: 429,
        jobId: 'test-job-id',
        clipIndex: 2,
      })
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(fakeKey);
  });

  it('classifies network failures and never surfaces raw provider exception text', async () => {
    const fakeKey = 'fake-gemini-key-for-tests-only';
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = fakeKey;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`request failed with ${fakeKey}`)));

    const result = await generateClipMetadataWithGracefulFallback(metadataInput);

    expect(result.metadata.generatedBy).toBe('deterministic_nlp');
    expect(result.metadata.fallbackReason?.code).toBe('network_error');
    expect(result.aiNotice).toContain('network or transport error');
    expect(result.aiNotice).not.toContain(fakeKey);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(fakeKey);
  });

  it.each([
    {
      name: 'non-JSON provider response',
      responseText: 'not json',
      expectedReason: 'malformed_response',
    },
    {
      name: 'missing Gemini candidate text',
      responseText: JSON.stringify({ candidates: [] }),
      expectedReason: 'malformed_response',
    },
    {
      name: 'incomplete generated metadata',
      responseText: JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({ ...sampleMetadata, titleOptions: ['Only one title'] }),
                },
              ],
            },
          },
        ],
      }),
      expectedReason: 'incomplete_response',
    },
  ])('falls back on $name instead of labeling partial output as Gemini', async (testCase) => {
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = 'fake-gemini-key-for-tests-only';
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => testCase.responseText })
    );

    const result = await generateClipMetadataWithGracefulFallback(metadataInput);

    expect(result.metadata.generatedBy).toBe('deterministic_nlp');
    expect(result.metadata.fallbackReason?.code).toBe(testCase.expectedReason);
    expect(result.metadata.titleOptions).not.toEqual(['Only one title']);
    expect(result.aiNotice).toContain('deterministic transcript NLP fallback was used');
    expect(warnSpy).toHaveBeenCalledWith(
      'AI metadata generation used deterministic transcript NLP fallback',
      expect.objectContaining({ reason: testCase.expectedReason })
    );
  });
});
