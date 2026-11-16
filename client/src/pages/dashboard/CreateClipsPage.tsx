import React, { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Captions,
  CheckCircle2,
  Coins,
  FileVideo,
  Globe,
  Sliders,
  Sparkles,
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
import type { UrlCheckResult } from '../../types/api';
import { formatBytes } from '../../utils/format';
import { cn } from '../../utils/cn';
import { useWalletRefresh } from '../../hooks/useWalletRefresh';

export const CreateClipsPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);
  const { wallet } = useAuthStore();
  const refreshWallet = useWalletRefresh();

  const initialTab = searchParams.get('tab') === 'url' ? 'url' : 'upload';
  const initialUrl = searchParams.get('url') || '';

  const [tab, setTab] = useState<'upload' | 'url'>(initialTab);
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Upload progress & cancellation
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // URL import state
  const [sourceUrl, setSourceUrl] = useState(initialUrl);
  const [checkingUrl, setCheckingUrl] = useState(false);
  const [urlCheck, setUrlCheck] = useState<UrlCheckResult | null>(null);
  const [importingUrl, setImportingUrl] = useState(false);

  // Processing & editing settings
  const [settings, setSettings] = useState<ProjectProcessingSettings>(DEFAULT_PROCESSING_SETTINGS);
  const [detectedDurationSec, setDetectedDurationSec] = useState<number>(60);

  const capsQuery = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: () => api.jobs.capabilities(),
  });

  const maxUploadMb = capsQuery.data?.limits.maxUploadSizeMb ?? 250;
  const maxDurationSec = capsQuery.data?.limits.maxVideoDurationSec ?? 3600;
  const creditsPerMin = capsQuery.data?.limits.creditsPerMinuteProcessed ?? 10;
  const minCredits = capsQuery.data?.limits.minCreditsPerJob ?? 10;

  const estimatedMinutes = Math.max(1, Math.ceil(detectedDurationSec / 60));
  const extraClipsCharge = Math.max(0, settings.clipCount - 3) * 2;
  const estimatedCredits = Math.max(minCredits, estimatedMinutes * creditsPerMin + extraClipsCharge);
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

    // Probe browser HTMLVideoElement metadata for accurate duration & credit estimate
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
            description: `Maximum supported video length is ${Math.round(maxDurationSec / 60)} minutes.`,
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

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Create Short Clips</h1>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          Import source footage, configure AI clipping windows, customize captions & reframing, and
          launch automated rendering.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN: SOURCE + CLIPPING + EDITOR SETTINGS */}
        <div className="lg:col-span-8 space-y-6">
          {/* 1. Source Video Card */}
          <Card className="p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-white">1. Video Source</h2>
              <div className="inline-flex rounded-xl bg-[#0D0D12] p-1 border border-white/10">
                <button
                  type="button"
                  onClick={() => setTab('upload')}
                  className={cn(
                    'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5',
                    tab === 'upload' ? 'bg-[#7C5CFF] text-white' : 'text-zinc-400 hover:text-white'
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
                  <Globe className="w-3.5 h-3.5" /> Paste Video URL
                </button>
              </div>
            </div>

            <Input
              label="Project Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Founder Podcast Ep. 14 — Product Growth Insights"
            />

            {tab === 'upload' ? (
              <div className="space-y-4">
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
                          MP4, MOV, WebM, MKV up to {maxUploadMb} MB (max{' '}
                          {Math.round(maxDurationSec / 60)} min)
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
                            {formatBytes(file.size)} • ~{detectedDurationSec}s detected
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
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="flex-1">
                    <Input
                      value={sourceUrl}
                      onChange={(e) => {
                        setSourceUrl(e.target.value);
                        setUrlCheck(null);
                      }}
                      placeholder="https://cdn.example.com/podcast-episode.mp4 or YouTube / Reels URL"
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
                  <strong className="text-zinc-200">Supported sources:</strong> Accessible direct
                  MP4/WebM links import directly with SSRF & size safeguards. YouTube, Instagram,
                  Facebook, and TikTok links are inspected via official/public metadata endpoints;
                  when platform policies block unauthenticated media downloading, use Direct Upload.
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
                options={[1, 2, 3, 4, 5, 6].map((n) => ({
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

        {/* RIGHT COLUMN: LIVE PREVIEW + CREDIT SUMMARY + SUBMIT */}
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
                <span>Target output count</span>
                <span>{settings.clipCount} clips</span>
              </div>
              <p className="text-[11px] text-zinc-500 pt-1 border-t border-white/[0.06]">
                Credits are reserved upfront and settled only upon validated MP4 rendering. Failed
                or cancelled jobs release 100% of reserved credits automatically.
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

            {tab === 'upload' ? (
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
