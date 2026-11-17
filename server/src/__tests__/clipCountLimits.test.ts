import { describe, expect, it } from 'vitest';
import { processingSettingsSchema } from '../validators/schemas';
import {
  assertClipCountWithinSystemLimit,
  getConfiguredClipLimit,
} from '../services/processingSettingsService';

describe('clip count limits', () => {
  it('accepts preset and custom counts within the hard processing ceiling', () => {
    for (const clipCount of [1, 3, 5, 7, 10, 15, 20]) {
      expect(processingSettingsSchema.parse({ clipCount }).clipCount).toBe(clipCount);
      expect(() => assertClipCountWithinSystemLimit(clipCount, 20)).not.toThrow();
    }
  });

  it('rejects values above the hard processing ceiling', () => {
    expect(processingSettingsSchema.safeParse({ clipCount: 21 }).success).toBe(false);
  });

  it('enforces the configured per-job limit instead of silently clamping requests', () => {
    expect(getConfiguredClipLimit(10)).toBe(10);
    expect(() => assertClipCountWithinSystemLimit(15, 10)).toThrow(
      'Requested 15 clips exceeds the current processing limit of 10.'
    );
  });

  it('uses the 15-clip default when no configured limit is available and enforces the hard cap', () => {
    expect(getConfiguredClipLimit(undefined)).toBe(15);
    expect(getConfiguredClipLimit(null)).toBe(15);
    expect(getConfiguredClipLimit(25)).toBe(20);
    expect(() => assertClipCountWithinSystemLimit(15, undefined)).not.toThrow();
    expect(() => assertClipCountWithinSystemLimit(21, 25)).toThrow(
      'Requested 21 clips exceeds the current processing limit of 20.'
    );
  });
});
