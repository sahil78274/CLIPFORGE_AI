import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  Film,
  FolderKanban,
  Play,
  PlusCircle,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { PIPELINE_STAGE_LABELS } from '@clipforge/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  ProgressBar,
  Select,
  Skeleton,
} from '../../components/ui';
import { api } from '../../services/api';
import { useToastStore } from '../../stores/toastStore';
import type { ClipItem, VideoRecord } from '../../types/api';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
} from '../../utils/format';

/* ================= MY PROJECTS LIST PAGE ================= */
export const ProjectsPage: React.FC = () => {
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const projectsQuery = useQuery({
    queryKey: ['projects', page, statusFilter, search.trim()],
    queryFn: () =>
      api.projects.list({
        page,
        limit: 12,
        status: statusFilter || undefined,
        search: search.trim() || undefined,
      }),
    refetchInterval: 5000,
  });

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`Delete project "${title}" and its generated clips?`)) return;
    try {
      await api.projects.delete(id);
      pushToast({ type: 'success', title: 'Project deleted' });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Unable to delete project',
        description: err?.message,
      });
    }
  };

  const statusBadge = (status: string) => {
    if (status === 'completed') return <Badge variant="success">Completed</Badge>;
    if (status === 'failed') return <Badge variant="danger">Failed</Badge>;
    if (status === 'processing' || status === 'queued' || status === 'importing')
      return <Badge variant="warning">{status}</Badge>;
    return <Badge>{status}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">My Projects</h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            All uploaded source videos, transcripts, and short-clip workspaces owned by your
            account.
          </p>
        </div>
        <Link to="/dashboard/create">
          <Button leftIcon={<PlusCircle className="w-4 h-4" />}>New Project</Button>
        </Link>
      </div>

      {/* Filters */}
      <Card className="p-4 flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            leftIcon={<Search className="w-4 h-4" />}
            placeholder="Filter projects by title..."
          />
        </div>
        <div className="w-full sm:w-52">
          <Select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'completed', label: 'Completed' },
              { value: 'processing', label: 'Processing' },
              { value: 'queued', label: 'Queued' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
        </div>
      </Card>

      {projectsQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      ) : projectsQuery.isError ? (
        <ErrorState
          message={(projectsQuery.error as any)?.message || 'Could not load projects'}
          onRetry={() => projectsQuery.refetch()}
        />
      ) : (projectsQuery.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FolderKanban className="w-5 h-5" />}
          title="No matching projects"
          description="Start by uploading a video or pasting a supported direct media URL."
          action={
            <Link to="/dashboard/create">
              <Button size="sm" leftIcon={<PlusCircle className="w-4 h-4" />}>
                Create Project
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projectsQuery.data?.items.map((proj) => {
            const video =
              typeof proj.videoId === 'object' && proj.videoId !== null
                ? (proj.videoId as VideoRecord)
                : null;
            return (
              <Card key={proj._id} className="p-5 flex flex-col justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      to={`/dashboard/projects/${proj._id}`}
                      className="text-base font-semibold text-white hover:text-[#B4A2FF] transition-colors line-clamp-1"
                    >
                      {proj.title}
                    </Link>
                    {statusBadge(proj.status)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs text-zinc-400 pt-1">
                    <div>
                      Format: <strong className="text-zinc-200">{proj.settings.aspectRatio}</strong>
                    </div>
                    <div>
                      Clips: <strong className="text-zinc-200">{proj.clipsCount || 0}</strong>
                    </div>
                    <div>
                      Duration:{' '}
                      <strong className="text-zinc-200">
                        {video ? formatDuration(video.durationSec) : '—'}
                      </strong>
                    </div>
                    <div>
                      Credits: <strong className="text-zinc-200">{proj.creditsConsumed || 0}</strong>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-white/[0.07] flex items-center justify-between">
                  <span className="text-[11px] text-zinc-500">
                    {formatRelativeTime(proj.createdAt)}
                  </span>
                  <div className="flex items-center gap-2">
                    <Link to={`/dashboard/projects/${proj._id}`}>
                      <Button variant="secondary" size="sm">
                        Open
                      </Button>
                    </Link>
                    <button
                      type="button"
                      onClick={() => handleDelete(proj._id, proj.title)}
                      className="p-2 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                      aria-label="Delete project"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ================= PROJECT DETAIL PAGE ================= */
export const ProjectDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);

  const [previewClip, setPreviewClip] = useState<ClipItem | null>(null);
  const [restarting, setRestarting] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['project-detail', id],
    queryFn: () => api.projects.get(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.project.status;
      return status === 'processing' || status === 'queued' || status === 'importing'
        ? 2000
        : 8000;
    },
  });

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ErrorState
        message={(detailQuery.error as any)?.message || 'Project not found'}
        onRetry={() => detailQuery.refetch()}
      />
    );
  }

  const { project, clips, jobs } = detailQuery.data;
  const video =
    typeof project.videoId === 'object' && project.videoId !== null
      ? (project.videoId as VideoRecord)
      : null;
  const latestJob = jobs[0];

  const handleRerun = async () => {
    setRestarting(true);
    try {
      await api.jobs.startForProject(project._id);
      pushToast({ type: 'success', title: 'New processing job queued' });
      void detailQuery.refetch();
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Unable to start job',
        description: err?.message,
      });
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => navigate('/dashboard/projects')}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-400 hover:text-white mb-1"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back to Projects
          </button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold text-white">{project.title}</h1>
            <Badge
              variant={
                project.status === 'completed'
                  ? 'success'
                  : project.status === 'failed'
                  ? 'danger'
                  : 'warning'
              }
            >
              {project.status}
            </Badge>
          </div>
          <p className="text-xs text-zinc-500">
            Created {formatDateTime(project.createdAt)} • Target Format:{' '}
            {project.settings.aspectRatio}
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {project.status !== 'processing' && project.status !== 'queued' && video && (
            <Button
              variant="secondary"
              size="sm"
              loading={restarting}
              onClick={handleRerun}
              leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
            >
              Re-Process Video
            </Button>
          )}
          <Link to={`/dashboard/clips?projectId=${project._id}`}>
            <Button size="sm" leftIcon={<Film className="w-3.5 h-3.5" />}>
              Open in Clip Library
            </Button>
          </Link>
        </div>
      </div>

      {/* Live Job Status Card */}
      {latestJob && (
        <Card className="p-5 space-y-4 border-white/12">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#A58DFF]" />
              <span className="text-sm font-semibold text-white">
                Pipeline Stage: {PIPELINE_STAGE_LABELS[latestJob.stage] || latestJob.stage}
              </span>
            </div>
            <span className="text-xs font-mono text-zinc-300">{latestJob.progressPercent}%</span>
          </div>

          <ProgressBar value={latestJob.progressPercent} />

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
            <span>{latestJob.currentMessage}</span>
            <div className="flex flex-wrap items-center gap-2">
              {latestJob.diagnostics?.whisperStatus && (
                <Badge variant="info">ASR: {latestJob.diagnostics.whisperStatus}</Badge>
              )}
              {latestJob.diagnostics?.detectedLanguage &&
                latestJob.diagnostics.detectedLanguage !== 'und' && (
                  <Badge variant="default">Speech: {latestJob.diagnostics.detectedLanguage}</Badge>
                )}
              {latestJob.diagnostics?.whisperStatus !== 'pending' &&
                latestJob.diagnostics?.transcriptLanguageValidated === false && (
                  <Badge variant="warning">Transcript language not verified</Badge>
                )}
              <Badge variant={latestJob.diagnostics?.aiConfigured ? 'brand' : 'default'}>
                AI: {latestJob.diagnostics?.aiProvider || 'provider not checked'}
                {!latestJob.diagnostics?.aiConfigured && latestJob.status === 'completed'
                  ? ' (not configured)'
                  : ''}
              </Badge>
              {latestJob.diagnostics?.metadataFallbacks?.map((fallback) => (
                <Badge
                  key={`${fallback.provider}-${fallback.code}-${fallback.statusCode || 'none'}`}
                  variant="warning"
                >
                  Metadata NLP fallback
                  {fallback.statusCode ? ` · HTTP ${fallback.statusCode}` : ''}
                </Badge>
              ))}
            </div>
          </div>

          {latestJob.diagnostics?.clipSelection && (
            <div
              className={`rounded-xl border p-3 text-xs ${
                latestJob.diagnostics.clipSelection.shortfall
                  ? 'border-amber-500/25 bg-amber-500/[0.06] text-amber-200'
                  : 'border-emerald-500/20 bg-emerald-500/[0.05] text-emerald-200'
              }`}
            >
              <strong>
                Clips generated: {latestJob.diagnostics.clipSelection.generatedCount} of{' '}
                {latestJob.diagnostics.clipSelection.requestedCount} requested.
              </strong>
              {latestJob.diagnostics.clipSelection.shortfall && (
                <p className="mt-1">{latestJob.diagnostics.clipSelection.message}</p>
              )}
            </div>
          )}

          {latestJob.diagnostics?.metadataFallbacks?.map((fallback) => (
            <div
              key={`${fallback.provider}-${fallback.code}-${fallback.statusCode || 'none'}-message`}
              className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs text-amber-200"
            >
              <strong>Metadata fallback:</strong> {fallback.message}
              {fallback.affectedClips > 1 && ` Affected ${fallback.affectedClips} clips.`}
            </div>
          ))}

          {latestJob.error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
              <strong>Failed at {latestJob.error.stage}:</strong> {latestJob.error.message}{' '}
              {latestJob.creditReservationReleased &&
                '(Reserved credits automatically returned to wallet.)'}
            </div>
          )}
        </Card>
      )}

      {/* Generated Clips Grid */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-white">
          Generated Short Clips ({clips.length})
        </h2>

        {clips.length === 0 ? (
          <Card className="p-10 text-center text-xs text-zinc-400">
            {project.status === 'processing' || project.status === 'queued'
              ? 'Clips are currently being analyzed and rendered by the worker...'
              : 'No clips have been rendered for this project yet.'}
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {clips.map((clip) => (
              <Card key={clip._id} className="overflow-hidden flex flex-col justify-between">
                <div>
                  <div
                    onClick={() => setPreviewClip(clip)}
                    className="relative h-48 bg-[#0B0B10] cursor-pointer group flex items-center justify-center overflow-hidden border-b border-white/[0.07]"
                  >
                    {clip.thumbnailUrl ? (
                      <img
                        src={clip.thumbnailUrl}
                        alt={clip.title}
                        className="w-full h-full object-cover opacity-85 group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : null}
                    <div className="absolute inset-0 bg-black/35 flex items-center justify-center">
                      <div className="w-11 h-11 rounded-full bg-black/70 border border-white/25 flex items-center justify-center group-hover:scale-110 transition-transform">
                        <Play className="w-5 h-5 text-white ml-0.5" />
                      </div>
                    </div>
                    <div className="absolute top-3 left-3 flex gap-1.5">
                      <Badge variant="brand">{clip.aspectRatio}</Badge>
                      <Badge>{formatDuration(clip.durationSec)}</Badge>
                    </div>
                    <div className="absolute bottom-3 right-3">
                      <Badge variant="info">Est. Score: {clip.engagementScore}/100</Badge>
                    </div>
                  </div>

                  <div className="p-4 space-y-2">
                    <h3 className="text-sm font-semibold text-white line-clamp-1">{clip.title}</h3>
                    <p className="text-xs text-zinc-400 line-clamp-2">{clip.selectionReason}</p>
                    <div className="text-[11px] font-mono text-zinc-500">
                      Window: {formatDuration(clip.startSec)} – {formatDuration(clip.endSec)} •{' '}
                      {formatBytes(clip.fileSizeBytes)}
                    </div>
                  </div>
                </div>

                <div className="px-4 py-3 border-t border-white/[0.06] flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setPreviewClip(clip)}>
                    Preview
                  </Button>
                  {clip.downloadUrl && (
                    <a href={clip.downloadUrl} download>
                      <Button size="sm" leftIcon={<Download className="w-3.5 h-3.5" />}>
                        Download MP4
                      </Button>
                    </a>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Source Media Specs & Transcript */}
      {video && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <Card className="lg:col-span-5 p-5 space-y-4">
            <h3 className="text-sm font-semibold text-white">Source Video Inspection</h3>
            <dl className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-zinc-500">Filename</dt>
                <dd className="text-zinc-200 truncate font-medium mt-0.5">
                  {video.originalFilename}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Resolution</dt>
                <dd className="text-zinc-200 font-mono mt-0.5">
                  {video.width}×{video.height} ({Math.round(video.fps || 30)} fps)
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Duration / Size</dt>
                <dd className="text-zinc-200 font-mono mt-0.5">
                  {formatDuration(video.durationSec)} • {formatBytes(video.sizeBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Detected Scenes</dt>
                <dd className="text-zinc-200 mt-0.5">
                  {video.scenes?.length || 0} cuts (
                  {video.scenes?.filter((s) => s.hasFace).length || 0} with tracked face)
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="lg:col-span-7 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Timestamped Transcript</h3>
              {video.transcriptionEngine && <Badge>{video.transcriptionEngine}</Badge>}
            </div>
            <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
              {(video.transcript || []).length === 0 ? (
                <p className="text-xs text-zinc-500">
                  Transcript segments populate once the transcription stage finishes.
                </p>
              ) : (
                video.transcript.map((seg) => (
                  <div
                    key={seg.id}
                    className="flex items-start gap-3 text-xs py-1.5 border-b border-white/[0.04]"
                  >
                    <span className="font-mono text-[#A58DFF] shrink-0 tabular-nums">
                      {formatDuration(seg.start)}
                    </span>
                    <span className="text-zinc-300 leading-relaxed">{seg.text}</span>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      )}

      {/* Video Player Preview Modal */}
      <Modal
        open={Boolean(previewClip)}
        onClose={() => setPreviewClip(null)}
        title={previewClip?.title || 'Clip Preview'}
        description={
          previewClip
            ? `${previewClip.aspectRatio} • ${formatDuration(previewClip.durationSec)} • ${formatBytes(
                previewClip.fileSizeBytes
              )}`
            : undefined
        }
        size="lg"
      >
        {previewClip && (
          <div className="space-y-4">
            <div className="rounded-xl bg-black border border-white/10 flex items-center justify-center overflow-hidden max-h-[62vh]">
              {previewClip.previewUrl ? (
                <video
                  src={previewClip.previewUrl}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-[60vh] w-auto"
                />
              ) : (
                <div className="p-10 text-xs text-zinc-400">Preview stream unavailable</div>
              )}
            </div>
            <div className="p-3.5 rounded-xl bg-[#0F0F15] border border-white/[0.07] text-xs text-zinc-300 space-y-1">
              <div className="font-semibold text-white">Clip Transcript</div>
              <p className="text-zinc-400">{previewClip.transcript || '—'}</p>
            </div>
            <div className="flex justify-end gap-2">
              {previewClip.downloadUrl && (
                <a href={previewClip.downloadUrl} download>
                  <Button leftIcon={<Download className="w-4 h-4" />}>Download MP4</Button>
                </a>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
