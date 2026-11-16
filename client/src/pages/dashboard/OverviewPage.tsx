import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  Coins,
  Film,
  FolderKanban,
  ListVideo,
  PlusCircle,
  Sparkles,
  Youtube,
} from 'lucide-react';
import { PIPELINE_STAGE_LABELS } from '@clipforge/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  ProgressBar,
  Skeleton,
} from '../../components/ui';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { formatDuration, formatRelativeTime } from '../../utils/format';

export const OverviewPage: React.FC = () => {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [quickYoutubeUrl, setQuickYoutubeUrl] = useState('');

  const overviewQuery = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: () => api.users.overview(),
    refetchInterval: 5000,
  });

  if (overviewQuery.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <Skeleton key={n} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (overviewQuery.isError || !overviewQuery.data) {
    return (
      <ErrorState
        message={(overviewQuery.error as any)?.message || 'Failed to load studio overview'}
        onRetry={() => overviewQuery.refetch()}
      />
    );
  }

  const { stats, recentProjects, recentJobs, recentActivity } = overviewQuery.data;

  const statCards = [
    {
      label: 'Total Projects',
      value: stats.totalProjects,
      sub: 'Source videos managed',
      icon: FolderKanban,
      accent: 'text-[#A58DFF]',
    },
    {
      label: 'Clips Generated',
      value: stats.clipsGenerated,
      sub: 'Validated MP4 renders',
      icon: Film,
      accent: 'text-[#38BDF8]',
    },
    {
      label: 'Processing Jobs',
      value: stats.activeProcessingJobs,
      sub: 'Active in worker queue',
      icon: ListVideo,
      accent: 'text-amber-400',
    },
    {
      label: 'Credits Remaining',
      value: stats.creditsRemaining,
      sub:
        stats.reservedCredits > 0
          ? `${stats.reservedCredits} currently reserved`
          : 'Available in wallet',
      icon: Coins,
      accent: 'text-emerald-400',
    },
  ];

  const badgeForStatus = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge variant="success">Completed</Badge>;
      case 'processing':
      case 'queued':
      case 'importing':
        return <Badge variant="warning">{status}</Badge>;
      case 'failed':
        return <Badge variant="danger">Failed</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  return (
    <div className="space-y-8">
      {/* Welcome Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">
            Welcome back, {user?.name?.split(' ')[0] || 'Creator'}
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Monitor active processing jobs, manage generated short clips, or start a new video cut.
          </p>
        </div>
        <Link to="/dashboard/create">
          <Button leftIcon={<PlusCircle className="w-4 h-4" />}>Create New Clips</Button>
        </Link>
      </div>

      {/* Quick YouTube Link-to-Clips Launch Bar */}
      <Card className="p-5 border-[#7C5CFF]/30 bg-gradient-to-r from-[#141422] to-[#101018]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate(
              `/dashboard/create?tab=youtube${
                quickYoutubeUrl.trim()
                  ? `&url=${encodeURIComponent(quickYoutubeUrl.trim())}`
                  : ''
              }`
            );
          }}
          className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
        >
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400">
              <Youtube className="w-4 h-4" />
            </div>
            <div>
              <div className="text-xs font-semibold text-white">YouTube Link to AI Clips</div>
              <div className="text-[11px] text-zinc-400">Supports podcasts & talks up to 10h</div>
            </div>
          </div>
          <div className="flex-1">
            <Input
              value={quickYoutubeUrl}
              onChange={(e) => setQuickYoutubeUrl(e.target.value)}
              placeholder="Paste any public YouTube video link (https://www.youtube.com/watch?v=...)"
            />
          </div>
          <Button type="submit" leftIcon={<Sparkles className="w-4 h-4" />}>
            Fetch & Clip
          </Button>
        </form>
      </Card>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label} className="p-5 flex items-start justify-between">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-zinc-400">{c.label}</span>
                <div className="text-3xl font-bold text-white tabular-nums">{c.value}</div>
                <div className="text-[11px] text-zinc-500">{c.sub}</div>
              </div>
              <div className="w-10 h-10 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <Icon className={`w-5 h-5 ${c.accent}`} />
              </div>
            </Card>
          );
        })}
      </div>

      {/* Active Jobs Strip */}
      {recentJobs.some((j) => j.status === 'processing' || j.status === 'queued') && (
        <Card className="p-5 border-[#7C5CFF]/35 bg-[#151521] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Sparkles className="w-4 h-4 text-[#A58DFF]" /> Active Processing Pipeline
            </div>
            <Link to="/dashboard/queue" className="text-xs text-[#A58DFF] hover:underline">
              Open Queue →
            </Link>
          </div>
          <div className="space-y-3">
            {recentJobs
              .filter((j) => j.status === 'processing' || j.status === 'queued')
              .map((job) => (
                <div
                  key={job._id}
                  className="p-3.5 rounded-xl bg-[#0E0E15] border border-white/10 space-y-2"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-zinc-200">
                      {typeof job.projectId === 'object' ? job.projectId.title : 'Video Job'} —{' '}
                      <span className="text-[#38BDF8]">
                        {PIPELINE_STAGE_LABELS[job.stage] || job.stage}
                      </span>
                    </span>
                    <span className="font-mono text-zinc-300 tabular-nums">
                      {job.progressPercent}%
                    </span>
                  </div>
                  <ProgressBar value={job.progressPercent} />
                  <div className="text-[11px] text-zinc-500">{job.currentMessage}</div>
                </div>
              ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Recent Projects */}
        <div className="lg:col-span-7 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Recent Projects</h2>
            <Link
              to="/dashboard/projects"
              className="text-xs text-zinc-400 hover:text-white inline-flex items-center gap-1"
            >
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {recentProjects.length === 0 ? (
            <EmptyState
              title="No video projects yet"
              description="Upload a long-form MP4/WebM recording or import an accessible media URL to generate your first batch of clips."
              action={
                <Link to="/dashboard/create">
                  <Button size="sm" leftIcon={<PlusCircle className="w-4 h-4" />}>
                    Create First Project
                  </Button>
                </Link>
              }
            />
          ) : (
            <div className="space-y-3">
              {recentProjects.map((project) => {
                const videoObj =
                  typeof project.videoId === 'object' && project.videoId !== null
                    ? project.videoId
                    : null;
                return (
                  <Link
                    key={project._id}
                    to={`/dashboard/projects/${project._id}`}
                    className="block"
                  >
                    <Card className="p-4 hover:border-white/20 transition-colors flex items-center justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2.5">
                          <h3 className="text-sm font-semibold text-zinc-100 truncate">
                            {project.title}
                          </h3>
                          {badgeForStatus(project.status)}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                          <span>Aspect: {project.settings.aspectRatio}</span>
                          {videoObj?.durationSec ? (
                            <span>Source: {formatDuration(videoObj.durationSec)}</span>
                          ) : null}
                          <span>{project.clipsCount || 0} clips</span>
                          <span>{formatRelativeTime(project.createdAt)}</span>
                        </div>
                      </div>
                      <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-white">Recent Activity</h2>
            <Activity className="w-4 h-4 text-zinc-500" />
          </div>

          <Card className="divide-y divide-white/[0.06]">
            {recentActivity.length === 0 ? (
              <div className="p-8 text-center text-xs text-zinc-500">
                Your processing milestones and credit events will appear here.
              </div>
            ) : (
              recentActivity.slice(0, 7).map((item) => (
                <div key={item._id} className="p-4 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-200">{item.title}</span>
                    <span className="text-[11px] text-zinc-500">
                      {formatRelativeTime(item.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">{item.message}</p>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};
