export const MAX_VIDEO_UPLOAD_SIZE_MB = 10 * 1024;

export const PIPELINE_STAGES = [
  'importing',
  'validating',
  'extracting_audio',
  'transcribing',
  'detecting_scenes',
  'analyzing_content',
  'detecting_moments',
  'selecting_clips',
  'editing',
  'rendering',
  'validating_output',
  'completed',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number] | 'failed' | 'cancelled';

export const PIPELINE_STAGE_LABELS: Record<PipelineStage, string> = {
  importing: 'Importing Media',
  validating: 'Validating Streams',
  extracting_audio: 'Extracting Audio',
  transcribing: 'Transcribing Speech',
  detecting_scenes: 'Detecting Scenes & Faces',
  analyzing_content: 'Analyzing Content',
  detecting_moments: 'Detecting Key Moments',
  selecting_clips: 'Selecting Candidate Clips',
  editing: 'Preparing Source-Preserving Reframe',
  rendering: 'Rendering Final Video Clips',
  validating_output: 'Validating Rendered Outputs',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const MAX_SUPPORTED_VIDEO_DURATION_SEC = 36000; // 10 hours
export const DEFAULT_CHUNK_DURATION_SEC = 600; // 10-minute chunks
export const DEFAULT_CHUNK_OVERLAP_SEC = 5; // 5-second boundary overlap

/* -------------------------------------------------------------------------- */
/* Direct Google Drive video import (OAuth 2.0 + official Google Picker API)  */
/* -------------------------------------------------------------------------- */

/** Minimum Drive permission required by ClipForge AI. Per-file access only. */
export const GOOGLE_DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Scopes requested by the dedicated "Connect Google Drive" OAuth flow. */
export const GOOGLE_DRIVE_OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  GOOGLE_DRIVE_FILE_SCOPE,
] as const;

/** Video containers accepted from Google Drive (MP4, MOV, WebM, MKV, M4V). */
export const GOOGLE_DRIVE_SUPPORTED_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-m4v',
] as const;

export type GoogleDriveSupportedMimeType =
  (typeof GOOGLE_DRIVE_SUPPORTED_MIME_TYPES)[number];

/** Streamed-download ceiling (20 GiB) — supports 10-hour high-bitrate exports. */
export const MAX_GOOGLE_DRIVE_FILE_BYTES = 20 * 1024 * 1024 * 1024;

export interface GoogleDrivePickerConfig {
  oauthConfigured: boolean;
  pickerConfigured: boolean;
  /** Browser-safe, HTTP-referrer-restricted Picker API key (never the OAuth client secret). */
  apiKey: string;
  /** Google Cloud project number, used as the Picker App ID. */
  projectNumber: string;
  oauthClientId: string;
  redirectUri: string;
  scopes: string[];
  supportedMimeTypes: string[];
  maxFileSizeBytes: number;
  maxDurationSec: number;
  setupInstructions?: string;
}

export interface GoogleDriveConnectionStatus {
  oauthConfigured: boolean;
  pickerConfigured: boolean;
  connected: boolean;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  googleAccountId?: string;
  scopes?: string[];
  hasRequiredScope: boolean;
  connectedAt?: string;
  status?: 'active' | 'revoked';
  setupInstructions?: string;
}

export interface GoogleDriveSelectedFile {
  /** Opaque server-side selection handle — never a raw Drive file ID from the client. */
  selectionId: string;
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Same-origin backend proxy for the Drive thumbnail (access token never exposed). */
  thumbnailUrl: string | null;
  modifiedTime: string | null;
  expiresAt: string;
}

export const DURATION_PRESETS = [
  { id: '15-30', label: '15–30 seconds', minSec: 15, maxSec: 30 },
  { id: '30-45', label: '30–45 seconds', minSec: 30, maxSec: 45 },
  { id: '45-60', label: '45–60 seconds', minSec: 45, maxSec: 60 },
  { id: '60-90', label: '60–90 seconds', minSec: 60, maxSec: 90 },
  { id: 'custom', label: 'Custom duration', minSec: 10, maxSec: 180 },
] as const;

export type DurationPresetId = (typeof DURATION_PRESETS)[number]['id'];

export const ASPECT_RATIOS = ['9:16', '1:1', '16:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const EDITING_INTENSITIES = ['subtle', 'balanced', 'dynamic'] as const;
export type EditingIntensity = (typeof EDITING_INTENSITIES)[number];

export const CAPTION_POSITIONS = ['bottom', 'middle', 'top'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

export const CAPTION_ANIMATIONS = ['word_pop', 'karaoke', 'fade', 'none'] as const;
export type CaptionAnimation = (typeof CAPTION_ANIMATIONS)[number];

export interface CaptionStyleConfig {
  enabled: boolean;
  font: string;
  fontSize: number;
  position: CaptionPosition;
  textColor: string;
  highlightColor: string;
  backgroundColor: string;
  backgroundOpacity: number;
  animation: CaptionAnimation;
}

export interface ProjectProcessingSettings {
  durationPreset: DurationPresetId;
  customMinDuration: number;
  customMaxDuration: number;
  clipCount: number;
  aspectRatio: AspectRatio;
  language: string;
  editingIntensity: EditingIntensity;
  silenceRemovalEnabled: boolean;
  silenceThresholdDb: number;
  silenceMinDurationSec: number;
  audioNormalization: boolean;
  noiseReduction: boolean;
  zoomEffects: boolean;
  backgroundMusic: 'none' | 'ambient_focus' | 'subtle_pulse';
  watermarkEnabled: boolean;
  watermarkText: string;
  introText: string;
  outroText: string;
  chunkDurationSec?: number;
  captionStyle: CaptionStyleConfig;
}

export interface YouTubeVideoMetadata {
  videoId: string;
  canonicalUrl: string;
  title: string;
  channelId?: string;
  channelName: string;
  channelOwnershipVerified?: boolean;
  thumbnailUrl: string;
  durationSec: number | null;
  privacyStatus: 'public' | 'unlisted' | 'private' | 'unavailable';
  isLiveStream?: boolean;
  metadataSource:
    | 'youtube_oauth_api'
    | 'youtube_data_api'
    | 'authorized_export_manifest'
    | 'youtube_oembed';
}

export interface GoogleConnectedChannel {
  channelId: string;
  title: string;
  customUrl?: string;
  thumbnailUrl?: string;
}

export interface GoogleOAuthStatus {
  oauthConfigured: boolean;
  connected: boolean;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
  scopes?: string[];
  hasYouTubeScope?: boolean;
  hasDriveScope?: boolean;
  channels?: GoogleConnectedChannel[];
  setupInstructions?: string;
}

export type DriveMatchConfidence = 'exact' | 'high' | 'medium' | 'none';

export interface DriveVideoMatchInfo {
  confidence: DriveMatchConfidence;
  score: number;
  matchedByVideoId: boolean;
  matchedByTitle: boolean;
  matchedByDuration: boolean;
  durationDeltaSec: number | null;
  warning?: string;
}

export interface GoogleDriveVideoFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string;
  modifiedTime?: string;
  match?: DriveVideoMatchInfo;
}

export type AuthorizedMediaSourceType =
  | 'google_drive'
  | 'direct_authorized_url'
  | 'owner_export_dir'
  | 'authorized_http_provider'
  | 'custom_command'
  | 'unavailable';

export interface ChunkProgressInfo {
  enabled: boolean;
  chunkDurationSec: number;
  chunkOverlapSec: number;
  totalChunks: number;
  completedChunks: number;
  currentChunkIndex: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyleConfig = {
  enabled: false,
  font: 'DejaVu Sans Bold',
  fontSize: 42,
  position: 'bottom',
  textColor: '#FFFFFF',
  highlightColor: '#38BDF8',
  backgroundColor: '#09090B',
  backgroundOpacity: 0.65,
  animation: 'word_pop',
};

export const DEFAULT_PROCESSING_SETTINGS: ProjectProcessingSettings = {
  durationPreset: '15-30',
  customMinDuration: 15,
  customMaxDuration: 30,
  clipCount: 3,
  aspectRatio: '9:16',
  language: 'auto',
  editingIntensity: 'balanced',
  silenceRemovalEnabled: false,
  silenceThresholdDb: -38,
  silenceMinDurationSec: 0.6,
  audioNormalization: false,
  noiseReduction: false,
  zoomEffects: false,
  backgroundMusic: 'none',
  watermarkEnabled: false,
  watermarkText: '',
  introText: '',
  outroText: '',
  captionStyle: DEFAULT_CAPTION_STYLE,
};

export function estimateProcessingCredits(
  durationSec: number,
  clipCount: number,
  limits: { creditsPerMinuteProcessed: number; minCreditsPerJob: number }
): number {
  const numericDuration = Number.isFinite(durationSec) ? durationSec : 60;
  const numericClipCount = Number.isFinite(clipCount) ? clipCount : 3;
  const safeDur = Math.max(1, numericDuration);
  // Absorb sub-second AAC/MP4 packet-boundary padding (e.g. 3600.06s on an exact 1:00:00 video)
  const adjustedSec = safeDur > 60 ? Math.max(1, safeDur - 1.5) : safeDur;
  const minutes = Math.max(1, Math.ceil(adjustedSec / 60));
  const rate = Math.max(1, limits.creditsPerMinuteProcessed);
  // First 10 minutes billed per minute; long-form video beyond 10m billed per 10-minute chunk
  const baseCredits =
    minutes <= 10 ? minutes * rate : 10 * rate + Math.ceil((minutes - 10) / 10) * rate;
  const extraClips = Math.max(0, numericClipCount - 3) * 2;
  return Math.max(limits.minCreditsPerJob, baseCredits + extraClips);
}
