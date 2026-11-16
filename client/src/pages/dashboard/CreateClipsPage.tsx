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
  Globe,
  Layers,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  StopCircle,
  Upload,
  Volume2,
  X,
  Youtube,
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
import type { ClipItem, UrlCheckResult, YouTubeFetchResponse } from '../../types/api';
import { formatBytes, formatDuration } from '../../utils/format';
import { cn } from '../../utils/cn';
import { useWalletRefresh } from '../../hooks/useWalletRefresh';

type SourceTab = 'youtube' | 'upload' | 'url';

export const CreateClipsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const { wallet } = useAuthStore();
  const refreshWallet = useWalletRefresh();

  const paramTab = searchParams.get('tab');
  const initialUrl = searchParams.get('url') || '';
  const initialTab: SourceTab =
    paramTab === 'upload'
      ? 'upload'
      : paramTab === 'url'
      ? 'url'
      : paramTab === 'youtube' || /youtu\.?be/i.test(initialUrl)
      ? 'youtube'
      : 'youtube';

  const [tab, setTab] = useState<SourceTab>(initialTab);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Upload progress & cancellation
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Direct URL import state
  const [sourceUrl, setSourceUrl] = useState(
    initialTab === 'url' ? initialUrl : ''
  );
  const [checkingUrl, setCheckingUrl] = useState(false);
  const [urlCheck, setUrlCheck] = useState<UrlCheckResult | null>(null);
  const [importingUrl, setImportingUrl] = useState(false);

  // Dedicated YouTube Link-to-Clips state
  const [youtubeUrl, setYoutubeUrl] = useState(
    initialTab === 'youtube' ? initialUrl : ''
  );
  const [authorizedMediaUrl, setAuthorizedMediaUrl] = useState('');
  const [showAuthorizedOverride, setShowAuthorizedOverride] = useState(false);
  const [fetchingYouTube, setFetchingYouTube] = useState(false);
  const [ytFetchError, setYtFetchError] = useState<string | null>(null);
  const [ytReport, setYtReport] = useState<YouTubeFetchResponse | null>(null);
  const [startingYouTubeJob, setStartingYouTubeJob] = useState(false);

  // Live inline processing & generated clips preview/download state
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [selectedPreviewClip, setSelectedPreviewClip] = useState<ClipItem | null>(null);
  const [downloadingBulk, setDownloadingBulk] = useState(false);

  // Processing & editing settings
  const [settings, setSettings] = useState<ProjectProcessingSettings>(DEFAULT_PROCESSING_SETTINGS);
  const [detectedDurationSec, setDetectedDurationSec] = useState<number>(60);

  const capsQuery = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: () => api.jobs.capabilities(),
  });

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
    if (liveJobQuery.data?.job.status === 'completed' || liveJobQuery.data?.job.status === 'failed') {
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
    tab === 'youtube' && ytReport?.video.durationSec
      ? ytReport.video.durationSec
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
            description: `Maximum supported video length is ${Math.round(maxDurationSec / 3600)} hours.`,
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

  const handleFetchYouTube = async () => {
    if (!youtubeUrl.trim()) {
      pushToast({ type: 'warning', title: 'Paste a YouTube video URL first' });
      return;
    }
    setFetchingYouTube(true);
    setYtFetchError(null);
    setYtReport(null);
    try {
      const report = await api.youtube.fetchVideo({
        url: youtubeUrl.trim(),
        authorizedMediaUrl: authorizedMediaUrl.trim() || undefined,
      });
      setYtReport(report);
      if (report.video.title) {
        setTitle(report.video.title);
      }
      if (report.video.durationSec) {
        setDetectedDurationSec(report.video.durationSec);
      }
    } catch (err: any) {
      const msg = err?.message || 'Could not fetch YouTube video details.';
      setYtFetchError(msg);
      pushToast({
        type: 'error',
        title: 'YouTube verification failed',
        description: msg,
      });
    } finally {
      setFetchingYouTube(false);
    }
  };

  const handleYouTubeGenerateStart = async () => {
    if (!youtubeUrl.trim()) return;
    setStartingYouTubeJob(true);
    setSelectedPreviewClip(null);
    try {
      const res = await api.youtube.generateClips({
        url: youtubeUrl.trim(),
        title: title.trim() || ytReport?.video.title || undefined,
        authorizedMediaUrl: authorizedMediaUrl.trim() || undefined,
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
        title: 'YouTube processing job started',
        description: 'Live chunked transcription & AI moment analysis is now running below.',
      });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Could not start YouTube clip generation',
        description: err?.message || 'Verify authorized media access and wallet credits.',
      });
    } finally {
      setStartingYouTubeJob(false);
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
      pushToast({ type: 'error', title: 'Bulk download failed', description: err?.message });
    } finally {
      setDownloadingBulk(false);
    }
  };

  const handleCheckUrl = async () => {
    if (!sourceUrl.trim()) return;
    setCheckingUrl(true);
    setUrlCheck(null);
    try {
      const res = await api.videos.checkUrl(sourceUrl.trim());
      setUrlCheck(res);
      if (res.metadata?.title && !title.trim()) {
        setTitle(res.metadata.title);
      }
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Invalid URL',
        description: err?.message || 'Unable to verify video URL',
      });
    } finally {
      setCheckingUrl(false);
    }
  };

  const handleUploadStart = async () => {
    if (!file) {
      pushToast({ type: 'warning', title: 'Select a video file first' });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setUploading(true);
    setUploadProgress(0);

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
      pushToast({
        type: 'success',
        title: 'Video uploaded & pipeline started',
        description: 'Redirecting to your project studio...',
      });
      navigate(`/dashboard/projects/${res.project._id}`);
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

  const handleImportUrlStart = async () => {
    if (!sourceUrl.trim()) return;
    setImportingUrl(true);
    try {
      const res = await api.videos.importUrl({
        title: title.trim() || 'Imported Video Project',
        url: sourceUrl.trim(),
        settings,
        autoStart: true,
      });
      await refreshWallet();
      pushToast({
        type: 'success',
        title: 'Media imported & queued',
        description: 'Processing has started in the background worker.',
      });
      navigate(`/dashboard/projects/${res.project._id}`);
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'URL import unavailable',
        description: err?.message || 'Use direct file upload instead.',
      });
    } finally {
      setImportingUrl(false);
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
          <h1 className="text-2xl font-bold text-white tracking-tight">Create Short Clips</h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Paste a YouTube link (up to 10 hours with chunked AI processing), upload a video file,
            or import a direct MP4 stream.
          </p>
        </div>
        <Badge variant="brand">Up to 10h Chunked Pipeline</Badge>
      </div>

      {/* LIVE REAL-TIME PROCESSING STATUS & GENERATED CLIPS PREVIEW / DOWNLOAD */}
      {liveJob && (
        <Card className="p-6 border-[#7C5CFF]/45 bg-[#12121C] space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-base font-semibold text-white">
                  {title || ytReport?.video.title || 'YouTube AI Clip Generation'}
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
                {PIPELINE_STAGE_LABELS[liveJob.stage] || liveJob.stage} — {liveJob.currentMessage}
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
              <span className="font-mono text-white tabular-nums">{liveJob.progressPercent}%</span>
            </div>
            <ProgressBar value={liveJob.progressPercent} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5">
            {PIPELINE_STAGES.map((st, idx) => {
              const done =
                liveJob.status === 'completed' || (activeStageIdx > idx && activeStageIdx !== -1);
              const current = liveJob.status === 'processing' && liveJob.stage === st;
              return (
                <div
                  key={st}
                  className={cn(
                    'px-2.5 py-1.5 rounded-lg text-[11px] border flex items-center gap-1.5 truncate',
                    done && 'bg-emerald-500/[0.08] border-emerald-500/25 text-emerald-300',
                    current && 'bg-[#7C5CFF]/20 border-[#7C5CFF]/50 text-white font-medium',
                    !done && !current && 'bg-[#0E0E14] border-white/[0.06] text-zinc-500'
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
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
                  100% of reserved credits ({liveJob.creditsReserved}) have been refunded to your
                  Credit Wallet.
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
                  onClick={() => handleBulkZipDownload(generatedClips.map((c) => c._id))}
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
                          Global Timestamp: {formatDuration(selectedPreviewClip.startSec)} –{' '}
                          {formatDuration(selectedPreviewClip.endSec)} (
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
                          {selectedPreviewClip.metadata.hashtags.slice(0, 6).map((tag) => (
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
                          <Button size="sm" leftIcon={<Download className="w-3.5 h-3.5" />}>
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
          {/* 1. Source Video Card */}
          <Card className="p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-white">1. Video Source</h2>
              <div className="inline-flex flex-wrap rounded-xl bg-[#0D0D12] p-1 border border-white/10 gap-1">
                <button
                  type="button"
                  onClick={() => setTab('youtube')}
                  className={cn(
                    'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5',
                    tab === 'youtube'
                      ? 'bg-[#7C5CFF] text-white'
                      : 'text-zinc-400 hover:text-white'
                  )}
                >
                  <Youtube className="w-3.5 h-3.5" /> YouTube Link
                </button>
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
                  <Upload className="w-3.5 h-3.5" /> Direct Upload
                </button>
                <button
                  type="button"
                  onClick={() => setTab('url')}
                  className={cn(
                    'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5',
                    tab === 'url' ? 'bg-[#7C5CFF] text-white' : 'text-zinc-400 hover:text-white'
                  )}
                >
                  <Globe className="w-3.5 h-3.5" /> Direct Media URL
                </button>
              </div>
            </div>

            {tab === 'youtube' ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-zinc-300">
                    Paste YouTube Video URL
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <div className="flex-1">
                      <Input
                        value={youtubeUrl}
                        onChange={(e) => {
                          setYoutubeUrl(e.target.value);
                          setYtReport(null);
                          setYtFetchError(null);
                        }}
                        placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      loading={fetchingYouTube}
                      onClick={handleFetchYouTube}
                      leftIcon={<Youtube className="w-4 h-4" />}
                    >
                      Fetch Video
                    </Button>
                  </div>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setShowAuthorizedOverride((v) => !v)}
                    className="text-[11px] text-zinc-400 hover:text-white underline"
                  >
                    {showAuthorizedOverride
                      ? 'Hide owner-authorized media export URL'
                      : '+ Have a signed owner-authorized media export URL? (Optional)'}
                  </button>
                  {showAuthorizedOverride && (
                    <div className="mt-2">
                      <Input
                        value={authorizedMediaUrl}
                        onChange={(e) => {
                          setAuthorizedMediaUrl(e.target.value);
                          setYtReport(null);
                        }}
                        placeholder="https://storage.example.com/owner-exports/episode.mp4"
                      />
                    </div>
                  )}
                </div>

                {ytFetchError && (
                  <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <div className="font-semibold">Unable to fetch YouTube video</div>
                      <div>{ytFetchError}</div>
                    </div>
                  </div>
                )}

                {ytReport && (
                  <div className="rounded-2xl border border-white/12 bg-[#0D0D14] p-4 space-y-4">
                    <div className="flex flex-col sm:flex-row gap-4">
                      <div className="relative w-full sm:w-52 aspect-video rounded-xl overflow-hidden bg-zinc-900 border border-white/10 shrink-0">
                        <img
                          src={ytReport.video.thumbnailUrl}
                          alt={ytReport.video.title}
                          className="w-full h-full object-cover"
                        />
                        {ytReport.video.durationSec !== null && (
                          <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/85 text-[11px] font-mono text-white">
                            {formatDuration(ytReport.video.durationSec)}
                          </span>
                        )}
                      </div>

                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="brand">ID: {ytReport.video.videoId}</Badge>
                          <Badge
                            variant={ytReport.mediaAccess.available ? 'success' : 'warning'}
                          >
                            {ytReport.mediaAccess.available
                              ? `Media Ready (${ytReport.mediaAccess.adapterName})`
                              : 'Media Source Required'}
                          </Badge>
                          {ytReport.chunkPlan.enabled && (
                            <Badge variant="brand">
                              <Layers className="w-3 h-3 mr-1 inline" />
                              {ytReport.chunkPlan.estimatedChunks} Chunks
                            </Badge>
                          )}
                        </div>

                        <h3 className="text-sm sm:text-base font-semibold text-white leading-snug">
                          {ytReport.video.title}
                        </h3>

                        <div className="text-xs text-zinc-400 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <span>
                            Channel:{' '}
                            <strong className="text-zinc-200">
                              {ytReport.video.channelName}
                            </strong>
                          </span>
                          <span>
                            Duration:{' '}
                            <strong className="text-zinc-200">
                              {ytReport.video.durationSec !== null
                                ? formatDuration(ytReport.video.durationSec)
                                : 'Probed on import'}
                            </strong>
                          </span>
                        </div>

                        {ytReport.chunkPlan.enabled && (
                          <p className="text-[11px] text-emerald-300/90">
                            Long-video chunk processing enabled ({ytReport.chunkPlan.estimatedChunks}{' '}
                            chunks × {Math.round(ytReport.chunkPlan.chunkDurationSec / 60)}m, constant
                            RAM, checkpoint-recoverable up to 10 hours).
                          </p>
                        )}
                      </div>
                    </div>

                    {!ytReport.mediaAccess.available && (
                      <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-2">
                        <div className="font-semibold flex items-center gap-1.5">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          Metadata verified — Authorized media stream required to render clips
                        </div>
                        <p className="text-amber-100/85 leading-relaxed">
                          {ytReport.mediaAccess.reason}
                        </p>
                        {ytReport.mediaAccess.setupInstructions && (
                          <p className="text-[11px] text-zinc-300 font-mono bg-black/30 p-2 rounded-lg">
                            {ytReport.mediaAccess.setupInstructions}
                          </p>
                        )}
                        <div className="flex flex-wrap gap-2 pt-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setTab('upload')}
                            leftIcon={<Upload className="w-3.5 h-3.5" />}
                          >
                            Upload Local Video File Instead
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <Input
                  label="Project Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Auto-filled after clicking Fetch Video"
                />
              </div>
            ) : tab === 'upload' ? (
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
                    <label htmlFor="video-file-input" className="cursor-pointer block space-y-3">
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
                          <div className="text-sm font-medium text-white truncate">{file.name}</div>
                          <div className="text-xs text-zinc-400">
                            {formatBytes(file.size)} • ~{formatDuration(detectedDurationSec)}{' '}
                            detected
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
              <div className="space-y-4">
                <Input
                  label="Project Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Webinar Archive Recording"
                />
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="flex-1">
                    <Input
                      value={sourceUrl}
                      onChange={(e) => {
                        setSourceUrl(e.target.value);
                        setUrlCheck(null);
                      }}
                      placeholder="https://cdn.example.com/podcast-episode.mp4"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={checkingUrl}
                    onClick={handleCheckUrl}
                  >
                    Validate URL
                  </Button>
                </div>

                <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.07] text-xs text-zinc-400 leading-relaxed">
                  <strong className="text-zinc-200">Direct Media Streams:</strong> Paste a public
                  HTTPS `.mp4` or `.webm` link, or switch to the{' '}
                  <button
                    type="button"
                    onClick={() => setTab('youtube')}
                    className="text-[#A58DFF] underline"
                  >
                    YouTube Link
                  </button>{' '}
                  tab for YouTube URLs.
                </div>

                {urlCheck && (
                  <div
                    className={cn(
                      'p-4 rounded-xl border space-y-2.5',
                      urlCheck.importableDirectly
                        ? 'bg-emerald-500/[0.07] border-emerald-500/30'
                        : 'bg-amber-500/[0.07] border-amber-500/30'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={urlCheck.importableDirectly ? 'success' : 'warning'}>
                        {urlCheck.platform.toUpperCase()}
                      </Badge>
                      {urlCheck.metadata?.contentLengthBytes ? (
                        <span className="text-xs text-zinc-400">
                          {formatBytes(urlCheck.metadata.contentLengthBytes)}
                        </span>
                      ) : null}
                    </div>
                    {urlCheck.metadata?.title && (
                      <div className="text-xs font-semibold text-white">
                        Detected title: {urlCheck.metadata.title}
                      </div>
                    )}
                    <p className="text-xs text-zinc-300 leading-relaxed">{urlCheck.reason}</p>
                    {!urlCheck.importableDirectly && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setTab('upload')}
                        leftIcon={<Upload className="w-3.5 h-3.5" />}
                      >
                        Switch to Direct Video Upload
                      </Button>
                    )}
                  </div>
                )}
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
                    durationPreset: e.target.value as ProjectProcessingSettings['durationPreset'],
                  })
                }
                options={DURATION_PRESETS.map((d) => ({ value: d.id, label: d.label }))}
              />

              <Select
                label="Number of Clips"
                value={String(settings.clipCount)}
                onChange={(e) => setSettings({ ...settings, clipCount: Number(e.target.value) })}
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
                    aspectRatio: e.target.value as ProjectProcessingSettings['aspectRatio'],
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
                      setSettings({ ...settings, customMinDuration: Number(e.target.value) })
                    }
                  />
                  <Input
                    label="Custom Max Seconds"
                    type="number"
                    min={10}
                    max={180}
                    value={settings.customMaxDuration}
                    onChange={(e) =>
                      setSettings({ ...settings, customMaxDuration: Number(e.target.value) })
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
                    editingIntensity: e.target.value as ProjectProcessingSettings['editingIntensity'],
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
                      e.target.value as ProjectProcessingSettings['captionStyle']['animation']
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
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" /> Audio, Effects & Branding
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
                  onChange={(v) => setSettings({ ...settings, silenceRemovalEnabled: v })}
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
                  onChange={(e) => setSettings({ ...settings, introText: e.target.value })}
                  placeholder="Shown during opening 2s"
                />
                <Input
                  label="Outro Callout Text (Optional)"
                  value={settings.outroText}
                  onChange={(e) => setSettings({ ...settings, outroText: e.target.value })}
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
                      <span style={{ color: settings.captionStyle.highlightColor }}>complete</span>{' '}
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
                Credits are reserved upfront and deducted only after all clips render and validate.
                Failed or cancelled jobs automatically refund 100% of reserved credits.
              </p>
            </div>

            {!hasEnoughCredits && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-2.5 text-xs text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  Insufficient available credits ({availableCredits} available, {estimatedCredits}{' '}
                  needed). Visit Credit Wallet to add credits.
                </div>
              </div>
            )}

            {tab === 'youtube' ? (
              <Button
                className="w-full"
                size="lg"
                disabled={
                  !youtubeUrl.trim() ||
                  startingYouTubeJob ||
                  !hasEnoughCredits ||
                  (ytReport !== null && !ytReport.mediaAccess.available)
                }
                loading={startingYouTubeJob}
                onClick={handleYouTubeGenerateStart}
                leftIcon={<Sparkles className="w-4 h-4" />}
              >
                Generate Clips
              </Button>
            ) : tab === 'upload' ? (
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
            ) : (
              <Button
                className="w-full"
                size="lg"
                disabled={
                  !sourceUrl.trim() ||
                  importingUrl ||
                  !hasEnoughCredits ||
                  (urlCheck !== null && !urlCheck.importableDirectly)
                }
                loading={importingUrl}
                onClick={handleImportUrlStart}
                leftIcon={<Sparkles className="w-4 h-4" />}
              >
                Import URL & Generate Clips
              </Button>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
