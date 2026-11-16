import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Clock,
  Coins,
  Download,
  ExternalLink,
  FileVideo,
  Film,
  FolderOpen,
  HardDrive,
  Layers,
  Link2,
  Play,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Sparkles,
  StopCircle,
  Unlink,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import {
  ASPECT_RATIOS,
  CAPTION_ANIMATIONS,
  CAPTION_POSITIONS,
  DEFAULT_PROCESSING_SETTINGS,
  DURATION_PRESETS,
  EDITING_INTENSITIES,
  PIPELINE_STAGES,
  PIPELINE_STAGE_LABELS,
  estimateProcessingCredits,
  type ProjectProcessingSettings,
} from '@clipforge/shared';
import {
  Badge,
  Button,
  Card,
  Input,
  ProgressBar,
  Select,
  Switch,
} from '../../components/ui';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import type { ClipItem, GoogleDriveVideoFile } from '../../types/api';
import { formatBytes, formatDuration } from '../../utils/format';
import { openGoogleDriveVideoPicker } from '../../utils/googlePicker';
import { cn } from '../../utils/cn';
import { useWalletRefresh } from '../../hooks/useWalletRefresh';

type SourceTab = 'upload' | 'google_drive';

export const CreateClipsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const { wallet } = useAuthStore();
  const refreshWallet = useWalletRefresh();

  const paramTab = searchParams.get('tab');
  const hasGoogleQuery =
    paramTab === 'google_drive' ||
    searchParams.has('googleConnected') ||
    searchParams.has('googleError');
  const initialTab: SourceTab = hasGoogleQuery ? 'google_drive' : 'upload';

  const [tab, setTab] = useState<SourceTab>(initialTab);
  const [title, setTitle] = useState('');

  // Option A: Local video upload state
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Option B: Google Drive OAuth + Official Google Picker state
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false);
  const [openingPicker, setOpeningPicker] = useState(false);
  const [verifyingSelection, setVerifyingSelection] = useState(false);
  const [selectedDriveFile, setSelectedDriveFile] =
    useState<GoogleDriveVideoFile | null>(null);
  const [driveChunkPlan, setDriveChunkPlan] = useState<{
    enabled: boolean;
    chunkDurationSec: number;
    chunkOverlapSec: number;
    estimatedChunks: number;
    maxSupportedDurationSec: number;
  } | null>(null);
  const [startingDriveImport, setStartingDriveImport] = useState(false);

  // Live inline processing & generated clips preview/download state
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [selectedPreviewClip, setSelectedPreviewClip] = useState<ClipItem | null>(null);
  const [downloadingBulk, setDownloadingBulk] = useState(false);

  // Processing & editing settings
  const [settings, setSettings] = useState<ProjectProcessingSettings>(
    DEFAULT_PROCESSING_SETTINGS
  );
  const [detectedDurationSec, setDetectedDurationSec] = useState<number>(60);

  const capsQuery = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: () => api.jobs.capabilities(),
  });

  const googleOAuthQuery = useQuery({
    queryKey: ['google-drive-oauth-status'],
    queryFn: () => api.googleDrive.oauthStatus(),
  });

  const googleStatus = googleOAuthQuery.data;
  const googleDriveConnected = Boolean(
    googleStatus?.connected && googleStatus?.hasDriveScope
  );

  // Handle Google OAuth redirect return (?googleConnected=1 or ?googleError=...)
  useEffect(() => {
    const googleConnectedFlag = searchParams.get('googleConnected');
    const googleErrorMsg = searchParams.get('googleError');
    if (googleConnectedFlag === '1') {
      setTab('google_drive');
      pushToast({
        type: 'success',
        title: 'Google Drive connected',
        description:
          'You can now select a video from your Google Drive using Google Picker.',
      });
      void googleOAuthQuery.refetch();
      const next = new URLSearchParams(searchParams);
      next.delete('googleConnected');
      next.set('tab', 'google_drive');
      navigate(`/dashboard/create?${next.toString()}`, { replace: true });
    } else if (googleErrorMsg) {
      setTab('google_drive');
      pushToast({
        type: 'error',
        title: 'Google Drive connection cancelled or failed',
        description: googleErrorMsg,
      });
      const next = new URLSearchParams(searchParams);
      next.delete('googleError');
      next.set('tab', 'google_drive');
      navigate(`/dashboard/create?${next.toString()}`, { replace: true });
    }
  }, [searchParams, navigate, pushToast, googleOAuthQuery]);

  const liveJobQuery = useQuery({
    queryKey: ['inline-active-job', activeJobId],
    queryFn: () => api.jobs.get(activeJobId!),
    enabled: Boolean(activeJobId),
    refetchInterval: (query) => {
      const st = query.state.data?.job.status;
      return st === 'queued' || st === 'processing' ? 1500 : false;
    },
  });

  const liveProjectQuery = useQuery({
    queryKey: ['inline-active-project', activeProjectId, liveJobQuery.data?.job.status],
    queryFn: () => api.projects.get(activeProjectId!),
    enabled: Boolean(activeProjectId && liveJobQuery.data?.job.status === 'completed'),
  });

  useEffect(() => {
    if (
      liveJobQuery.data?.job.status === 'completed' ||
      liveJobQuery.data?.job.status === 'failed'
    ) {
      void refreshWallet();
    }
  }, [liveJobQuery.data?.job.status, refreshWallet]);

  useEffect(() => {
    const clips = liveProjectQuery.data?.clips;
    if (clips && clips.length > 0 && !selectedPreviewClip) {
      setSelectedPreviewClip(clips[0]);
    }
  }, [liveProjectQuery.data?.clips, selectedPreviewClip]);

  const maxUploadMb = capsQuery.data?.limits.maxUploadSizeMb ?? 250;
  const maxDurationSec = capsQuery.data?.limits.maxVideoDurationSec ?? 36000;
  const creditsPerMin = capsQuery.data?.limits.creditsPerMinuteProcessed ?? 10;
  const minCredits = capsQuery.data?.limits.minCreditsPerJob ?? 10;

  const effectiveDurationForCalc =
    tab === 'google_drive'
      ? selectedDriveFile?.durationSec && selectedDriveFile.durationSec > 0
        ? selectedDriveFile.durationSec
        : 60
      : detectedDurationSec;

  const estimatedCredits = estimateProcessingCredits(
    effectiveDurationForCalc,
    settings.clipCount,
    {
      creditsPerMinuteProcessed: creditsPerMin,
      minCreditsPerJob: minCredits,
    }
  );
  const availableCredits = wallet?.availableCredits ?? 0;
  const hasEnoughCredits = availableCredits >= estimatedCredits;

  const inspectLocalVideoFile = (selected: File) => {
    const allowedExt = /\.(mp4|mov|webm|mkv|m4v)$/i;
    if (!selected.type.startsWith('video/') && !allowedExt.test(selected.name)) {
      pushToast({
        type: 'error',
        title: 'Unsupported file format',
        description: 'Please select a valid MP4, MOV, WebM, or MKV video file.',
      });
      return;
    }

    if (selected.size > maxUploadMb * 1024 * 1024) {
      pushToast({
        type: 'error',
        title: 'File exceeds size limit',
        description: `Maximum upload size is ${maxUploadMb} MB.`,
      });
      return;
    }

    setFile(selected);
    if (!title.trim()) {
      setTitle(selected.name.replace(/\.[^.]+$/, ''));
    }

    const objectUrl = URL.createObjectURL(selected);
    const probeVideo = document.createElement('video');
    probeVideo.preload = 'metadata';
    probeVideo.onloadedmetadata = () => {
      URL.revokeObjectURL(objectUrl);
      if (probeVideo.duration && Number.isFinite(probeVideo.duration)) {
        if (probeVideo.duration > maxDurationSec) {
          pushToast({
            type: 'warning',
            title: 'Video exceeds maximum duration',
            description: `Maximum supported video length is ${Math.round(
              maxDurationSec / 3600
            )} hours.`,
          });
        }
        setDetectedDurationSec(Math.round(probeVideo.duration));
      }
    };
    probeVideo.onerror = () => {
      URL.revokeObjectURL(objectUrl);
    };
    probeVideo.src = objectUrl;
  };

  // Step 1: Connect Google Drive via OAuth 2.0 (minimum scope: drive.file)
  const handleConnectGoogleDrive = async () => {
    setConnectingGoogle(true);
    try {
      const res = await api.googleDrive.oauthAuthorize({
        redirectPath: '/dashboard/create?tab=google_drive',
      });
      window.location.href = res.authorizationUrl;
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Google Drive OAuth unavailable',
        description:
          err?.message ||
          'Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI in your backend .env file.',
      });
      setConnectingGoogle(false);
    }
  };

  // Disconnect Google Drive & revoke refresh token
  const handleDisconnectGoogleDrive = async () => {
    setDisconnectingGoogle(true);
    try {
      await api.googleDrive.oauthDisconnect();
      setSelectedDriveFile(null);
      setDriveChunkPlan(null);
      await googleOAuthQuery.refetch();
      pushToast({
        type: 'info',
        title: 'Google Drive disconnected',
        description: 'OAuth token was revoked and cleared from your account.',
      });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Disconnect failed',
        description: err?.message,
      });
    } finally {
      setDisconnectingGoogle(false);
    }
  };

  // Steps 2–5: Open Official Google Picker -> Select Video -> Verify on Backend -> Show File Info
  const handleOpenGooglePicker = async () => {
    setOpeningPicker(true);
    try {
      const session = await api.googleDrive.createPickerSession();
      const picked = await openGoogleDriveVideoPicker(session);
      if (!picked) {
        return; // User cancelled Picker modal cleanly
      }

      setVerifyingSelection(true);
      const verified = await api.googleDrive.selectFile({
        fileId: picked.id,
        clipCount: settings.clipCount,
      });

      // Merge thumbnail from Picker if Drive API omitted thumbnailLink
      const mergedFile: GoogleDriveVideoFile = {
        ...verified.file,
        thumbnailUrl: verified.file.thumbnailUrl || picked.thumbnailUrl,
      };

      setSelectedDriveFile(mergedFile);
      setDriveChunkPlan(verified.chunkPlan);
      if (!title.trim() || selectedDriveFile) {
        setTitle(mergedFile.name.replace(/\.[a-z0-9]{2,5}$/i, ''));
      }
      if (mergedFile.durationSec && mergedFile.durationSec > 0) {
        setDetectedDurationSec(mergedFile.durationSec);
      }

      pushToast({
        type: 'success',
        title: 'Google Drive video selected',
        description: `"${mergedFile.name}" verified and ready for clip generation.`,
      });
    } catch (err: any) {
      if (err?.code === 'GOOGLE_OAUTH_REVOKED') {
        void googleOAuthQuery.refetch();
      }
      pushToast({
        type: 'error',
        title: 'Could not select Google Drive video',
        description:
          err?.message ||
          'Ensure Google Picker API is enabled and GOOGLE_API_KEY + GOOGLE_PROJECT_NUMBER are set.',
      });
    } finally {
      setOpeningPicker(false);
      setVerifyingSelection(false);
    }
  };

  // Step 6: Click Generate Clips for Selected Google Drive Video
  const handleGoogleDriveGenerateStart = async () => {
    if (!selectedDriveFile) {
      pushToast({
        type: 'warning',
        title: 'Select a video from Google Drive first',
      });
      return;
    }

    setStartingDriveImport(true);
    setSelectedPreviewClip(null);
    try {
      const res = await api.googleDrive.importVideo({
        fileId: selectedDriveFile.id,
        title:
          title.trim() ||
          selectedDriveFile.name.replace(/\.[a-z0-9]{2,5}$/i, ''),
        settings,
        autoStart: true,
      });
      await refreshWallet();
      setActiveProjectId(res.project._id);
      if (res.job?._id) {
        setActiveJobId(res.job._id);
      }
      pushToast({
        type: 'success',
        title: 'Google Drive import & AI clip pipeline started',
        description:
          'Streaming video to temporary storage and running chunked transcription & clip rendering below.',
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      if (err?.code === 'GOOGLE_OAUTH_REVOKED') {
        void googleOAuthQuery.refetch();
      }
      pushToast({
        type: 'error',
        title: 'Could not start Google Drive clip generation',
        description:
          err?.message || 'Verify Google Drive permissions and wallet credits.',
      });
    } finally {
      setStartingDriveImport(false);
    }
  };

  // Option A: Upload local video & start pipeline
  const handleUploadStart = async () => {
    if (!file) {
      pushToast({ type: 'warning', title: 'Select a video file first' });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    setUploadProgress(0);
    setSelectedPreviewClip(null);

    try {
      const res = await api.videos.uploadWithProgress({
        file,
        title: title.trim() || file.name.replace(/\.[^.]+$/, ''),
        settings,
        autoStart: true,
        onProgress: setUploadProgress,
        signal: controller.signal,
      });
      await refreshWallet();
      if (res.job?._id) {
        setActiveProjectId(res.project._id);
        setActiveJobId(res.job._id);
        pushToast({
          type: 'success',
          title: 'Video uploaded & pipeline started',
          description: 'Track live processing progress and download clips below.',
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        navigate(`/dashboard/projects/${res.project._id}`);
      }
    } catch (err: any) {
      if (err?.code === 'UPLOAD_CANCELLED') {
        pushToast({ type: 'info', title: 'Upload cancelled' });
      } else {
        pushToast({
          type: 'error',
          title: 'Upload or job start failed',
          description: err?.message || 'Please check your file and credit balance.',
        });
      }
    } finally {
      setUploading(false);
      abortRef.current = null;
    }
  };

  const handleCancelInlineJob = async () => {
    if (!activeJobId) return;
    try {
      await api.jobs.cancel(activeJobId);
      await refreshWallet();
      void liveJobQuery.refetch();
      pushToast({
        type: 'info',
        title: 'Processing cancelled',
        description: 'Reserved credits were returned to your wallet.',
      });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Cancel failed', description: err?.message });
    }
  };

  const handleRetryInlineJob = async () => {
    if (!activeJobId) return;
    try {
      const res = await api.jobs.retry(activeJobId);
      await refreshWallet();
      setActiveJobId(res.job._id);
      pushToast({ type: 'success', title: 'Retry started' });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Retry failed', description: err?.message });
    }
  };

  const handleBulkZipDownload = async (clipIds: string[]) => {
    if (!clipIds.length) return;
    setDownloadingBulk(true);
    try {
      const { downloadUrl } = await api.clips.getBulkDownloadUrl(clipIds);
      window.location.href = downloadUrl;
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Bulk download failed',
        description: err?.message,
      });
    } finally {
      setDownloadingBulk(false);
    }
  };

  const updateCaption = <K extends keyof ProjectProcessingSettings['captionStyle']>(
    key: K,
    val: ProjectProcessingSettings['captionStyle'][K]
  ) => {
    setSettings((prev) => ({
      ...prev,
      captionStyle: {
        ...prev.captionStyle,
        [key]: val,
      },
    }));
  };

  const liveJob = liveJobQuery.data?.job;
  const generatedClips = liveProjectQuery.data?.clips || [];
  const activeStageIdx = liveJob ? PIPELINE_STAGES.indexOf(liveJob.stage as any) : -1;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Create Short Clips
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Upload a video file or import directly from Google Drive (supports long-form
            videos up to 10 hours with chunked AI processing).
          </p>
        </div>
        <Badge variant="brand">Up to 10h Chunked Pipeline</Badge>
      </div>

      {/* STEPS 7 & 8: LIVE REAL-TIME PROCESSING PROGRESS + GENERATED CLIPS & DOWNLOAD OPTIONS */}
      {liveJob && (
        <Card className="p-6 border-[#7C5CFF]/45 bg-[#12121C] space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-base font-semibold text-white">
                  {title ||
                    liveJob.googleDriveImport?.name ||
                    selectedDriveFile?.name ||
                    'AI Clip Generation'}
                </span>
                <Badge
                  variant={
                    liveJob.status === 'completed'
                      ? 'success'
                      : liveJob.status === 'failed'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {liveJob.status.toUpperCase()}
                </Badge>
                {liveJob.chunkProgress && liveJob.chunkProgress.totalChunks > 1 && (
                  <Badge variant="brand">
                    Chunks: {liveJob.chunkProgress.completedChunks}/
                    {liveJob.chunkProgress.totalChunks}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-zinc-400">
                {PIPELINE_STAGE_LABELS[liveJob.stage] || liveJob.stage} —{' '}
                {liveJob.currentMessage}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(liveJob.status === 'queued' || liveJob.status === 'processing') && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleCancelInlineJob}
                  leftIcon={<StopCircle className="w-3.5 h-3.5" />}
                >
                  Cancel Job
                </Button>
              )}
              {liveJob.status === 'failed' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleRetryInlineJob}
                  leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
                >
                  Retry Processing
                </Button>
              )}
              {activeProjectId && (
                <Link to={`/dashboard/projects/${activeProjectId}`}>
                  <Button
                    size="sm"
                    variant="outline"
                    leftIcon={<ExternalLink className="w-3.5 h-3.5" />}
                  >
                    Open Project Studio
                  </Button>
                </Link>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-300 font-medium">
                Pipeline Progress ({PIPELINE_STAGE_LABELS[liveJob.stage] || liveJob.stage})
              </span>
              <span className="font-mono text-white tabular-nums">
                {liveJob.progressPercent}%
              </span>
            </div>
            <ProgressBar value={liveJob.progressPercent} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
            {PIPELINE_STAGES.map((st, idx) => {
              const done =
                liveJob.status === 'completed' ||
                (activeStageIdx > idx && activeStageIdx !== -1);
              const current = liveJob.status === 'processing' && liveJob.stage === st;
              return (
                <div
                  key={st}
                  className={cn(
                    'px-2.5 py-1.5 rounded-lg text-[11px] border flex items-center gap-1.5 truncate',
                    done &&
                      'bg-emerald-500/[0.08] border-emerald-500/25 text-emerald-300',
                    current &&
                      'bg-[#7C5CFF]/20 border-[#7C5CFF]/50 text-white font-medium',
                    !done &&
                      !current &&
                      'bg-[#0E0E14] border-white/[0.06] text-zinc-500'
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="w-3 h-3 shrink-0 text-emerald-400" />
                  ) : current ? (
                    <Clock className="w-3 h-3 shrink-0 animate-pulse text-[#38BDF8]" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 shrink-0" />
                  )}
                  <span className="truncate">{PIPELINE_STAGE_LABELS[st]}</span>
                </div>
              );
            })}
          </div>

          {liveJob.error && (
            <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 space-y-1">
              <div className="font-semibold">
                {liveJob.error.code}: {liveJob.error.message}
              </div>
              {liveJob.creditReservationReleased && (
                <div className="text-emerald-300">
                  100% of reserved credits ({liveJob.creditsReserved}) have been refunded
                  to your Credit Wallet.
                </div>
              )}
            </div>
          )}

          {/* GENERATED CLIPS INLINE PREVIEW & DOWNLOAD */}
          {liveJob.status === 'completed' && generatedClips.length > 0 && (
            <div className="pt-4 border-t border-white/10 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Film className="w-4 h-4 text-emerald-400" />
                  <h3 className="text-sm font-semibold text-white">
                    Generated Short Clips ({generatedClips.length})
                  </h3>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={downloadingBulk}
                  onClick={() =>
                    handleBulkZipDownload(generatedClips.map((c) => c._id))
                  }
                  leftIcon={<Download className="w-3.5 h-3.5" />}
                >
                  Download All (ZIP)
                </Button>
              </div>

              {selectedPreviewClip && selectedPreviewClip.previewUrl && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 rounded-2xl bg-[#0B0B11] border border-white/10">
                  <div className="lg:col-span-5 flex items-center justify-center bg-black rounded-xl overflow-hidden">
                    <video
                      key={selectedPreviewClip._id}
                      src={selectedPreviewClip.previewUrl}
                      poster={selectedPreviewClip.thumbnailUrl}
                      controls
                      playsInline
                      className="max-h-[360px] w-auto rounded-xl"
                    />
                  </div>
                  <div className="lg:col-span-7 flex flex-col justify-between space-y-3">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="brand">{selectedPreviewClip.aspectRatio}</Badge>
                        <Badge variant="success">
                          Score {selectedPreviewClip.engagementScore}/100
                        </Badge>
                        <span className="text-xs font-mono text-zinc-400">
                          Global Timestamp: {formatDuration(selectedPreviewClip.startSec)}{' '}
                          – {formatDuration(selectedPreviewClip.endSec)} (
                          {Math.round(selectedPreviewClip.durationSec)}s)
                        </span>
                      </div>
                      <h4 className="text-base font-semibold text-white">
                        {selectedPreviewClip.title}
                      </h4>
                      <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3">
                        {selectedPreviewClip.metadata?.descriptions?.youtubeShorts ||
                          selectedPreviewClip.transcript}
                      </p>
                      {selectedPreviewClip.metadata?.hashtags?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {selectedPreviewClip.metadata.hashtags
                            .slice(0, 6)
                            .map((tag) => (
                              <span
                                key={tag}
                                className="px-2 py-0.5 rounded-md bg-white/[0.04] text-[11px] text-[#38BDF8]"
                              >
                                {tag}
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5 pt-2">
                      {selectedPreviewClip.downloadUrl && (
                        <a href={selectedPreviewClip.downloadUrl}>
                          <Button
                            size="sm"
                            leftIcon={<Download className="w-3.5 h-3.5" />}
                          >
                            Download MP4 ({formatBytes(selectedPreviewClip.fileSizeBytes)})
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {generatedClips.map((clip, i) => {
                  const isSelected = selectedPreviewClip?._id === clip._id;
                  return (
                    <div
                      key={clip._id}
                      onClick={() => setSelectedPreviewClip(clip)}
                      className={cn(
                        'cursor-pointer rounded-xl p-3 border transition-all flex items-center gap-3',
                        isSelected
                          ? 'border-[#7C5CFF] bg-[#7C5CFF]/12'
                          : 'border-white/10 bg-[#0E0E15] hover:border-white/25'
                      )}
                    >
                      <div className="w-14 h-20 rounded-lg bg-zinc-900 overflow-hidden shrink-0 relative flex items-center justify-center">
                        {clip.thumbnailUrl ? (
                          <img
                            src={clip.thumbnailUrl}
                            alt={clip.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <Play className="w-4 h-4 text-zinc-400" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="text-xs font-semibold text-white truncate">
                          #{i + 1} {clip.title}
                        </div>
                        <div className="text-[11px] font-mono text-zinc-400">
                          {formatDuration(clip.startSec)} → {formatDuration(clip.endSec)}
                        </div>
                        <div className="flex items-center justify-between pt-0.5">
                          <span className="text-[11px] text-emerald-300">
                            Score {clip.engagementScore}
                          </span>
                          {clip.downloadUrl && (
                            <a
                              href={clip.downloadUrl}
                              onClick={(e) => e.stopPropagation()}
                              className="text-[11px] font-medium text-[#A58DFF] hover:underline"
                            >
                              MP4 ↓
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: SOURCE + CLIPPING + EDITOR SETTINGS */}
        <div className="lg:col-span-8 space-y-6">
          {/* 1. Video Source Card: Option A (Upload Video) & Option B (Import from Google Drive) */}
          <Card className="p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-white">1. Video Source</h2>
              <div className="inline-flex flex-wrap rounded-xl bg-[#0D0D12] p-1 border border-white/10 gap-1">
                <button
                  type="button"
                  onClick={() => setTab('upload')}
                  className={cn(
                    'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5',
                    tab === 'upload'
                      ? 'bg-[#7C5CFF] text-white'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  <Upload className="w-3.5 h-3.5" /> A. Upload Video
                </button>
                <button
                  type="button"
                  onClick={() => setTab('google_drive')}
                  className={cn(
                    'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5',
                    tab === 'google_drive'
                      ? 'bg-[#7C5CFF] text-white'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  <HardDrive className="w-3.5 h-3.5" /> B. Import from Google Drive
                </button>
              </div>
            </div>

            {tab === 'upload' ? (
              /* OPTION A: UPLOAD VIDEO */
              <div className="space-y-4">
                <Input
                  label="Project Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Founder Podcast Ep. 14 — Product Growth Insights"
                />
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragActive(false);
                    const dropped = e.dataTransfer.files?.[0];
                    if (dropped) inspectLocalVideoFile(dropped);
                  }}
                  className={cn(
                    'relative rounded-2xl border-2 border-dashed p-8 text-center transition-colors',
                    dragActive
                      ? 'border-[#7C5CFF] bg-[#7C5CFF]/10'
                      : 'border-white/12 bg-[#0E0E14] hover:border-white/25'
                  )}
                >
                  <input
                    id="video-file-input"
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
                    className="sr-only"
                    disabled={uploading}
                    onChange={(e) => {
                      const chosen = e.target.files?.[0];
                      if (chosen) inspectLocalVideoFile(chosen);
                    }}
                  />

                  {!file ? (
                    <label
                      htmlFor="video-file-input"
                      className="cursor-pointer block space-y-3"
                    >
                      <div className="w-12 h-12 rounded-2xl bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center text-[#A58DFF] mx-auto">
                        <FileVideo className="w-6 h-6" />
                      </div>
                      <div>
                        <span className="text-sm font-semibold text-white">
                          Drag & drop your video here, or{' '}
                          <span className="text-[#A58DFF] underline">browse files</span>
                        </span>
                        <p className="text-xs text-zinc-500 mt-1">
                          MP4, MOV, WebM, MKV up to {maxUploadMb} MB (up to{' '}
                          {Math.round(maxDurationSec / 3600)} hours chunked)
                        </p>
                      </div>
                    </label>
                  ) : (
                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-left">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-300 shrink-0">
                          <CheckCircle2 className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white truncate">
                            {file.name}
                          </div>
                          <div className="text-xs text-zinc-400">
                            {formatBytes(file.size)} • ~
                            {formatDuration(detectedDurationSec)} detected
                          </div>
                        </div>
                      </div>
                      {!uploading && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setFile(null)}
                          leftIcon={<X className="w-3.5 h-3.5" />}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {uploading && (
                  <div className="p-4 rounded-xl bg-[#0F0F17] border border-white/10 space-y-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-200 font-medium">
                        Uploading source video & validating media...
                      </span>
                      <span className="font-mono text-white">{uploadProgress}%</span>
                    </div>
                    <ProgressBar value={uploadProgress} />
                    <div className="flex justify-end">
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => abortRef.current?.abort()}
                      >
                        Cancel Upload
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* OPTION B: IMPORT FROM GOOGLE DRIVE (OFFICIAL GOOGLE PICKER FLOW) */
              <div className="space-y-4">
                {/* Step 1: Connect / Manage Google Drive Connection */}
                <div className="p-4 rounded-2xl bg-[#0E0E15] border border-white/10 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={cn(
                          'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0',
                          googleDriveConnected
                            ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                            : 'bg-[#7C5CFF]/15 border-[#7C5CFF]/35 text-[#A58DFF]'
                        )}
                      >
                        {googleDriveConnected ? (
                          <ShieldCheck className="w-5 h-5" />
                        ) : (
                          <HardDrive className="w-5 h-5" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-white">
                            Google Drive Account
                          </span>
                          <Badge variant={googleDriveConnected ? 'success' : 'default'}>
                            {googleDriveConnected ? 'Connected' : 'Not Connected'}
                          </Badge>
                        </div>
                        <p className="text-xs text-zinc-400 truncate mt-0.5">
                          {googleDriveConnected
                            ? `Signed in as ${googleStatus?.email || 'Google Account'} • Minimum scope (drive.file)`
                            : 'Connect your Google account to pick individual video files securely via Google Picker.'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {!googleDriveConnected ? (
                        <Button
                          size="sm"
                          loading={connectingGoogle}
                          onClick={handleConnectGoogleDrive}
                          leftIcon={<Link2 className="w-3.5 h-3.5" />}
                        >
                          Connect Google Drive
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={disconnectingGoogle}
                          onClick={handleDisconnectGoogleDrive}
                          leftIcon={<Unlink className="w-3.5 h-3.5" />}
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </div>

                  {googleStatus && !googleStatus.oauthConfigured && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>
                        Set <code className="font-mono">GOOGLE_CLIENT_ID</code>,{' '}
                        <code className="font-mono">GOOGLE_CLIENT_SECRET</code>,{' '}
                        <code className="font-mono">GOOGLE_REDIRECT_URI</code>,{' '}
                        <code className="font-mono">GOOGLE_API_KEY</code>, and{' '}
                        <code className="font-mono">GOOGLE_PROJECT_NUMBER</code> in{' '}
                        <code className="font-mono">.env</code> to enable Google OAuth &
                        Google Picker.
                      </span>
                    </div>
                  )}
                </div>

                {/* Steps 2, 3, 4 & 5: Open Google Picker -> Select Video -> Display Selected Video Info */}
                {googleDriveConnected && (
                  <div className="rounded-2xl border-2 border-dashed border-white/12 bg-[#0E0E14] p-6 space-y-4">
                    {!selectedDriveFile ? (
                      <div className="text-center space-y-3 py-2">
                        <div className="w-12 h-12 rounded-2xl bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center text-[#A58DFF] mx-auto">
                          <FolderOpen className="w-6 h-6" />
                        </div>
                        <div className="space-y-1">
                          <h3 className="text-sm font-semibold text-white">
                            Select a Video from Your Google Drive
                          </h3>
                          <p className="text-xs text-zinc-400 max-w-md mx-auto">
                            Opens the official Google Picker filtered to MP4, MOV, WebM,
                            and MKV videos. Only the single file you select is shared with
                            ClipForge AI.
                          </p>
                        </div>
                        <div className="pt-1">
                          <Button
                            onClick={handleOpenGooglePicker}
                            loading={openingPicker || verifyingSelection}
                            leftIcon={<FolderOpen className="w-4 h-4" />}
                          >
                            {verifyingSelection
                              ? 'Verifying Selected Video...'
                              : 'Select Video from Drive'}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      /* Step 5: Selected Google Drive Video Information Card */
                      <div className="space-y-4">
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                          <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                            <div className="w-20 h-14 rounded-xl bg-zinc-900 border border-white/10 overflow-hidden shrink-0 flex items-center justify-center">
                              {selectedDriveFile.thumbnailUrl ? (
                                <img
                                  src={selectedDriveFile.thumbnailUrl}
                                  alt={selectedDriveFile.name}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <FileVideo className="w-6 h-6 text-[#A58DFF]" />
                              )}
                            </div>

                            <div className="min-w-0 space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-white truncate max-w-[340px]">
                                  {selectedDriveFile.name}
                                </span>
                                <Badge variant="success">Verified</Badge>
                              </div>
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                                <span>
                                  Size:{' '}
                                  <strong className="text-zinc-200">
                                    {selectedDriveFile.sizeBytes
                                      ? formatBytes(selectedDriveFile.sizeBytes)
                                      : 'Streamed'}
                                  </strong>
                                </span>
                                <span>•</span>
                                <span>
                                  Type:{' '}
                                  <strong className="text-zinc-200 font-mono text-[11px]">
                                    {selectedDriveFile.mimeType}
                                  </strong>
                                </span>
                                {selectedDriveFile.durationSec ? (
                                  <>
                                    <span>•</span>
                                    <span>
                                      Duration:{' '}
                                      <strong className="text-zinc-200">
                                        {formatDuration(selectedDriveFile.durationSec)}
                                      </strong>
                                    </span>
                                  </>
                                ) : null}
                                {selectedDriveFile.width && selectedDriveFile.height ? (
                                  <>
                                    <span>•</span>
                                    <span>
                                      {selectedDriveFile.width}×{selectedDriveFile.height}
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={openingPicker || verifyingSelection}
                              onClick={handleOpenGooglePicker}
                              leftIcon={<FolderOpen className="w-3.5 h-3.5" />}
                            >
                              Change Video
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setSelectedDriveFile(null);
                                setDriveChunkPlan(null);
                              }}
                              leftIcon={<X className="w-3.5 h-3.5" />}
                            >
                              Clear
                            </Button>
                          </div>
                        </div>

                        {driveChunkPlan?.enabled && (
                          <div className="p-3 rounded-xl bg-[#7C5CFF]/10 border border-[#7C5CFF]/30 flex items-center gap-2.5 text-xs text-zinc-200">
                            <Layers className="w-4 h-4 text-[#A58DFF] shrink-0" />
                            <span>
                              Long-video chunked processing active (~
                              {driveChunkPlan.estimatedChunks} chunks ×{' '}
                              {Math.round(driveChunkPlan.chunkDurationSec / 60)} min with{' '}
                              {driveChunkPlan.chunkOverlapSec}s overlap deduplication &
                              global timestamps).
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <Input
                  label="Project Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Auto-filled when you select a video from Google Drive"
                />
              </div>
            )}
          </Card>

          {/* 2. Clip Generation Parameters */}
          <Card className="p-6 space-y-5">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-[#A58DFF]" />
              <h2 className="text-base font-semibold text-white">
                2. Clip Generation & Framing Rules
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <Select
                label="Clip Duration Window"
                value={settings.durationPreset}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    durationPreset: e.target
                      .value as ProjectProcessingSettings['durationPreset'],
                  })
                }
                options={DURATION_PRESETS.map((d) => ({ value: d.id, label: d.label }))}
              />

              <Select
                label="Number of Clips"
                value={String(settings.clipCount)}
                onChange={(e) =>
                  setSettings({ ...settings, clipCount: Number(e.target.value) })
                }
                options={[1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({
                  value: String(n),
                  label: `${n} unique ${n === 1 ? 'clip' : 'clips'}`,
                }))}
              />

              <Select
                label="Aspect Ratio & Reframing"
                value={settings.aspectRatio}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    aspectRatio: e.target
                      .value as ProjectProcessingSettings['aspectRatio'],
                  })
                }
                options={ASPECT_RATIOS.map((r) => ({
                  value: r,
                  label:
                    r === '9:16'
                      ? '9:16 Vertical (Shorts / Reels / TikTok)'
                      : r === '1:1'
                        ? '1:1 Square (Feed)'
                        : '16:9 Landscape',
                }))}
              />

              {settings.durationPreset === 'custom' && (
                <>
                  <Input
                    label="Custom Min Seconds"
                    type="number"
                    min={5}
                    max={170}
                    value={settings.customMinDuration}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        customMinDuration: Number(e.target.value),
                      })
                    }
                  />
                  <Input
                    label="Custom Max Seconds"
                    type="number"
                    min={10}
                    max={180}
                    value={settings.customMaxDuration}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        customMaxDuration: Number(e.target.value),
                      })
                    }
                  />
                </>
              )}

              <Select
                label="Speech Language"
                value={settings.language}
                onChange={(e) => setSettings({ ...settings, language: e.target.value })}
                options={[
                  { value: 'en', label: 'English (en)' },
                  { value: 'hi', label: 'Hindi (hi)' },
                  { value: 'es', label: 'Spanish (es)' },
                  { value: 'fr', label: 'French (fr)' },
                  { value: 'auto', label: 'Auto-detect' },
                ]}
              />

              <Select
                label="Editing Intensity"
                value={settings.editingIntensity}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    editingIntensity: e.target
                      .value as ProjectProcessingSettings['editingIntensity'],
                  })
                }
                options={EDITING_INTENSITIES.map((i) => ({
                  value: i,
                  label: i.charAt(0).toUpperCase() + i.slice(1),
                }))}
              />

              <Select
                label="Long-Video Chunk Window"
                value={String(settings.chunkDurationSec || 600)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    chunkDurationSec: Number(e.target.value),
                  })
                }
                options={[
                  { value: '300', label: '5-minute chunks' },
                  { value: '600', label: '10-minute chunks (Default)' },
                  { value: '900', label: '15-minute chunks' },
                  { value: '1800', label: '30-minute chunks' },
                ]}
              />
            </div>
          </Card>

          {/* 3. Captions & Audio / Visual Studio */}
          <Card className="p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Captions className="w-4 h-4 text-[#38BDF8]" />
                <h2 className="text-base font-semibold text-white">
                  3. Animated Subtitles & Audio Mastering
                </h2>
              </div>
              <Switch
                checked={settings.captionStyle.enabled}
                onChange={(v) => updateCaption('enabled', v)}
                label="Burn Subtitles"
              />
            </div>

            {settings.captionStyle.enabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2 border-t border-white/[0.07]">
                <Select
                  label="Font Family"
                  value={settings.captionStyle.font}
                  onChange={(e) => updateCaption('font', e.target.value)}
                  options={[
                    { value: 'DejaVu Sans Bold', label: 'Studio Sans Bold' },
                    { value: 'DejaVu Sans', label: 'Clean Sans Regular' },
                    { value: 'DejaVu Sans Mono', label: 'Creator Mono' },
                  ]}
                />
                <Input
                  label="Font Size (px)"
                  type="number"
                  min={24}
                  max={72}
                  value={settings.captionStyle.fontSize}
                  onChange={(e) => updateCaption('fontSize', Number(e.target.value))}
                />
                <Select
                  label="Vertical Placement"
                  value={settings.captionStyle.position}
                  onChange={(e) =>
                    updateCaption(
                      'position',
                      e.target.value as ProjectProcessingSettings['captionStyle']['position']
                    )
                  }
                  options={CAPTION_POSITIONS.map((p) => ({
                    value: p,
                    label: p.charAt(0).toUpperCase() + p.slice(1),
                  }))}
                />
                <Select
                  label="Animation Mode"
                  value={settings.captionStyle.animation}
                  onChange={(e) =>
                    updateCaption(
                      'animation',
                      e.target
                        .value as ProjectProcessingSettings['captionStyle']['animation']
                    )
                  }
                  options={CAPTION_ANIMATIONS.map((a) => ({
                    value: a,
                    label: a.replace('_', ' ').toUpperCase(),
                  }))}
                />
                <Input
                  label="Primary Text Color"
                  type="color"
                  value={settings.captionStyle.textColor}
                  onChange={(e) => updateCaption('textColor', e.target.value)}
                  className="h-10 p-1 cursor-pointer"
                />
                <Input
                  label="Active Word Highlight"
                  type="color"
                  value={settings.captionStyle.highlightColor}
                  onChange={(e) => updateCaption('highlightColor', e.target.value)}
                  className="h-10 p-1 cursor-pointer"
                />
              </div>
            )}

            <div className="pt-4 border-t border-white/[0.07] space-y-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" /> Audio, Effects &
                Branding
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Switch
                  checked={settings.audioNormalization}
                  onChange={(v) => setSettings({ ...settings, audioNormalization: v })}
                  label="EBU R128 Audio Normalization"
                  description="Target -16 LUFS broadcast loudness"
                />
                <Switch
                  checked={settings.noiseReduction}
                  onChange={(v) => setSettings({ ...settings, noiseReduction: v })}
                  label="FFT Noise Reduction"
                  description="Suppress background room hum"
                />
                <Switch
                  checked={settings.silenceRemovalEnabled}
                  onChange={(v) =>
                    setSettings({ ...settings, silenceRemovalEnabled: v })
                  }
                  label="Smart Dead-Air Trimming"
                  description={`Threshold: ${settings.silenceThresholdDb} dB`}
                />
                <Switch
                  checked={settings.zoomEffects}
                  onChange={(v) => setSettings({ ...settings, zoomEffects: v })}
                  label="Subtle Dynamic Zoom & Fade"
                  description="Smooth hook emphasis transitions"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <Select
                  label="Licensed Ambient Music Bed"
                  value={settings.backgroundMusic}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      backgroundMusic: e.target
                        .value as ProjectProcessingSettings['backgroundMusic'],
                    })
                  }
                  options={[
                    { value: 'none', label: 'None (Original Speech Only)' },
                    { value: 'ambient_focus', label: 'Ambient Studio Pad (-22 dB)' },
                    { value: 'subtle_pulse', label: 'Warm Harmonic Pulse (-22 dB)' },
                  ]}
                />
                <Input
                  label="Brand Watermark Text (Optional)"
                  value={settings.watermarkText}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      watermarkText: e.target.value,
                      watermarkEnabled: e.target.value.trim().length > 0,
                    })
                  }
                  placeholder="@YourChannel"
                />
                <Input
                  label="Intro Lower-Third Banner (Optional)"
                  value={settings.introText}
                  onChange={(e) =>
                    setSettings({ ...settings, introText: e.target.value })
                  }
                  placeholder="Shown during opening 2s"
                />
                <Input
                  label="Outro Callout Text (Optional)"
                  value={settings.outroText}
                  onChange={(e) =>
                    setSettings({ ...settings, outroText: e.target.value })
                  }
                  placeholder="Follow for Part 2"
                />
              </div>
            </div>
          </Card>
        </div>

        {/* RIGHT COLUMN: LIVE PREVIEW + CREDIT SUMMARY + GENERATE CLIPS */}
        <div className="lg:col-span-4 space-y-5 lg:sticky lg:top-24">
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Live Frame & Caption Preview
              </span>
              <Badge variant="brand">{settings.aspectRatio}</Badge>
            </div>

            <div className="rounded-xl bg-[#0B0B10] border border-white/10 p-4 flex items-center justify-center min-h-[250px] studio-grid-bg">
              <div
                className={cn(
                  'relative rounded-xl border border-white/15 bg-gradient-to-b from-[#1C1C29] to-[#0D0D14] p-3 flex flex-col justify-between overflow-hidden shadow-lg transition-all',
                  settings.aspectRatio === '9:16' && 'w-[150px] h-[250px]',
                  settings.aspectRatio === '1:1' && 'w-[200px] h-[200px]',
                  settings.aspectRatio === '16:9' && 'w-full h-[160px]'
                )}
              >
                <div className="flex items-center justify-between text-[9px] text-zinc-400 font-mono">
                  <span>{settings.watermarkText || 'NO WATERMARK'}</span>
                  <span>{settings.editingIntensity.toUpperCase()}</span>
                </div>

                {settings.captionStyle.enabled && (
                  <div
                    className={cn(
                      'w-full text-center px-2 py-1.5 rounded-lg border border-white/10',
                      settings.captionStyle.position === 'top' && 'mb-auto mt-2',
                      settings.captionStyle.position === 'middle' && 'my-auto',
                      settings.captionStyle.position === 'bottom' && 'mt-auto mb-1'
                    )}
                    style={{
                      backgroundColor: `rgba(9, 9, 11, ${settings.captionStyle.backgroundOpacity})`,
                    }}
                  >
                    <span
                      className="text-[11px] font-bold leading-tight"
                      style={{ color: settings.captionStyle.textColor }}
                    >
                      Smart clips keep{' '}
                      <span style={{ color: settings.captionStyle.highlightColor }}>
                        complete
                      </span>{' '}
                      context
                    </span>
                  </div>
                )}
              </div>
            </div>
          </Card>

          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-white flex items-center gap-2">
                <Coins className="w-4 h-4 text-[#A58DFF]" /> Credit Reservation
              </span>
              <span className="text-xs text-zinc-400 tabular-nums">
                Balance: <strong className="text-white">{availableCredits}</strong>
              </span>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0D0D13] border border-white/[0.08] space-y-2 text-xs">
              <div className="flex justify-between text-zinc-400">
                <span>Estimated job reservation</span>
                <span className="font-semibold text-white tabular-nums">
                  {estimatedCredits} credits
                </span>
              </div>
              <div className="flex justify-between text-zinc-500">
                <span>Source duration</span>
                <span>{formatDuration(effectiveDurationForCalc)}</span>
              </div>
              <div className="flex justify-between text-zinc-500">
                <span>Target output count</span>
                <span>{settings.clipCount} clips</span>
              </div>
              <p className="text-[11px] text-zinc-500 pt-1 border-t border-white/[0.06]">
                Credits are reserved upfront and deducted only after all clips render and
                validate. Failed or cancelled jobs automatically refund 100% of reserved
                credits.
              </p>
            </div>

            {!hasEnoughCredits && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5 text-xs text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  Insufficient available credits ({availableCredits} available,{' '}
                  {estimatedCredits} needed). Visit Credit Wallet to add credits.
                </div>
              </div>
            )}

            {tab === 'google_drive' ? (
              <Button
                className="w-full"
                size="lg"
                disabled={
                  !googleDriveConnected ||
                  !selectedDriveFile ||
                  startingDriveImport ||
                  verifyingSelection ||
                  !hasEnoughCredits
                }
                loading={startingDriveImport}
                onClick={handleGoogleDriveGenerateStart}
                leftIcon={<Sparkles className="w-4 h-4" />}
              >
                Generate Clips
              </Button>
            ) : (
              <Button
                className="w-full"
                size="lg"
                disabled={!file || uploading || !hasEnoughCredits}
                loading={uploading}
                onClick={handleUploadStart}
                leftIcon={<Sparkles className="w-4 h-4" />}
              >
                Upload & Generate Clips
              </Button>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
