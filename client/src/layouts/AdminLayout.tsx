import React from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  CreditCard,
  ListChecks,
  ShieldAlert,
  Sliders,
  Users,
} from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { Badge, Button } from '../components/ui';
import { cn } from '../utils/cn';

const ADMIN_NAV = [
  { to: '/admin', label: 'System Overview', icon: Activity, end: true },
  { to: '/admin/users', label: 'Users & Wallets', icon: Users },
  { to: '/admin/jobs', label: 'Processing History', icon: ListChecks },
  { to: '/admin/payments', label: 'Payments & Refunds', icon: CreditCard },
  { to: '/admin/config', label: 'Packages, Limits & Logs', icon: Sliders },
];

export const AdminLayout: React.FC = () => {
  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex flex-col">
      <header className="sticky top-0 z-30 border-b border-white/[0.08] glass-surface">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link to="/admin">
              <BrandLogo />
            </Link>
            <Badge variant="warning">
              <ShieldAlert className="w-3 h-3" /> Admin Console
            </Badge>
          </div>
          <Link to="/dashboard">
            <Button variant="secondary" size="sm" leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}>
              Creator Studio
            </Button>
          </Link>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto pb-2">
          {ADMIN_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-colors',
                    isActive
                      ? 'bg-[#7C5CFF]/20 text-white border border-[#7C5CFF]/35'
                      : 'text-zinc-400 hover:text-white hover:bg-white/[0.04]'
                  )
                }
              >
                <Icon className="w-3.5 h-3.5" />
                {item.label}
              </NavLink>
            );
          })}
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
};
