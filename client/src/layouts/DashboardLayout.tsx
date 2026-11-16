import React, { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Coins,
  CreditCard,
  Download,
  FolderKanban,
  HelpCircle,
  LayoutDashboard,
  ListVideo,
  LogOut,
  Menu,
  PlusCircle,
  Search,
  Settings,
  ShieldCheck,
  User as UserIcon,
  Wallet,
  X,
} from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { Badge, Button, Dropdown } from '../components/ui';
import { api } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../utils/cn';
import { formatRelativeTime } from '../utils/format';

const SIDEBAR_ITEMS = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/dashboard/create', label: 'Create Clips', icon: PlusCircle },
  { to: '/dashboard/projects', label: 'My Projects', icon: FolderKanban },
  { to: '/dashboard/queue', label: 'Processing Queue', icon: ListVideo },
  { to: '/dashboard/clips', label: 'Downloads', icon: Download },
  { to: '/dashboard/wallet', label: 'Credit Wallet', icon: Wallet },
  { to: '/dashboard/billing', label: 'Billing History', icon: CreditCard },
  { to: '/dashboard/settings', label: 'Settings', icon: Settings },
  { to: '/dashboard/support', label: 'Help & Support', icon: HelpCircle },
];

export const DashboardLayout: React.FC = () => {
  const { user, wallet, updateWallet, logout } = useAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const walletQuery = useQuery({
    queryKey: ['wallet'],
    queryFn: () => api.wallet.get(),
    refetchInterval: 10000,
  });

  useEffect(() => {
    if (walletQuery.data?.wallet) {
      updateWallet(walletQuery.data.wallet);
    }
  }, [walletQuery.data, updateWallet]);

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list(),
    refetchInterval: 12000,
  });

  const searchResultsQuery = useQuery({
    queryKey: ['global-search', searchQuery.trim()],
    queryFn: () => api.users.globalSearch(searchQuery.trim()),
    enabled: searchQuery.trim().length >= 2,
  });

  const handleLogout = async () => {
    await logout();
    queryClient.clear();
    navigate('/login');
  };

  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;
  const availableCredits = wallet?.availableCredits ?? 0;
  const reservedCredits = wallet?.reservedCredits ?? 0;

  const renderSidebarLinks = (onNavigate?: () => void) => (
    <div className="flex flex-col h-full justify-between">
      <div className="space-y-1 px-3 py-4">
        {SIDEBAR_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all',
                  isActive
                    ? 'bg-[#7C5CFF]/16 text-white border border-[#7C5CFF]/30 shadow-[0_2px_12px_-4px_rgba(124,92,255,0.35)]'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] border border-transparent'
                )
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{item.label}</span>
            </NavLink>
          );
        })}

        {user?.role === 'admin' && (
          <div className="pt-3 mt-3 border-t border-white/[0.07]">
            <NavLink
              to="/admin"
              onClick={onNavigate}
              className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Admin Dashboard</span>
            </NavLink>
          </div>
        )}
      </div>

      <div className="p-4 m-3 rounded-2xl bg-[#14141C] border border-white/[0.07] space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-zinc-400">Available Credits</span>
          <span className="font-semibold text-white tabular-nums">{availableCredits}</span>
        </div>
        {reservedCredits > 0 && (
          <div className="flex items-center justify-between text-[11px] text-amber-300/90">
            <span>Reserved in jobs</span>
            <span className="tabular-nums">{reservedCredits}</span>
          </div>
        )}
        <Link to="/dashboard/wallet" onClick={onNavigate} className="block">
          <Button variant="secondary" size="sm" className="w-full text-xs">
            Top Up Credits
          </Button>
        </Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:fixed lg:inset-y-0 bg-[#0D0D12] border-r border-white/[0.07] z-30">
        <div className="h-16 px-6 flex items-center border-b border-white/[0.07]">
          <Link to="/">
            <BrandLogo />
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto">{renderSidebarLinks()}</div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] bg-[#0D0D12] border-r border-white/10 flex flex-col h-full">
            <div className="h-16 px-5 flex items-center justify-between border-b border-white/[0.07]">
              <BrandLogo />
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {renderSidebarLinks(() => setMobileSidebarOpen(false))}
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-20 h-16 border-b border-white/[0.07] glass-surface px-4 sm:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1 max-w-lg">
            <button
              type="button"
              onClick={() => setMobileSidebarOpen(true)}
              className="lg:hidden p-2 rounded-lg text-zinc-300 hover:bg-white/[0.06]"
              aria-label="Open Navigation"
            >
              <Menu className="w-5 h-5" />
            </button>

            <div className="relative w-full">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 180)}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search projects or generated clips..."
                className="w-full h-9 pl-9 pr-3 rounded-xl bg-[#13131A] border border-white/10 text-xs sm:text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#7C5CFF]"
              />

              {searchFocused && searchQuery.trim().length >= 2 && (
                <div className="absolute left-0 right-0 mt-2 rounded-xl bg-[#16161E] border border-white/12 shadow-2xl p-2 z-50 max-h-80 overflow-y-auto">
                  {searchResultsQuery.isLoading ? (
                    <div className="p-3 text-xs text-zinc-400">Searching studio...</div>
                  ) : (
                    <>
                      {(searchResultsQuery.data?.projects.length ?? 0) === 0 &&
                      (searchResultsQuery.data?.clips.length ?? 0) === 0 ? (
                        <div className="p-3 text-xs text-zinc-400">
                          No matching projects or clips found.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {(searchResultsQuery.data?.projects.length ?? 0) > 0 && (
                            <div>
                              <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-zinc-500">
                                Projects
                              </div>
                              {searchResultsQuery.data?.projects.map((p) => (
                                <button
                                  key={p._id}
                                  type="button"
                                  onMouseDown={() => navigate(`/dashboard/projects/${p._id}`)}
                                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.06] flex items-center justify-between text-xs"
                                >
                                  <span className="text-zinc-200 truncate">{p.title}</span>
                                  <Badge>{p.status}</Badge>
                                </button>
                              ))}
                            </div>
                          )}
                          {(searchResultsQuery.data?.clips.length ?? 0) > 0 && (
                            <div>
                              <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-zinc-500">
                                Clips
                              </div>
                              {searchResultsQuery.data?.clips.map((c) => (
                                <button
                                  key={c._id}
                                  type="button"
                                  onMouseDown={() => navigate(`/dashboard/clips?highlight=${c._id}`)}
                                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-white/[0.06] flex items-center justify-between text-xs"
                                >
                                  <span className="text-zinc-200 truncate">{c.title}</span>
                                  <Badge variant="brand">{c.aspectRatio}</Badge>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3">
            {/* Credits Pill */}
            <Link
              to="/dashboard/wallet"
              className="inline-flex items-center gap-2 h-9 px-3 rounded-xl bg-[#15151E] hover:bg-[#1C1C28] border border-white/10 text-xs font-medium transition-colors"
            >
              <Coins className="w-3.5 h-3.5 text-[#9E85FF]" />
              <span className="tabular-nums text-white font-semibold">{availableCredits}</span>
              <span className="hidden sm:inline text-zinc-400">credits</span>
            </Link>

            {/* Notifications Dropdown */}
            <Dropdown
              trigger={
                <button
                  type="button"
                  className="relative h-9 w-9 rounded-xl bg-[#15151E] hover:bg-[#1C1C28] border border-white/10 flex items-center justify-center text-zinc-300"
                  aria-label="Notifications"
                >
                  <Bell className="w-4 h-4" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#7C5CFF] text-[10px] font-bold text-white flex items-center justify-center">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </button>
              }
            >
              {(close) => (
                <div className="w-80 max-w-[90vw]">
                  <div className="px-3.5 py-2.5 border-b border-white/[0.08] flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Notifications</span>
                    {unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={async () => {
                          await api.notifications.markAllRead();
                          void notificationsQuery.refetch();
                        }}
                        className="text-[11px] text-[#9E85FF] hover:underline"
                      >
                        Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-white/[0.05]">
                    {(notificationsQuery.data?.items.length ?? 0) === 0 ? (
                      <div className="p-4 text-xs text-zinc-400 text-center">
                        No notifications yet.
                      </div>
                    ) : (
                      notificationsQuery.data?.items.slice(0, 10).map((n) => (
                        <div
                          key={n._id}
                          onClick={async () => {
                            if (!n.isRead) {
                              await api.notifications.markRead(n._id);
                              void notificationsQuery.refetch();
                            }
                            if (n.actionUrl) navigate(n.actionUrl);
                            close();
                          }}
                          className={cn(
                            'px-3.5 py-2.5 hover:bg-white/[0.04] cursor-pointer transition-colors',
                            !n.isRead && 'bg-[#7C5CFF]/[0.06]'
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-zinc-100">{n.title}</span>
                            <span className="text-[10px] text-zinc-500">
                              {formatRelativeTime(n.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{n.message}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </Dropdown>

            {/* Profile Dropdown */}
            <Dropdown
              trigger={
                <button
                  type="button"
                  className="h-9 pl-2 pr-3 rounded-xl bg-[#15151E] hover:bg-[#1C1C28] border border-white/10 flex items-center gap-2"
                >
                  <div className="w-6 h-6 rounded-lg bg-[#7C5CFF]/25 border border-[#7C5CFF]/40 flex items-center justify-center text-xs font-semibold text-[#C8BAFF]">
                    {user?.name?.charAt(0).toUpperCase() || 'U'}
                  </div>
                  <span className="hidden sm:inline text-xs font-medium text-zinc-200 max-w-[110px] truncate">
                    {user?.name}
                  </span>
                </button>
              }
            >
              {(close) => (
                <div className="w-56">
                  <div className="px-3.5 py-2.5 border-b border-white/[0.08]">
                    <div className="text-xs font-semibold text-white truncate">{user?.name}</div>
                    <div className="text-[11px] text-zinc-400 truncate">{user?.email}</div>
                  </div>
                  <div className="py-1">
                    <button
                      type="button"
                      onClick={() => {
                        navigate('/dashboard/settings');
                        close();
                      }}
                      className="w-full px-3.5 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.05] flex items-center gap-2"
                    >
                      <UserIcon className="w-3.5 h-3.5" /> Account Settings
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        navigate('/dashboard/wallet');
                        close();
                      }}
                      className="w-full px-3.5 py-2 text-left text-xs text-zinc-300 hover:bg-white/[0.05] flex items-center gap-2"
                    >
                      <Wallet className="w-3.5 h-3.5" /> Credit Wallet
                    </button>
                    {user?.role === 'admin' && (
                      <button
                        type="button"
                        onClick={() => {
                          navigate('/admin');
                          close();
                        }}
                        className="w-full px-3.5 py-2 text-left text-xs text-amber-300 hover:bg-amber-500/10 flex items-center gap-2"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" /> Admin Dashboard
                      </button>
                    )}
                  </div>
                  <div className="pt-1 border-t border-white/[0.08]">
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        void handleLogout();
                      }}
                      className="w-full px-3.5 py-2 text-left text-xs text-red-300 hover:bg-red-500/10 flex items-center gap-2"
                    >
                      <LogOut className="w-3.5 h-3.5" /> Sign Out
                    </button>
                  </div>
                </div>
              )}
            </Dropdown>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
