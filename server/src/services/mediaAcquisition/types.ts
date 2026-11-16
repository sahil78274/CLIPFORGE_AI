import type {
  AuthorizedMediaSourceType,
  GoogleDriveVideoFile,
  GoogleOAuthStatus,
  YouTubeVideoMetadata,
} from '@clipforge/shared';
import type { MediaProbeInfo } from '../mediaProbeService';

export interface MediaAcquireOptions {
  userId?: string;
  googleDriveFileId?: string;
  authorizedMediaUrl?: string;
  maxDurationSec?: number;
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}

export interface AcquiredMediaResult {
  localFilePath: string;
  adapterName: string;
  sourceType: AuthorizedMediaSourceType;
  mimeType: string;
  probe: MediaProbeInfo;
  matchedDriveFile?: GoogleDriveVideoFile;
  cleanupAfterStore: boolean;
}

export interface MediaResolutionOption {
  id:
    | 'connect_google_oauth'
    | 'select_google_drive_file'
    | 'provide_direct_authorized_url'
    | 'upload_local_file';
  label: string;
  description: string;
  available: boolean;
}

export interface MediaAccessEvaluation {
  available: boolean;
  configured: boolean;
  adapterName: string;
  sourceType: AuthorizedMediaSourceType;
  requiresAuthorizedMediaUrl: boolean;
  requiresDriveFileSelection: boolean;
  probedDurationSec?: number | null;
  matchedDriveFile?: GoogleDriveVideoFile;
  candidateDriveFiles?: GoogleDriveVideoFile[];
  reason?: string;
  setupInstructions?: string;
  guidance: string;
  resolutionOptions: MediaResolutionOption[];
}

export interface YouTubeSourceInspectionResult {
  metadata: YouTubeVideoMetadata;
  estimatedCredits: number;
  mediaAccess: MediaAccessEvaluation;
  googleAuth?: GoogleOAuthStatus;
}
