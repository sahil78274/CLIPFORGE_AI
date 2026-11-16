import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Ban,
  CheckCircle2,
  Coins,
  Plus,
  RotateCcw,
  Save,
  Search,
  Server,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Input,
  Modal,
  Select,
  Skeleton,
  Switch,
} from '../../components/ui';
import { api } from '../../services/api';
import { useToastStore } from '../../stores/toastStore';
import type { CreditPackageItem, User, WalletSummary } from '../../types/api';
import { formatCurrencyINR, formatDateTime } from '../../utils/format';

/* ================= ADMIN OVERVIEW ================= */
export const AdminOverviewPage: React.FC = () => {
  const overviewQuery = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => api.admin.overview(),
    refetchInterval: 6000,
  });

  if (overviewQuery.isLoading) return <Skeleton className="h-72 w-full" />;
  if (overviewQuery.isError)
    return (
      <ErrorState
        message={(overviewQuery.error as any)?.message || 'Failed to load admin telemetry'}
        onRetry={() => overviewQuery.refetch()}
      />
    );

  const d = overviewQuery.data;

  const kpis = [
    { label: 'Total Users', val: d.metrics.totalUsers, sub: `${d.metrics.activeUsers} active` },
    { label: 'Total Projects', val: d.metrics.totalProjects, sub: 'Across workspace' },
    { label: 'Total Clips Rendered', val: d.metrics.totalClips, sub: 'Validated MP4 outputs' },
    {
      label: 'Processing Jobs',
      val: d.metrics.totalJobs,
      sub: `${d.metrics.failedJobs} failed • ${d.metrics.activeJobs} active`,
    },
    {
      label: 'Verified Live Revenue',
      val: formatCurrencyINR(d.metrics.liveRevenuePaise),
      sub: `Sandbox test vol: ${formatCurrencyINR(d.metrics.sandboxVolumePaise)}`,
    },
    {
      label: 'Total Credit Usage',
      val: d.metrics.totalCreditsUsed,
      sub: `${d.metrics.paymentCount} payment records`,
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Platform Telemetry & Health</h1>
        <p className="text-xs text-zinc-400 mt-1">
          Real-time operational metrics, queue status, and external service health.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((k) => (
          <Card key={k.label} className="p-5 space-y-1">
            <span className="text-xs text-zinc-400">{k.label}</span>
            <div className="text-2xl font-bold text-white tabular-nums">{k.val}</div>
            <div className="text-[11px] text-zinc-500">{k.sub}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Card className="p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Server className="w-4 h-4 text-[#A58DFF]" /> API & Media Engine Health
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-400">Database Connection</span>
              <Badge variant="success">{d.health.database}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">FFmpeg / FFprobe Binaries</span>
              <Badge variant={d.health.ffmpeg ? 'success' : 'danger'}>
                {d.health.ffmpeg ? 'OPERATIONAL' : 'UNAVAILABLE'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">AI Provider ({d.health.aiProvider})</span>
              <Badge variant={d.health.aiConfigured ? 'success' : 'warning'}>
                {d.health.aiConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Razorpay Gateway</span>
              <Badge variant={d.health.razorpayConfigured ? 'success' : 'warning'}>
                {d.health.razorpayConfigured ? 'LIVE / TEST KEYS SET' : 'DEV SANDBOX ONLY'}
              </Badge>
            </div>
          </div>
        </Card>

        <Card className="p-5 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Activity className="w-4 h-4 text-[#38BDF8]" /> Worker Queue Health
          </div>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-400">Queue Engine</span>
              <Badge variant="brand">{d.queue.mode}</Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Queued Jobs</span>
              <span className="font-mono text-white">{d.queue.queuedCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Processing Jobs</span>
              <span className="font-mono text-white">{d.queue.processingCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Failed Jobs</span>
              <span className="font-mono text-red-300">{d.queue.failedCount}</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

/* ================= ADMIN USERS & WALLETS ================= */
export const AdminUsersPage: React.FC = () => {
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [creditModalUser, setCreditModalUser] = useState<(User & { wallet?: WalletSummary }) | null>(
    null
  );
  const [creditDelta, setCreditDelta] = useState(50);
  const [creditReason, setCreditReason] = useState('');
  const [activityUserId, setActivityUserId] = useState<string | null>(null);

  const usersQuery = useQuery({
    queryKey: ['admin-users', search.trim()],
    queryFn: () => api.admin.users({ search: search.trim() || undefined }),
  });

  const activityQuery = useQuery({
    queryKey: ['admin-user-activity', activityUserId],
    queryFn: () => api.admin.userActivity(activityUserId!),
    enabled: Boolean(activityUserId),
  });

  const handleToggleStatus = async (u: User) => {
    const next = u.status === 'active' ? 'suspended' : 'active';
    const reason =
      window.prompt(`Reason for setting ${u.email} to ${next}:`, 'Administrative review') || '';
    if (!reason.trim()) return;
    try {
      await api.admin.updateUserStatus(u.id, next, reason.trim());
      pushToast({ type: 'success', title: `User ${next}` });
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Action failed', description: err?.message });
    }
  };

  const handleAdjustCredits = async () => {
    if (!creditModalUser || !creditReason.trim() || creditDelta === 0) return;
    try {
      await api.admin.adjustCredits(creditModalUser.id, Number(creditDelta), creditReason.trim());
      pushToast({ type: 'success', title: 'Wallet adjusted & logged' });
      setCreditModalUser(null);
      setCreditReason('');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Adjustment failed', description: err?.message });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">User & Wallet Management</h1>
          <p className="text-xs text-zinc-400 mt-1">
            Inspect accounts, suspend/restore access, and issue audited credit adjustments.
          </p>
        </div>
        <div className="w-full sm:w-72">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<Search className="w-4 h-4" />}
            placeholder="Search by name or email..."
          />
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/[0.08] text-zinc-400">
              <th className="py-3.5 px-4">User</th>
              <th className="py-3.5 px-4">Role</th>
              <th className="py-3.5 px-4">Status</th>
              <th className="py-3.5 px-4 text-right">Available Credits</th>
              <th className="py-3.5 px-4">Joined</th>
              <th className="py-3.5 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {(usersQuery.data?.items || []).map((u) => (
              <tr key={u.id} className="hover:bg-white/[0.02]">
                <td className="py-3 px-4">
                  <div className="font-medium text-white">{u.name}</div>
                  <div className="text-zinc-500">{u.email}</div>
                </td>
                <td className="py-3 px-4">
                  <Badge variant={u.role === 'admin' ? 'warning' : 'default'}>{u.role}</Badge>
                </td>
                <td className="py-3 px-4">
                  <Badge variant={u.status === 'active' ? 'success' : 'danger'}>{u.status}</Badge>
                </td>
                <td className="py-3 px-4 text-right font-mono font-semibold text-white">
                  {u.wallet?.availableCredits ?? 0}
                </td>
                <td className="py-3 px-4 text-zinc-400">{formatDateTime(u.createdAt)}</td>
                <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setActivityUserId(u.id)}
                  >
                    Activity
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setCreditModalUser(u)}
                    leftIcon={<Coins className="w-3.5 h-3.5" />}
                  >
                    Credits
                  </Button>
                  {u.role !== 'admin' && (
                    <Button
                      variant={u.status === 'active' ? 'danger' : 'outline'}
                      size="sm"
                      onClick={() => handleToggleStatus(u)}
                      leftIcon={
                        u.status === 'active' ? (
                          <Ban className="w-3.5 h-3.5" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )
                      }
                    >
                      {u.status === 'active' ? 'Suspend' : 'Restore'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Credit Adjustment Modal */}
      <Modal
        open={Boolean(creditModalUser)}
        onClose={() => setCreditModalUser(null)}
        title={`Adjust Credits — ${creditModalUser?.email || ''}`}
        description="Logged permanently in CreditTransaction and AdminAuditLog."
      >
        <div className="space-y-4">
          <Input
            label="Credit Delta (use negative integer to deduct)"
            type="number"
            value={creditDelta}
            onChange={(e) => setCreditDelta(Number(e.target.value))}
          />
          <Input
            label="Audit Reason (Required)"
            required
            value={creditReason}
            onChange={(e) => setCreditReason(e.target.value)}
            placeholder="e.g., Promotional creator grant or support compensation"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreditModalUser(null)}>
              Cancel
            </Button>
            <Button onClick={handleAdjustCredits}>Apply Adjustment</Button>
          </div>
        </div>
      </Modal>

      {/* User Activity Modal */}
      <Modal
        open={Boolean(activityUserId)}
        onClose={() => setActivityUserId(null)}
        title="User Activity Inspection"
        size="lg"
      >
        {activityQuery.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : activityQuery.data ? (
          <div className="space-y-4 text-xs">
            <div>
              <div className="font-semibold text-white mb-1">
                Projects ({activityQuery.data.projects?.length || 0})
              </div>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {(activityQuery.data.projects || []).map((p: any) => (
                  <div
                    key={p._id}
                    className="p-2 rounded bg-[#0E0E14] flex justify-between text-zinc-300"
                  >
                    <span>{p.title}</span>
                    <Badge>{p.status}</Badge>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="font-semibold text-white mb-1">
                Recent Ledger Entries ({activityQuery.data.transactions?.length || 0})
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {(activityQuery.data.transactions || []).map((t: any) => (
                  <div
                    key={t._id}
                    className="p-2 rounded bg-[#0E0E14] flex justify-between text-zinc-300"
                  >
                    <span>{t.description}</span>
                    <span className="font-mono">{t.amount > 0 ? `+${t.amount}` : t.amount}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
};

/* ================= ADMIN JOBS HISTORY ================= */
export const AdminJobsPage: React.FC = () => {
  const [status, setStatus] = useState('');
  const jobsQuery = useQuery({
    queryKey: ['admin-jobs', status],
    queryFn: () => api.admin.jobs({ status: status || undefined }),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Platform Processing History</h1>
          <p className="text-xs text-zinc-400 mt-1">
            Monitor background jobs, stage telemetry, and failure diagnostics across all users.
          </p>
        </div>
        <div className="w-48">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'processing', label: 'Processing' },
              { value: 'completed', label: 'Completed' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
        </div>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/[0.08] text-zinc-400">
              <th className="py-3 px-4">Created</th>
              <th className="py-3 px-4">User</th>
              <th className="py-3 px-4">Project</th>
              <th className="py-3 px-4">Stage / Progress</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Diagnostics / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {(jobsQuery.data?.items || []).map((j: any) => (
              <tr key={j._id}>
                <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">
                  {formatDateTime(j.createdAt)}
                </td>
                <td className="py-3 px-4 text-zinc-200">{j.userId?.email || '—'}</td>
                <td className="py-3 px-4 text-white font-medium">{j.projectId?.title || '—'}</td>
                <td className="py-3 px-4 font-mono text-zinc-300">
                  {j.stage} ({j.progressPercent}%)
                </td>
                <td className="py-3 px-4">
                  <Badge
                    variant={
                      j.status === 'completed'
                        ? 'success'
                        : j.status === 'failed'
                        ? 'danger'
                        : 'warning'
                    }
                  >
                    {j.status}
                  </Badge>
                </td>
                <td className="py-3 px-4 text-zinc-400 max-w-xs truncate">
                  {j.error?.message || j.currentMessage}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

/* ================= ADMIN PAYMENTS & REFUNDS ================= */
export const AdminPaymentsPage: React.FC = () => {
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const paymentsQuery = useQuery({
    queryKey: ['admin-payments'],
    queryFn: () => api.admin.payments(),
  });

  const handleRefund = async (paymentId: string) => {
    const reason = window.prompt('Enter refund reason (logged in audit trail):', 'Customer request');
    if (!reason?.trim()) return;
    try {
      await api.admin.refundPayment(paymentId, reason.trim());
      pushToast({ type: 'success', title: 'Payment marked refunded & wallet updated' });
      void queryClient.invalidateQueries({ queryKey: ['admin-payments'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Refund failed', description: err?.message });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Payments & Refund Ledger</h1>
        <p className="text-xs text-zinc-400 mt-1">
          Audit verified Razorpay orders, sandbox test transactions, and refund records.
        </p>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-white/[0.08] text-zinc-400">
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">User</th>
              <th className="py-3 px-4">Package</th>
              <th className="py-3 px-4">Mode</th>
              <th className="py-3 px-4">Status</th>
              <th className="py-3 px-4 text-right">Amount</th>
              <th className="py-3 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {(paymentsQuery.data?.items || []).map((p: any) => (
              <tr key={p._id}>
                <td className="py-3 px-4 text-zinc-400">{formatDateTime(p.createdAt)}</td>
                <td className="py-3 px-4 text-zinc-200">{p.userId?.email || '—'}</td>
                <td className="py-3 px-4 text-white">
                  {p.packageSnapshot?.name} ({p.creditsGranted} cr)
                </td>
                <td className="py-3 px-4">
                  {p.isDevelopmentMode ? (
                    <Badge variant="warning">DEV SANDBOX</Badge>
                  ) : (
                    <Badge variant="brand">LIVE</Badge>
                  )}
                </td>
                <td className="py-3 px-4">
                  <Badge variant={p.status === 'verified' ? 'success' : 'default'}>
                    {p.status}
                  </Badge>
                </td>
                <td className="py-3 px-4 text-right font-mono text-white">
                  {formatCurrencyINR(p.amountPaise)}
                </td>
                <td className="py-3 px-4 text-right">
                  {p.status === 'verified' && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleRefund(p._id)}
                      leftIcon={<RotateCcw className="w-3 h-3" />}
                    >
                      Refund
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
};

/* ================= ADMIN CONFIG, PACKAGES & AUDIT LOGS ================= */
export const AdminConfigPage: React.FC = () => {
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['admin-config'],
    queryFn: () => api.admin.getConfig(),
  });
  const packagesQuery = useQuery({
    queryKey: ['admin-packages'],
    queryFn: () => api.admin.packages(),
  });
  const logsQuery = useQuery({
    queryKey: ['admin-audit-logs'],
    queryFn: () => api.admin.auditLogs(),
  });

  const [cfg, setCfg] = useState<any>(null);
  const [editingPkg, setEditingPkg] = useState<Partial<CreditPackageItem> | null>(null);

  useEffect(() => {
    if (configQuery.data?.config) {
      setCfg(configQuery.data.config);
    }
  }, [configQuery.data]);

  const handleSaveConfig = async () => {
    try {
      await api.admin.updateConfig(cfg);
      pushToast({ type: 'success', title: 'System limits & platform rules updated' });
      void queryClient.invalidateQueries({ queryKey: ['admin-config'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-audit-logs'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Config update failed', description: err?.message });
    }
  };

  const handleSavePackage = async () => {
    if (!editingPkg) return;
    try {
      await api.admin.upsertPackage(editingPkg);
      pushToast({ type: 'success', title: 'Credit package saved' });
      setEditingPkg(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-packages'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-audit-logs'] });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Could not save package', description: err?.message });
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">
          Credit Packages, System Limits & Audit Trail
        </h1>
        <p className="text-xs text-zinc-400 mt-1">
          Configure package pricing, processing quotas, supported platforms, and audit logs.
        </p>
      </div>

      {/* Credit Packages Manager */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Configurable Credit Packages</h2>
          <Button
            size="sm"
            leftIcon={<Plus className="w-3.5 h-3.5" />}
            onClick={() =>
              setEditingPkg({
                name: 'Custom Studio Pack',
                slug: `pack-${Date.now()}`,
                description: 'Configurable credit top-up package',
                credits: 200,
                amountPaise: 99900,
                currency: 'INR',
                popular: false,
                active: true,
                features: ['200 processing credits', 'All aspect ratios & AI metadata'],
                sortOrder: 4,
              })
            }
          >
            Add Package
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(packagesQuery.data?.items || []).map((pkg) => (
            <div
              key={pkg._id}
              className="p-4 rounded-xl bg-[#0E0E14] border border-white/10 space-y-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white text-sm">{pkg.name}</span>
                <Badge variant={pkg.active ? 'success' : 'default'}>
                  {pkg.active ? 'Active' : 'Hidden'}
                </Badge>
              </div>
              <div className="text-lg font-bold text-white">
                {formatCurrencyINR(pkg.amountPaise)} • {pkg.credits} cr
              </div>
              <p className="text-zinc-400">{pkg.description}</p>
              <Button variant="secondary" size="sm" onClick={() => setEditingPkg(pkg)}>
                Edit Pricing / Credits
              </Button>
            </div>
          ))}
        </div>
      </Card>

      {/* System Limits */}
      {cfg && (
        <Card className="p-6 space-y-5">
          <h2 className="text-base font-semibold text-white">System Quotas & Credit Formula</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Input
              label="Welcome Credits (New Users)"
              type="number"
              value={cfg.welcomeCredits}
              onChange={(e) => setCfg({ ...cfg, welcomeCredits: Number(e.target.value) })}
            />
            <Input
              label="Credits Per Video Minute"
              type="number"
              value={cfg.creditsPerMinuteProcessed}
              onChange={(e) =>
                setCfg({ ...cfg, creditsPerMinuteProcessed: Number(e.target.value) })
              }
            />
            <Input
              label="Minimum Credits Per Job"
              type="number"
              value={cfg.minCreditsPerJob}
              onChange={(e) => setCfg({ ...cfg, minCreditsPerJob: Number(e.target.value) })}
            />
            <Input
              label="Max Upload Size (MB)"
              type="number"
              value={cfg.maxUploadSizeMb}
              onChange={(e) => setCfg({ ...cfg, maxUploadSizeMb: Number(e.target.value) })}
            />
            <Input
              label="Max Video Duration (Seconds)"
              type="number"
              value={cfg.maxVideoDurationSec}
              onChange={(e) => setCfg({ ...cfg, maxVideoDurationSec: Number(e.target.value) })}
            />
            <Input
              label="Max Clips Per Job"
              type="number"
              value={cfg.maxClipsPerJob}
              onChange={(e) => setCfg({ ...cfg, maxClipsPerJob: Number(e.target.value) })}
            />
          </div>

          <div className="pt-3 border-t border-white/[0.07] space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Supported Source Platforms
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.keys(cfg.supportedPlatforms || {}).map((plat) => (
                <div
                  key={plat}
                  className="p-3 rounded-xl bg-[#0E0E14] border border-white/[0.08]"
                >
                  <Switch
                    checked={cfg.supportedPlatforms[plat]?.enabled ?? true}
                    onChange={(val) =>
                      setCfg({
                        ...cfg,
                        supportedPlatforms: {
                          ...cfg.supportedPlatforms,
                          [plat]: {
                            ...cfg.supportedPlatforms[plat],
                            enabled: val,
                          },
                        },
                      })
                    }
                    label={plat.toUpperCase()}
                  />
                </div>
              ))}
            </div>
          </div>

          <Button onClick={handleSaveConfig} leftIcon={<Save className="w-4 h-4" />}>
            Save System Configuration
          </Button>
        </Card>
      )}

      {/* Audit & Error Logs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">Immutable Admin Audit Logs</h3>
          <div className="max-h-72 overflow-y-auto space-y-2 text-xs">
            {(logsQuery.data?.items || []).map((log: any) => (
              <div
                key={log._id}
                className="p-3 rounded-xl bg-[#0E0E14] border border-white/[0.06] space-y-1"
              >
                <div className="flex justify-between">
                  <Badge variant="brand">{log.action}</Badge>
                  <span className="text-zinc-500">{formatDateTime(log.createdAt)}</span>
                </div>
                <div className="text-zinc-300">
                  Admin: {log.adminEmail} • Target: {log.targetType} ({log.targetId || 'system'})
                </div>
                {log.reason && <div className="text-zinc-400">Reason: {log.reason}</div>}
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">Recent Pipeline Error Logs</h3>
          <div className="max-h-72 overflow-y-auto space-y-2 text-xs">
            {(logsQuery.data?.errorLogs || []).length === 0 ? (
              <div className="text-zinc-500 py-6 text-center">No failed job errors recorded.</div>
            ) : (
              (logsQuery.data?.errorLogs || []).map((errJob: any) => (
                <div
                  key={errJob._id}
                  className="p-3 rounded-xl bg-red-500/[0.06] border border-red-500/20 space-y-1"
                >
                  <div className="flex justify-between text-red-300 font-medium">
                    <span>Stage: {errJob.error?.stage || errJob.stage}</span>
                    <span>{formatDateTime(errJob.updatedAt || errJob.createdAt)}</span>
                  </div>
                  <div className="text-zinc-300">{errJob.error?.message}</div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* Package Editor Modal */}
      <Modal
        open={Boolean(editingPkg)}
        onClose={() => setEditingPkg(null)}
        title={editingPkg?._id ? 'Edit Credit Package' : 'Create Credit Package'}
      >
        {editingPkg && (
          <div className="space-y-4">
            <Input
              label="Package Name"
              value={editingPkg.name || ''}
              onChange={(e) => setEditingPkg({ ...editingPkg, name: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Credits Granted"
                type="number"
                value={editingPkg.credits || 0}
                onChange={(e) =>
                  setEditingPkg({ ...editingPkg, credits: Number(e.target.value) })
                }
              />
              <Input
                label="Price in INR (₹)"
                type="number"
                value={Math.round((editingPkg.amountPaise || 0) / 100)}
                onChange={(e) =>
                  setEditingPkg({
                    ...editingPkg,
                    amountPaise: Math.round(Number(e.target.value) * 100),
                  })
                }
              />
            </div>
            <Input
              label="Description"
              value={editingPkg.description || ''}
              onChange={(e) => setEditingPkg({ ...editingPkg, description: e.target.value })}
            />
            <Switch
              checked={editingPkg.active ?? true}
              onChange={(v) => setEditingPkg({ ...editingPkg, active: v })}
              label="Package Active & Visible"
            />
            <Switch
              checked={editingPkg.popular ?? false}
              onChange={(v) => setEditingPkg({ ...editingPkg, popular: v })}
              label="Highlight as Popular"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingPkg(null)}>
                Cancel
              </Button>
              <Button onClick={handleSavePackage}>Save Package</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
