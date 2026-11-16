import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckSquare,
  Copy,
  Download,
  Edit3,
  FileJson,
  FileText,
  Film,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import { ASPECT_RATIOS } from '@clipforge/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  Select,
  Skeleton,
  Textarea,
} from '../../components/ui';
import { api, saveBlob } from '../../services/api';
import { useToastStore } from '../../stores/toastStore';
import type { CaptionCue, ClipItem } from '../../types/api';
import { formatBytes, formatDuration } from '../../utils/format';

export const ClipLibraryPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const initialProject = searchParams.get('projectId') || '';
  const [search, setSearch] = useState('');
  const [aspectRatio, setAspectRatio] = useState('');
  const [sort, setSort] = useState('newest');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Active modals
  const [previewClip, setPreviewClip] = useState<ClipItem | null>(null);
  const [metadataClip, setMetadataClip] = useState<ClipItem | null>(null);
  const [renameClip, setRenameClip] = useState<ClipItem | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [regenClip, setRegenClip] = useState<ClipItem | null>(null);
  const [regenAspect, setRegenAspect] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [regenCaptionStyle, setRegenCaptionStyle] = useState<Partial<ClipItem['captionStyle']>>({});
  const [savingMeta, setSavingMeta] = useState(false);
  // Caption editor (word-timed cues actually burned into the MP4)
  const [captionDraft, setCaptionDraft] = useState<CaptionCue[]>([]);
  const [savingCaptions, setSavingCaptions] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [regeneratingMeta, setRegeneratingMeta] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);

  const clipsQuery = useQuery({
    queryKey: ['clips-library', initialProject, aspectRatio, sort, search.trim()],
    queryFn: () =>
      api.clips.list({
        limit: 30,
        projectId: initialProject || undefined,
        aspectRatio: aspectRatio || undefined,
        sort,
        search: search.trim() || undefined,
      }),
    refetchInterval: 6000,
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleBulkDownload = async () => {
    if (selectedIds.length === 0) return;
    setBulkLoading(true);
    try {
      const res = await api.clips.getBulkDownloadUrl(selectedIds);
      window.location.href = res.downloadUrl;
      pushToast({
        type: 'success',
        title: `Preparing ZIP archive (${selectedIds.length} clips)`,
      });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Bulk download failed',
        description: err?.message,
      });
    } finally {
      setBulkLoading(false);
    }
  };

  const handleSaveRename = async () => {
    if (!renameClip || !newTitle.trim()) return;
    try {
      await api.clips.rename(renameClip._id, newTitle.trim());
      pushToast({ type: 'success', title: 'Clip renamed' });
      setRenameClip(null);
      void queryClient.invalidateQueries({ queryKey: ['clips-library'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Rename failed', description: err?.message });
    }
  };

  const handleDelete = async (clip: ClipItem) => {
    if (!window.confirm(`Delete clip "${clip.title}" permanently?`)) return;
    try {
      await api.clips.delete(clip._id);
      setSelectedIds((prev) => prev.filter((x) => x !== clip._id));
      pushToast({ type: 'success', title: 'Clip deleted' });
      void queryClient.invalidateQueries({ queryKey: ['clips-library'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Delete failed', description: err?.message });
    }
  };

  const handleRegenerateVideo = async () => {
    if (!regenClip) return;
    try {
      // Re-burn this clip's own persisted cues (which already include any saved edits).
      const clipCues = (regenClip.captions || []).filter((c) => c.text.trim());
      await api.clips.regenerateVideo(regenClip._id, {
        aspectRatio: regenAspect,
        captionStyle: regenCaptionStyle,
        ...(clipCues.length ? { captions: clipCues } : {}),
      });
      pushToast({
        type: 'success',
        title: 'Clip re-render queued',
        description: `Rendering ${regenAspect} version in background worker.`,
      });
      setRegenClip(null);
      void queryClient.invalidateQueries({ queryKey: ['clips-library'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Regeneration failed', description: err?.message });
    }
  };

  const openMetadataModal = (clip: ClipItem) => {
    setMetadataClip(clip);
    setCaptionDraft((clip.captions || []).map((c) => ({ ...c })));
  };

  const handleSaveCaptions = async () => {
    if (!metadataClip) return;
    setSavingCaptions(true);
    try {
      const res = await api.clips.updateCaptions(metadataClip._id, captionDraft);
      setMetadataClip(res.clip);
      setCaptionDraft((res.clip.captions || []).map((c) => ({ ...c })));
      pushToast({
        type: 'success',
        title: 'Captions saved',
        description: 'Re-render the clip to burn the edited captions into the MP4.',
      });
      void queryClient.invalidateQueries({ queryKey: ['clips-library'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Caption save failed', description: err?.message });
    } finally {
      setSavingCaptions(false);
    }
  };

  const handleExport = async (clip: ClipItem, kind: 'package' | 'metadata' | 'srt') => {
    setExportingId(clip._id);
    try {
      if (kind === 'package') {
        saveBlob(await api.clips.downloadPackage(clip._id), `${clip.title}_package.zip`);
      } else if (kind === 'metadata') {
        saveBlob(await api.clips.downloadMetadataFile(clip._id, 'txt'), `${clip.title}_metadata.txt`);
      } else {
        saveBlob(await api.clips.downloadCaptionsSrt(clip._id), `${clip.title}.srt`);
      }
      pushToast({ type: 'success', title: 'Export ready', description: 'Download started.' });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Export failed', description: err?.message });
    } finally {
      setExportingId(null);
    }
  };

  const handleSaveMetadata = async () => {
    if (!metadataClip) return;
    setSavingMeta(true);
    try {
      const res = await api.clips.updateMetadata(
        metadataClip._id,
        metadataClip.metadata,
        captionDraft.length ? captionDraft : undefined
      );
      setMetadataClip(res.clip);
      pushToast({ type: 'success', title: 'Metadata saved' });
      void queryClient.invalidateQueries({ queryKey: ['clips-library'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Save failed', description: err?.message });
    } finally {
      setSavingMeta(false);
    }
  };

  const handleRegenerateMetadata = async () => {
    if (!metadataClip) return;
    setRegeneratingMeta(true);
    try {
      const res = await api.clips.regenerateMetadata(metadataClip._id);
      setMetadataClip(res.clip);
      pushToast({
        type: res.aiNotice ? 'info' : 'success',
        title: 'Metadata regenerated',
        description: res.aiNotice || 'Updated titles, descriptions, hooks, and hashtags.',
      });
      void queryClient.invalidateQueries({ queryKey: ['clips-library'] });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Metadata regeneration error',
        description: err?.message,
      });
    } finally {
      setRegeneratingMeta(false);
    }
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    pushToast({ type: 'success', title: `${label} copied to clipboard` });
  };

  const items = clipsQuery.data?.items || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Clip Library & Downloads
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Preview, customize publishing metadata, re-render formats, or bulk-download your short
            clips.
          </p>
        </div>

        {selectedIds.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-300">{selectedIds.length} selected</span>
            <Button
              size="sm"
              loading={bulkLoading}
              onClick={handleBulkDownload}
              leftIcon={<Download className="w-3.5 h-3.5" />}
            >
              Download Selected (.ZIP)
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
              Clear
            </Button>
          </div>
        )}
      </div>

      {/* Search, Filter & Sort Toolbar */}
      <Card className="p-4 grid grid-cols-1 sm:grid-cols-12 gap-3">
        <div className="sm:col-span-6">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<Search className="w-4 h-4" />}
            placeholder="Search clips by title, transcript, or hashtag..."
          />
        </div>
        <div className="sm:col-span-3">
          <Select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value)}
            options={[
              { value: '', label: 'All aspect ratios' },
              { value: '9:16', label: '9:16 Vertical' },
              { value: '1:1', label: '1:1 Square' },
              { value: '16:9', label: '16:9 Landscape' },
            ]}
          />
        </div>
        <div className="sm:col-span-3">
          <Select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            options={[
              { value: 'newest', label: 'Newest first' },
              { value: 'score', label: 'Highest engagement est.' },
              { value: 'duration', label: 'Longest duration' },
            ]}
          />
        </div>
      </Card>

      {clipsQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((n) => (
            <Skeleton key={n} className="h-72 w-full" />
          ))}
        </div>
      ) : clipsQuery.isError ? (
        <ErrorState
          message={(clipsQuery.error as any)?.message || 'Failed to load clips'}
          onRetry={() => clipsQuery.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Film className="w-5 h-5" />}
          title="No clips in your library yet"
          description="Once a video processing job completes, all rendered MP4 clips and AI social metadata appear here."
          action={
            <Link to="/dashboard/create">
              <Button size="sm">Create Clips</Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {items.map((clip) => {
            const isSelected = selectedIds.includes(clip._id);
            const projName =
              typeof clip.projectId === 'object' && clip.projectId !== null
                ? clip.projectId.title
                : 'Project';

            return (
              <Card key={clip._id} className="overflow-hidden flex flex-col justify-between">
                <div>
                  <div className="relative h-48 bg-[#0B0B10] border-b border-white/[0.07] group overflow-hidden">
                    {clip.thumbnailUrl && (
                      <img
                        src={clip.thumbnailUrl}
                        alt={clip.title}
                        className="w-full h-full object-cover opacity-85 group-hover:scale-105 transition-transform duration-300"
                      />
                    )}
                    <div
                      onClick={() => setPreviewClip(clip)}
                      className="absolute inset-0 bg-black/35 flex items-center justify-center cursor-pointer"
                    >
                      <div className="w-11 h-11 rounded-full bg-black/75 border border-white/25 flex items-center justify-center">
                        <Play className="w-5 h-5 text-white ml-0.5" />
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(clip._id);
                      }}
                      className="absolute top-3 left-3 p-1.5 rounded-lg bg-black/70 border border-white/15 text-white"
                      aria-label="Select clip"
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-[#A58DFF]" />
                      ) : (
                        <Square className="w-4 h-4 text-zinc-400" />
                      )}
                    </button>

                    <div className="absolute top-3 right-3 flex items-center gap-1.5">
                      <Badge variant="brand">{clip.aspectRatio}</Badge>
                      <Badge>{formatDuration(clip.durationSec)}</Badge>
                    </div>

                    <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                      <Badge variant={clip.status === 'ready' ? 'success' : 'warning'}>
                        {clip.status}
                      </Badge>
                      <Badge variant="info">Potential: {clip.engagementScore}/100</Badge>
                    </div>
                  </div>

                  <div className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-white line-clamp-1">
                        {clip.title}
                      </h3>
                      <button
                        type="button"
                        onClick={() => {
                          setRenameClip(clip);
                          setNewTitle(clip.title);
                        }}
                        className="text-zinc-500 hover:text-white shrink-0"
                        title="Rename clip"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate">
                      Project: <span className="text-zinc-300">{projName}</span> •{' '}
                      {formatBytes(clip.fileSizeBytes)}
                    </div>
                    <p className="text-xs text-zinc-400 line-clamp-2">{clip.transcript}</p>
                  </div>
                </div>

                <div className="px-4 py-3 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openMetadataModal(clip)}
                      leftIcon={<Wand2 className="w-3.5 h-3.5 text-[#A58DFF]" />}
                    >
                      AI Copy
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRegenClip(clip);
                        setRegenAspect(clip.aspectRatio);
                      }}
                      title="Re-render clip"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleDelete(clip)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                      title="Delete clip"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {clip.status === 'ready' && (
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleExport(clip, 'package')}
                        loading={exportingId === clip._id}
                        title="Download MP4 + metadata TXT/JSON + captions SRT as a ZIP"
                        leftIcon={<FileJson className="w-3.5 h-3.5" />}
                      >
                        With Metadata
                      </Button>
                      <a href={clip.downloadUrl} download>
                        <Button size="sm" leftIcon={<Download className="w-3.5 h-3.5" />}>
                          MP4
                        </Button>
                      </a>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Video Player Modal */}
      <Modal
        open={Boolean(previewClip)}
        onClose={() => setPreviewClip(null)}
        title={previewClip?.title || 'Clip Preview'}
        size="lg"
      >
        {previewClip && (
          <div className="space-y-4">
            <div className="rounded-xl bg-black border border-white/10 flex items-center justify-center overflow-hidden max-h-[62vh]">
              {previewClip.previewUrl && (
                <video
                  src={previewClip.previewUrl}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[60vh] w-auto"
                />
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(previewClip.editingApplied || []).map((f) => (
                <Badge key={f}>{f}</Badge>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* Rename Modal */}
      <Modal
        open={Boolean(renameClip)}
        onClose={() => setRenameClip(null)}
        title="Rename Clip"
      >
        <div className="space-y-4">
          <Input
            label="Clip Title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenameClip(null)}>
              Cancel
            </Button>
            <Button onClick={handleSaveRename}>Save Title</Button>
          </div>
        </div>
      </Modal>

      {/* Regenerate Video Modal */}
      <Modal
        open={Boolean(regenClip)}
        onClose={() => setRegenClip(null)}
        title="Regenerate Clip Render"
        description="Re-run FFmpeg smart reframing and caption rendering for this clip segment."
      >
        <div className="space-y-4">
          <Select
            label="Target Aspect Ratio"
            value={regenAspect}
            onChange={(e) => setRegenAspect(e.target.value as any)}
            options={ASPECT_RATIOS.map((r) => ({ value: r, label: r }))}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select
              label="Caption Animation"
              value={regenCaptionStyle.animation || regenClip?.captionStyle.animation || 'word_pop'}
              onChange={(e) =>
                setRegenCaptionStyle({ ...regenCaptionStyle, animation: e.target.value as any })
              }
              options={[
                { value: 'word_pop', label: 'Word pop' },
                { value: 'karaoke', label: 'Karaoke highlight' },
                { value: 'fade', label: 'Fade' },
                { value: 'none', label: 'Static' },
              ]}
            />
            <Select
              label="Caption Position"
              value={regenCaptionStyle.position || regenClip?.captionStyle.position || 'bottom'}
              onChange={(e) =>
                setRegenCaptionStyle({ ...regenCaptionStyle, position: e.target.value as any })
              }
              options={[
                { value: 'bottom', label: 'Bottom' },
                { value: 'middle', label: 'Middle' },
                { value: 'top', label: 'Top' },
              ]}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              type="color"
              label="Text Color"
              value={regenCaptionStyle.textColor || regenClip?.captionStyle.textColor || '#FFFFFF'}
              onChange={(e) => setRegenCaptionStyle({ ...regenCaptionStyle, textColor: e.target.value })}
            />
            <Input
              type="color"
              label="Highlight Color"
              value={
                regenCaptionStyle.highlightColor || regenClip?.captionStyle.highlightColor || '#38BDF8'
              }
              onChange={(e) =>
                setRegenCaptionStyle({ ...regenCaptionStyle, highlightColor: e.target.value })
              }
            />
            <Input
              type="number"
              min={18}
              max={96}
              label="Font Size"
              value={regenCaptionStyle.fontSize || regenClip?.captionStyle.fontSize || 42}
              onChange={(e) =>
                setRegenCaptionStyle({ ...regenCaptionStyle, fontSize: Number(e.target.value) })
              }
            />
          </div>

          {regenClip?.captions?.length ? (
            <p className="text-[11px] text-zinc-500">
              {regenClip.captionSource === 'edited'
                ? 'Your edited caption lines will be re-burned into the clip.'
                : 'Captions will be re-timed from the transcription.'}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRegenClip(null)}>
              Cancel
            </Button>
            <Button onClick={handleRegenerateVideo} leftIcon={<Sparkles className="w-4 h-4" />}>
              Queue Re-Render
            </Button>
          </div>
        </div>
      </Modal>

      {/* AI Metadata Editor & Multi-Platform Copy Modal */}
      <Modal
        open={Boolean(metadataClip)}
        onClose={() => setMetadataClip(null)}
        title="AI Publishing Metadata & Social Copy"
        description="Edit or regenerate titles, hooks, thumbnail concepts, hashtags, and platform descriptions."
        size="xl"
      >
        {metadataClip && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-white/[0.08]">
              <Badge
                variant={
                  metadataClip.metadata.generatedBy === 'deterministic_nlp' ? 'default' : 'brand'
                }
              >
                Generator:{' '}
                {metadataClip.metadata.generatedBy === 'deterministic_nlp'
                  ? 'Transcript NLP (Configure GEMINI_API_KEY for LLM mode)'
                  : metadataClip.metadata.generatedBy}
              </Badge>
              <Button
                variant="secondary"
                size="sm"
                loading={regeneratingMeta}
                onClick={handleRegenerateMetadata}
                leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
              >
                Regenerate Metadata
              </Button>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-zinc-300">3 Suggested Title Options</label>
              {(metadataClip.metadata.titleOptions || []).map((opt, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={opt}
                    onChange={(e) => {
                      const next = [...metadataClip.metadata.titleOptions];
                      next[idx] = e.target.value;
                      setMetadataClip({
                        ...metadataClip,
                        metadata: { ...metadataClip.metadata, titleOptions: next },
                      });
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyText(opt, `Title option ${idx + 1}`)}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Opening Hook"
                value={metadataClip.metadata.openingHook}
                onChange={(e) =>
                  setMetadataClip({
                    ...metadataClip,
                    metadata: { ...metadataClip.metadata, openingHook: e.target.value },
                  })
                }
              />
              <Input
                label="Thumbnail Concept Text"
                value={metadataClip.metadata.thumbnailText}
                onChange={(e) =>
                  setMetadataClip({
                    ...metadataClip,
                    metadata: { ...metadataClip.metadata, thumbnailText: e.target.value },
                  })
                }
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-300">
                  SEO Description (canonical)
                </span>
                <button
                  type="button"
                  onClick={() => copyText(metadataClip.metadata.seoDescription || '', 'SEO description')}
                  className="text-[11px] text-[#A58DFF] hover:underline"
                >
                  Copy
                </button>
              </div>
              <Textarea
                rows={2}
                value={metadataClip.metadata.seoDescription || ''}
                onChange={(e) =>
                  setMetadataClip({
                    ...metadataClip,
                    metadata: { ...metadataClip.metadata, seoDescription: e.target.value },
                  })
                }
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {(
                [
                  ['youtubeShorts', 'YouTube Shorts Description'],
                  ['instagramReels', 'Instagram Reels Caption'],
                  ['tiktok', 'TikTok Caption'],
                  ['facebookReels', 'Facebook Reels Post'],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-zinc-300">{label}</span>
                    <button
                      type="button"
                      onClick={() =>
                        copyText(metadataClip.metadata.descriptions[key], label)
                      }
                      className="text-[11px] text-[#A58DFF] hover:underline"
                    >
                      Copy
                    </button>
                  </div>
                  <Textarea
                    rows={3}
                    value={metadataClip.metadata.descriptions[key]}
                    onChange={(e) =>
                      setMetadataClip({
                        ...metadataClip,
                        metadata: {
                          ...metadataClip.metadata,
                          descriptions: {
                            ...metadataClip.metadata.descriptions,
                            [key]: e.target.value,
                          },
                        },
                      })
                    }
                  />
                </div>
              ))}
            </div>

            <Input
              label="Hashtags (comma separated)"
              value={(metadataClip.metadata.hashtags || []).join(', ')}
              onChange={(e) =>
                setMetadataClip({
                  ...metadataClip,
                  metadata: {
                    ...metadataClip.metadata,
                    hashtags: e.target.value
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  },
                })
              }
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Keywords (comma separated)"
                value={(metadataClip.metadata.keywords || []).join(', ')}
                onChange={(e) =>
                  setMetadataClip({
                    ...metadataClip,
                    metadata: {
                      ...metadataClip.metadata,
                      keywords: e.target.value
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
              <div className="flex items-end">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    copyText(
                      [
                        metadataClip.metadata.descriptions.youtubeShorts,
                        (metadataClip.metadata.hashtags || []).join(' '),
                      ]
                        .filter(Boolean)
                        .join('\n\n'),
                      'Caption + hashtags'
                    )
                  }
                >
                  <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy caption + hashtags
                </Button>
              </div>
            </div>

            {/* Word-timed captions burned into the MP4 */}
            <div className="space-y-2 pt-3 border-t border-white/[0.08]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <label className="text-xs font-semibold text-zinc-300">
                    Captions burned into this clip ({captionDraft.length} cues)
                  </label>
                  <p className="text-[11px] text-zinc-500">
                    {metadataClip.captionSource === 'edited'
                      ? 'Edited captions — re-render to burn these into the MP4.'
                      : metadataClip.captions?.length
                        ? 'Word-timed captions rendered from the transcription. Edit any line, then save.'
                        : 'No caption cues stored for this clip yet.'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!captionDraft.length}
                    onClick={() => void handleExport(metadataClip, 'srt')}
                    leftIcon={<FileText className="w-3.5 h-3.5" />}
                  >
                    Export SRT
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={savingCaptions}
                    disabled={!captionDraft.length}
                    onClick={handleSaveCaptions}
                  >
                    Save Captions
                  </Button>
                </div>
              </div>

              {captionDraft.length > 0 ? (
                <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
                  {captionDraft.map((cue, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-zinc-500 w-20 shrink-0">
                        {cue.startSec.toFixed(2)}s
                      </span>
                      <Input
                        value={cue.text}
                        onChange={(e) => {
                          const next = [...captionDraft];
                          next[idx] = { ...next[idx], text: e.target.value };
                          setCaptionDraft(next);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setCaptionDraft(captionDraft.filter((_, i) => i !== idx))}
                        className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                        title="Remove caption line"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-500">
                  Re-generate this clip to capture its word-level caption timing.
                </p>
              )}
            </div>

            {metadataClip.metadata.suggestedPostingWindow && (
              <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.07] text-xs text-zinc-400">
                <strong className="text-zinc-200">Posting Time Guidance:</strong>{' '}
                {metadataClip.metadata.suggestedPostingWindow.note}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-white/[0.08]">
              <Button variant="ghost" onClick={() => setMetadataClip(null)}>
                Close
              </Button>
              <Button loading={savingMeta} onClick={handleSaveMetadata}>
                Save Metadata Changes
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
