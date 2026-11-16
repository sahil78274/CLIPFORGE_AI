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
  editing: 'Applying Smart Edits & Captions',
  rendering: 'Rendering Final Video Clips',
  validating_output: 'Validating Rendered Outputs',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

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
  captionStyle: CaptionStyleConfig;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyleConfig = {
  enabled: true,
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
  language: 'en',
  editingIntensity: 'balanced',
  silenceRemovalEnabled: true,
  silenceThresholdDb: -38,
  silenceMinDurationSec: 0.6,
  audioNormalization: true,
  noiseReduction: true,
  zoomEffects: true,
  backgroundMusic: 'none',
  watermarkEnabled: false,
  watermarkText: '',
  introText: '',
  outroText: '',
  captionStyle: DEFAULT_CAPTION_STYLE,
};
