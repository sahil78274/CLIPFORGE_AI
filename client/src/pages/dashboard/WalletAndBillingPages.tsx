import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Coins,
  CreditCard,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Modal,
  Select,
  Skeleton,
} from '../../components/ui';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import type { CreditPackageItem } from '../../types/api';
import { formatCurrencyINR, formatDateTime } from '../../utils/format';
import { cn } from '../../utils/cn';

declare global {
  interface Window {
    Razorpay?: any;
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

/* ================= CREDIT WALLET PAGE ================= */
export const CreditWalletPage: React.FC = () => {
  const { user, updateWallet } = useAuthStore();
  const pushToast = useToastStore((s) => s.push);
  const queryClient = useQueryClient();

  const [txType, setTxType] = useState('');
  const [purchasingId, setPurchasingId] = useState<string | null>(null);
  const [sandboxModal, setSandboxModal] = useState<{
    pkg: CreditPackageItem;
    orderId: string;
    sandboxPaymentId: string;
    sandboxSignaturePreview: string;
  } | null>(null);
  const [verifyingSandbox, setVerifyingSandbox] = useState(false);

  const walletQuery = useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet.get(),
  });

  const packagesQuery = useQuery({
    queryKey: ['credit-packages'],
    queryFn: () => api.payments.packages(),
  });

  const capsQuery = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: () => api.jobs.capabilities(),
  });

  const txQuery = useQuery({
    queryKey: ['wallet-transactions', txType],
    queryFn: () => api.wallet.transactions({ limit: 30, type: txType || undefined }),
  });

  const wallet = walletQuery.data?.wallet;
  const razorpayConfigured = capsQuery.data?.payments.razorpayConfigured ?? false;
  const sandboxEnabled = capsQuery.data?.payments.sandboxSimulatorEnabled ?? false;

  const handlePurchasePackage = async (pkg: CreditPackageItem) => {
    setPurchasingId(pkg._id);
    try {
      if (razorpayConfigured) {
        const scriptReady = await loadRazorpayScript();
        if (!scriptReady || !window.Razorpay) {
          throw new Error('Could not load Razorpay checkout SDK. Check internet connectivity.');
        }
        const order = await api.payments.createOrder(pkg._id, false);
        const rzp = new window.Razorpay({
          key: order.keyId,
          amount: order.amountPaise,
          currency: order.currency,
          name: 'ClipForge AI',
          description: `${pkg.name} (${pkg.credits} Credits)`,
          order_id: order.orderId,
          prefill: {
            name: user?.name || '',
            email: user?.email || '',
          },
          theme: { color: '#7C5CFF' },
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            const verified = await api.payments.verifyPayment({
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            });
            updateWallet(verified.wallet);
            void queryClient.invalidateQueries({ queryKey: ['wallet'] });
            void queryClient.invalidateQueries({ queryKey: ['wallet-transactions'] });
            pushToast({
              type: 'success',
              title: 'Payment verified!',
              description: `${pkg.credits} credits added to your wallet.`,
            });
          },
        });
        rzp.open();
      } else if (sandboxEnabled) {
        const order = await api.payments.createOrder(pkg._id, true);
        setSandboxModal({
          pkg,
          orderId: order.orderId,
          sandboxPaymentId: order.sandboxPaymentId || `pay_sandbox_${Date.now()}`,
          sandboxSignaturePreview: order.sandboxSignaturePreview || '',
        });
      } else {
        pushToast({
          type: 'warning',
          title: 'Razorpay Not Configured',
          description:
            'Configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in server environment variables.',
        });
      }
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Unable to initiate checkout',
        description: err?.message,
      });
    } finally {
      setPurchasingId(null);
    }
  };

  const handleConfirmSandboxVerification = async () => {
    if (!sandboxModal) return;
    setVerifyingSandbox(true);
    try {
      const verified = await api.payments.verifyPayment({
        razorpayOrderId: sandboxModal.orderId,
        razorpayPaymentId: sandboxModal.sandboxPaymentId,
        razorpaySignature: sandboxModal.sandboxSignaturePreview,
      });
      updateWallet(verified.wallet);
      setSandboxModal(null);
      void queryClient.invalidateQueries({ queryKey: ['wallet'] });
      void queryClient.invalidateQueries({ queryKey: ['wallet-transactions'] });
      void queryClient.invalidateQueries({ queryKey: ['billing-history'] });
      pushToast({
        type: 'info',
        title: 'Sandbox Order Verified (Development Mode)',
        description: `${sandboxModal.pkg.credits} sandbox test credits granted.`,
      });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Signature verification failed',
        description: err?.message,
      });
    } finally {
      setVerifyingSandbox(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Credit Wallet</h1>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          Manage processing credits, purchase credit packages, and audit your immutable ledger.
        </p>
      </div>

      {/* Payment Gateway Mode Notice */}
      {!razorpayConfigured && (
        <Card className="p-4 border-amber-500/35 bg-amber-500/[0.07] flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <div className="font-semibold text-amber-200">
              {sandboxEnabled
                ? 'DEVELOPMENT PAYMENT SANDBOX MODE — LIVE RAZORPAY KEYS NOT CONFIGURED'
                : 'PAYMENTS NOT CONFIGURED'}
            </div>
            <p className="text-amber-100/80 leading-relaxed">
              {sandboxEnabled
                ? 'Live RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not set. Package buttons below launch the labelled Development Sandbox Simulator to test server-side HMAC signature verification and ledger accounting. Sandbox transactions are explicitly flagged and never counted as real revenue.'
                : 'Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET in .env to enable live Indian INR payments.'}
            </p>
          </div>
        </Card>
      )}

      {/* Wallet Balances */}
      {walletQuery.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-5 space-y-1">
            <span className="text-xs text-zinc-400">Available Balance</span>
            <div className="text-3xl font-bold text-white tabular-nums">
              {wallet?.availableCredits ?? 0}
            </div>
            <span className="text-[11px] text-emerald-400">Ready for new jobs</span>
          </Card>
          <Card className="p-5 space-y-1">
            <span className="text-xs text-zinc-400">Reserved in Active Jobs</span>
            <div className="text-3xl font-bold text-amber-300 tabular-nums">
              {wallet?.reservedCredits ?? 0}
            </div>
            <span className="text-[11px] text-zinc-500">Auto-released on failure</span>
          </Card>
          <Card className="p-5 space-y-1">
            <span className="text-xs text-zinc-400">Lifetime Earned / Purchased</span>
            <div className="text-3xl font-bold text-zinc-100 tabular-nums">
              {(wallet?.lifetimeEarnedCredits ?? 0) + (wallet?.lifetimePurchasedCredits ?? 0)}
            </div>
            <span className="text-[11px] text-zinc-500">Welcome + top-ups</span>
          </Card>
          <Card className="p-5 space-y-1">
            <span className="text-xs text-zinc-400">Lifetime Consumed</span>
            <div className="text-3xl font-bold text-zinc-100 tabular-nums">
              {wallet?.lifetimeUsedCredits ?? 0}
            </div>
            <span className="text-[11px] text-zinc-500">Settled completed jobs</span>
          </Card>
        </div>
      )}

      {/* Credit Packages */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Purchase Credit Packages</h2>
          <Badge variant={razorpayConfigured ? 'success' : 'warning'}>
            <ShieldCheck className="w-3 h-3" />{' '}
            {razorpayConfigured ? 'Razorpay Live / Test Gateway' : 'Dev Sandbox Simulator'}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {(packagesQuery.data?.items || []).map((pkg) => (
            <Card
              key={pkg._id}
              className={cn(
                'p-6 flex flex-col justify-between gap-5',
                pkg.popular && 'border-[#7C5CFF]/50 shadow-glow'
              )}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">{pkg.name}</h3>
                  {pkg.popular && <Badge variant="brand">Popular</Badge>}
                </div>
                <div>
                  <span className="text-3xl font-bold text-white tabular-nums">
                    {formatCurrencyINR(pkg.amountPaise)}
                  </span>
                  <span className="text-xs text-[#A58DFF] ml-2 font-semibold">
                    +{pkg.credits} credits
                  </span>
                </div>
                <p className="text-xs text-zinc-400">{pkg.description}</p>
                <ul className="space-y-1.5 pt-2 border-t border-white/[0.07]">
                  {pkg.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-zinc-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Button
                variant={pkg.popular ? 'primary' : 'secondary'}
                loading={purchasingId === pkg._id}
                onClick={() => handlePurchasePackage(pkg)}
                leftIcon={<Coins className="w-4 h-4" />}
              >
                {razorpayConfigured
                  ? `Buy ${pkg.credits} Credits`
                  : `Test ${pkg.credits} Credits (Sandbox)`}
              </Button>
            </Card>
          ))}
        </div>
      </div>

      {/* Immutable Ledger */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-white">Immutable Credit Transaction Ledger</h2>
          <div className="w-full sm:w-56">
            <Select
              value={txType}
              onChange={(e) => setTxType(e.target.value)}
              options={[
                { value: '', label: 'All ledger entries' },
                { value: 'welcome_bonus', label: 'Welcome bonus' },
                { value: 'purchase', label: 'Package purchases' },
                { value: 'reserve', label: 'Job reservations' },
                { value: 'deduct', label: 'Job settlements' },
                { value: 'release_reserve', label: 'Failed/cancelled releases' },
                { value: 'admin_adjustment', label: 'Admin adjustments' },
              ]}
            />
          </div>
        </div>

        <Card className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/[0.08] text-zinc-400">
                <th className="py-3 px-4 font-medium">Timestamp</th>
                <th className="py-3 px-4 font-medium">Event Type</th>
                <th className="py-3 px-4 font-medium">Description</th>
                <th className="py-3 px-4 font-medium text-right">Amount</th>
                <th className="py-3 px-4 font-medium text-right">Available After</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {(txQuery.data?.items || []).map((tx) => {
                const positive = tx.amount > 0;
                return (
                  <tr key={tx._id} className="hover:bg-white/[0.02]">
                    <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">
                      {formatDateTime(tx.createdAt)}
                    </td>
                    <td className="py-3 px-4">
                      <Badge
                        variant={
                          tx.type === 'purchase' || tx.type === 'welcome_bonus'
                            ? 'success'
                            : tx.type === 'release_reserve'
                            ? 'info'
                            : tx.type === 'reserve'
                            ? 'warning'
                            : 'default'
                        }
                      >
                        {tx.type.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-zinc-200">{tx.description}</td>
                    <td
                      className={cn(
                        'py-3 px-4 text-right font-mono font-semibold tabular-nums whitespace-nowrap',
                        positive ? 'text-emerald-400' : 'text-zinc-200'
                      )}
                    >
                      <span className="inline-flex items-center gap-0.5">
                        {positive ? (
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowDownRight className="w-3.5 h-3.5 text-amber-400" />
                        )}
                        {positive ? `+${tx.amount}` : tx.amount}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-zinc-300 tabular-nums">
                      {tx.balanceAfter}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Development Sandbox Checkout Simulator Modal */}
      <Modal
        open={Boolean(sandboxModal)}
        onClose={() => setSandboxModal(null)}
        title="Development Payment Sandbox Simulator"
        description="Simulates Razorpay HMAC-SHA256 signature verification for local QA testing."
      >
        {sandboxModal && (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
              <strong>NON-PRODUCTION TEST ORDER:</strong> Marked with{' '}
              <code>isDevelopmentMode: true</code>. Never treated as real live revenue.
            </div>
            <div className="p-3.5 rounded-xl bg-[#0D0D13] border border-white/10 space-y-1.5 text-xs font-mono">
              <div className="text-zinc-400">
                Package: <span className="text-white">{sandboxModal.pkg.name}</span> (
                {sandboxModal.pkg.credits} cr)
              </div>
              <div className="text-zinc-400">
                Order ID: <span className="text-zinc-200">{sandboxModal.orderId}</span>
              </div>
              <div className="text-zinc-400 truncate">
                HMAC Sig: <span className="text-emerald-300">{sandboxModal.sandboxSignaturePreview}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setSandboxModal(null)}>
                Cancel
              </Button>
              <Button loading={verifyingSandbox} onClick={handleConfirmSandboxVerification}>
                Verify HMAC Signature & Credit Sandbox Wallet
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

/* ================= BILLING HISTORY PAGE ================= */
export const BillingHistoryPage: React.FC = () => {
  const historyQuery = useQuery({
    queryKey: ['billing-history'],
    queryFn: () => api.payments.history(),
  });

  if (historyQuery.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  if (historyQuery.isError) {
    return (
      <ErrorState
        message={(historyQuery.error as any)?.message || 'Failed to load billing history'}
        onRetry={() => historyQuery.refetch()}
      />
    );
  }

  const items = historyQuery.data?.items || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Billing History</h1>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          Complete record of Razorpay orders, verified signature settlements, and refunds.
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<CreditCard className="w-5 h-5" />}
          title="No payment records yet"
          description="Purchased credit packages and receipts will appear here."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-white/[0.08] text-zinc-400">
                <th className="py-3.5 px-4 font-medium">Date</th>
                <th className="py-3.5 px-4 font-medium">Package</th>
                <th className="py-3.5 px-4 font-medium">Order ID</th>
                <th className="py-3.5 px-4 font-medium">Mode</th>
                <th className="py-3.5 px-4 font-medium">Status</th>
                <th className="py-3.5 px-4 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05]">
              {items.map((p) => (
                <tr key={p._id} className="hover:bg-white/[0.02]">
                  <td className="py-3.5 px-4 text-zinc-400 whitespace-nowrap">
                    {formatDateTime(p.createdAt)}
                  </td>
                  <td className="py-3.5 px-4 text-white font-medium">
                    {p.packageSnapshot.name} ({p.creditsGranted} cr)
                  </td>
                  <td className="py-3.5 px-4 font-mono text-zinc-400">
                    {p.razorpayOrderId || '—'}
                  </td>
                  <td className="py-3.5 px-4">
                    {p.isDevelopmentMode ? (
                      <Badge variant="warning">DEV SANDBOX</Badge>
                    ) : (
                      <Badge variant="brand">LIVE RAZORPAY</Badge>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    <Badge
                      variant={
                        p.status === 'verified' || p.status === 'captured'
                          ? 'success'
                          : p.status === 'refunded'
                          ? 'info'
                          : p.status === 'failed'
                          ? 'danger'
                          : 'default'
                      }
                    >
                      {p.status}
                    </Badge>
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono font-semibold text-white tabular-nums">
                    {formatCurrencyINR(p.amountPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};
