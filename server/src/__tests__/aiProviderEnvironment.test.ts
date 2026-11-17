import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, loadBackendEnvironment } from '../config/env';
import {
  generateClipMetadataWithGracefulFallback,
  getAIProvider,
} from '../services/aiService';

const savedAIProvider = env.AI_PROVIDER;
const savedGeminiKey = env.GEMINI_API_KEY;
const savedGeminiModel = env.GEMINI_MODEL;

const sampleMetadata = {
  titleOptions: ['Test title one', 'Test title two', 'Test title three'],
  descriptions: {
    youtubeShorts: 'YouTube description',
    instagramReels: 'Instagram description',
    tiktok: 'TikTok description',
    facebookReels: 'Facebook description',
  },
  hashtags: ['#clipforge'],
  keywords: ['clipforge'],
  openingHook: 'A test hook',
  thumbnailText: 'TEST CLIP',
  category: 'insight',
};

describe('backend dotenv and Gemini provider configuration', () => {
  afterEach(() => {
    env.AI_PROVIDER = savedAIProvider;
    env.GEMINI_API_KEY = savedGeminiKey;
    env.GEMINI_MODEL = savedGeminiModel;
    vi.unstubAllGlobals();
  });

  it('loads the repository-root .env from a server workspace cwd and lets it fill blank values', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipforge-env-test-'));
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
        'GEMINI_MODEL=gemini-test-model',
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
      expect(testEnv.GEMINI_MODEL).toBe('gemini-test-model');
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

  it('initializes Gemini and sends a generateContent request without putting the key in its URL', async () => {
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = 'fake-gemini-key-for-tests-only';
    env.GEMINI_MODEL = 'gemini-test-model';

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(sampleMetadata) }] } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = getAIProvider();
    expect(provider.providerName).toBe('gemini');
    expect(provider.isConfigured()).toBe(true);

    const metadata = await provider.generateClipMetadata({
      projectTitle: 'Test project',
      clipTranscript: 'A test transcript for Gemini.',
      category: 'insight',
      durationSec: 20,
    });

    expect(metadata.generatedBy).toBe('gemini');
    expect(metadata.titleOptions).toEqual(sampleMetadata.titleOptions);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = requestInit.headers as Record<string, string>;
    expect(requestUrl.hostname).toBe('generativelanguage.googleapis.com');
    expect(requestUrl.pathname).toBe('/v1beta/models/gemini-test-model:generateContent');
    expect(requestUrl.search).toBe('');
    expect(headers['x-goog-api-key']).toBe('fake-gemini-key-for-tests-only');
    expect(requestInit.method).toBe('POST');
  });

  it('does not surface provider errors that might contain authentication material', async () => {
    const fakeKey = 'fake-gemini-key-for-tests-only';
    env.AI_PROVIDER = 'gemini';
    env.GEMINI_API_KEY = fakeKey;
    env.GEMINI_MODEL = 'gemini-test-model';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error(`request failed with ${fakeKey}`))
    );

    const result = await generateClipMetadataWithGracefulFallback({
      projectTitle: 'Test project',
      clipTranscript: 'A test transcript for Gemini.',
      category: 'insight',
      durationSec: 20,
    });

    expect(result.metadata.generatedBy).toBe('deterministic_nlp');
    expect(result.aiNotice).toBe(
      'External AI provider request failed; used deterministic transcript NLP fallback.'
    );
    expect(result.aiNotice).not.toContain(fakeKey);
  });
});
