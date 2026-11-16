import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Clock,
  ListVideo,
  RotateCcw,
  StopCircle,
  XCircle,
} from 'lucide-react';
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS } from '@clipforge/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ProgressBar,
  Skeleton,
} from '../../components/ui';
import { api } from '../../services/api';
import { useToastStore } from '../../stores/toastStore';
import { useWalletRefresh } from '../../hooks/useWalletRefresh';
import { formatDateTime } from '../../utils/format';
import { cn } from '../../utils/cn';

export const ProcessingQueuePage: React.FC = () => {
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();
  const refreshWallet = useWalletRefresh();
  const [statusFilter, setStatusFilter] = useState('');

  const jobsQuery = useQuery({
    queryKey: ['processing-jobs', statusFilter],
    queryFn: () => api.jobs.list({ status: statusFilter || undefined }),
    refetchInterval: (query) => {
      const hasActive = query.state.data?.items.some(
        (j) => j.status === 'processing' || j.status === 'queued'
      );
      return hasActive ? 1500 : 6000;
    },
  });

  const handleCancel = async (id: string) => {
    try {
      await api.jobs.cancel(id);
      await refreshWallet();
      pushToast({
        type: 'info',
        title: 'Job cancelled',
        description: 'Reserved credits have been returned to your wallet.',
      });
      void queryClient.invalidateQueries({ queryKey: ['processing-jobs'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Could not cancel job', description: err?.message });
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await api.jobs.retry(id);
      await refreshWallet();
      pushToast({ type: 'success', title: 'Job re-queued for processing' });
      void queryClient.invalidateQueries({ queryKey: ['processing-jobs'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Retry failed', description: err?.message });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Processing Queue</h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Live stage-by-stage telemetry from the ClipForge AI background worker pipeline.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {[
            { id: '', label: 'All' },
            { id: 'processing', label: 'Active' },
            { id: 'completed', label: 'Completed' },
            { id: 'failed', label: 'Failed' },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                statusFilter === f.id
                  ? 'bg-[#7C5CFF]/20 border-[#7C5CFF]/40 text-white'
                  : 'bg-[#13131A] border-white/10 text-zinc-400 hover:text-white'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {jobsQuery.isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((n) => (
            <Skeleton key={n} className="h-44 w-full" />
          ))}
        </div>
      ) : jobsQuery.isError ? (
        <ErrorState
          message={(jobsQuery.error as any)?.message || 'Failed to load processing queue'}
          onRetry={() => jobsQuery.refetch()}
        />
      ) : (jobsQuery.data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={<ListVideo className="w-5 h-5" />}
          title="No jobs in queue"
          description="Upload a video in Clip Studio to watch real-time 12-stage transcription, scene detection, and FFmpeg rendering."
          action={
            <Link to="/dashboard/create">
              <Button size="sm">Create Clips</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          {jobsQuery.data?.items.map((job) => {
            const projId =
              typeof job.projectId === 'object' && job.projectId !== null
                ? job.projectId._id
                : job.projectId;
            const projTitle =
              typeof job.projectId === 'object' && job.projectId !== null
                ? job.projectId.title
                : 'Video Project';
            const stageIdx = PIPELINE_STAGES.indexOf(job.stage as any);

            return (
              <Card key={job._id} className="p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <Link
                        to={`/dashboard/projects/${projId}`}
                        className="text-base font-semibold text-white hover:text-[#B4A2FF]"
                      >
                        {projTitle}
                      </Link>
                      {job.chunkProgress && job.chunkProgress.totalChunks > 1 && (
                        <Badge variant="brand">
                          Chunk {job.chunkProgress.completedChunks}/{job.chunkProgress.totalChunks}
                        </Badge>
                      )}
                      <Badge
                        variant={
                          job.status === 'completed'
                            ? 'success'
                            : job.status === 'failed'
                            ? 'danger'
                            : job.status === 'cancelled'
                            ? 'default'
                            : 'warning'
                        }
                      >
                        {job.status.toUpperCase()}
                      </Badge>
                      <Badge>{job.queueMode === 'bullmq' ? 'BullMQ + Redis' : 'Local Worker'}</Badge>
                    </div>
                    <div className="text-xs text-zinc-500">
                      Started {formatDateTime(job.startedAt || job.createdAt)} • Reserved:{' '}
                      {job.creditsReserved} cr • Deducted: {job.creditsDeducted} cr
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {(job.status === 'processing' || job.status === 'queued') && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleCancel(job._id)}
                        leftIcon={<StopCircle className="w-3.5 h-3.5" />}
                      >
                        Cancel
                      </Button>
                    )}
                    {job.status === 'failed' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleRetry(job._id)}
                        leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
                      >
                        Retry Job
                      </Button>
                    )}
                    <Link to={`/dashboard/projects/${projId}`}>
                      <Button variant="outline" size="sm">
                        View Project
                      </Button>
                    </Link>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-300 font-medium">
                      {PIPELINE_STAGE_LABELS[job.stage] || job.stage}:{' '}
                      <span className="text-zinc-400 font-normal">{job.currentMessage}</span>
                    </span>
                    <span className="font-mono text-white tabular-nums">
                      {job.progressPercent}%
                    </span>
                  </div>
                  <ProgressBar value={job.progressPercent} />
                </div>

                {/* 12-Stage Pill Stepper */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-1.5 pt-1">
                  {PIPELINE_STAGES.map((st, idx) => {
                    const done = job.status === 'completed' || (stageIdx > idx && stageIdx !== -1);
                    const current =
                      job.status === 'processing' && job.stage === st;
                    return (
                      <div
                        key={st}
                        className={cn(
                          'px-2.5 py-1.5 rounded-lg text-[11px] border flex items-center gap-1.5 truncate',
                          done &&
                            'bg-emerald-500/[0.08] border-emerald-500/25 text-emerald-300',
                          current &&
                            'bg-[#7C5CFF]/20 border-[#7C5CFF]/50 text-white font-medium',
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

                {job.error && (
                  <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 flex items-start gap-2.5 text-xs text-red-300">
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <strong>{job.error.code}:</strong> {job.error.message}
                      {job.creditReservationReleased && (
                        <span className="ml-2 text-emerald-300">
                          • Reserved credits released back to wallet.
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
