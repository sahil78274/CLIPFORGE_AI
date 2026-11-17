import { BadRequestError } from '../utils/errors';

export const HARD_MAX_CLIPS_PER_JOB = 20;
export const DEFAULT_MAX_CLIPS_PER_JOB = 15;

export function getConfiguredClipLimit(configuredLimit: number | null | undefined): number {
  if (configuredLimit === null || configuredLimit === undefined) {
    return DEFAULT_MAX_CLIPS_PER_JOB;
  }
  const parsedLimit = Number(configuredLimit);
  const limit = Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : DEFAULT_MAX_CLIPS_PER_JOB;
  return Math.max(1, Math.min(HARD_MAX_CLIPS_PER_JOB, limit));
}

export function assertClipCountWithinSystemLimit(
  requestedCount: number,
  configuredLimit: number | null | undefined
): void {
  const maxClips = getConfiguredClipLimit(configuredLimit);
  if (requestedCount > maxClips) {
    throw new BadRequestError(
      `Requested ${requestedCount} clips exceeds the current processing limit of ${maxClips}.`,
      'CLIP_COUNT_LIMIT_EXCEEDED',
      { requestedCount, maxClips }
    );
  }
}
