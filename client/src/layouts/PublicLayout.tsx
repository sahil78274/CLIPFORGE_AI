import React, { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { ArrowRight, Menu, X } from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { Button } from '../components/ui';
import { useAuthStore } from '../stores/authStore';
import { cn } from '../utils/cn';

const NAV_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/features', label: 'Features' },
  { to: '/how-it-works', label: 'How It Works' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
];

export const PublicLayout: React.FC = () => {
  const { user } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-[#09090B] text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-white/[0.07] glass-surface">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <Link to="/" aria-label="ClipForge AI Home">
            <BrandLogo />
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'px-3.5 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'text-white bg-white/[0.06]'
                      : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.03]'
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                {user.role === 'admin' && (
                  <Link to="/admin">
                    <Button variant="ghost" size="sm">
                      Admin Console
                    </Button>
                  </Link>
                )}
                <Link to="/dashboard">
                  <Button size="sm" rightIcon={<ArrowRight className="w-3.5 h-3.5" />}>
                    Open Studio
                  </Button>
                </Link>
              </>
            ) : (
              <>
                <Link to="/login">
                  <Button variant="ghost" size="sm">
                    Sign In
                  </Button>
                </Link>
                <Link to="/register">
                  <Button size="sm" rightIcon={<ArrowRight className="w-3.5 h-3.5" />}>
                    Start Free
                  </Button>
                </Link>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden p-2 rounded-lg text-zinc-300 hover:bg-white/[0.06]"
            aria-label="Toggle Menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {mobileOpen && (
          <div className="md:hidden border-t border-white/[0.07] bg-[#0D0D12] px-4 py-4 space-y-2">
            {NAV_LINKS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'block px-3.5 py-2.5 rounded-xl text-sm font-medium',
                    isActive ? 'bg-[#7C5CFF]/15 text-white' : 'text-zinc-400 hover:text-white'
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
            <div className="pt-3 border-t border-white/[0.07] flex flex-col gap-2">
              {user ? (
                <Link to="/dashboard" onClick={() => setMobileOpen(false)}>
                  <Button className="w-full">Open Studio</Button>
                </Link>
              ) : (
                <>
                  <Link to="/login" onClick={() => setMobileOpen(false)}>
                    <Button variant="secondary" className="w-full">
                      Sign In
                    </Button>
                  </Link>
                  <Link to="/register" onClick={() => setMobileOpen(false)}>
                    <Button className="w-full">Create Free Account</Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-white/[0.08] bg-[#0B0B0F] mt-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-10">
            <div className="space-y-3">
              <BrandLogo />
              <p className="text-xs text-zinc-400 leading-relaxed max-w-xs">
                AI-powered long-form to short-form video repurposing platform with frame-accurate
                FFmpeg rendering, smart speaker reframing, and animated captions.
              </p>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-3">
                Product
              </h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>
                  <Link to="/features" className="hover:text-white transition-colors">
                    Features
                  </Link>
                </li>
                <li>
                  <Link to="/how-it-works" className="hover:text-white transition-colors">
                    How It Works
                  </Link>
                </li>
                <li>
                  <Link to="/pricing" className="hover:text-white transition-colors">
                    Credit Packages
                  </Link>
                </li>
                <li>
                  <Link to="/dashboard/create" className="hover:text-white transition-colors">
                    Clip Studio
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-3">
                Company
              </h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>
                  <Link to="/about" className="hover:text-white transition-colors">
                    About ClipForge AI
                  </Link>
                </li>
                <li>
                  <Link to="/contact" className="hover:text-white transition-colors">
                    Contact & Support
                  </Link>
                </li>
                <li>
                  <Link to="/login" className="hover:text-white transition-colors">
                    Creator Sign In
                  </Link>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-300 mb-3">
                Legal & Compliance
              </h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>
                  <Link to="/privacy" className="hover:text-white transition-colors">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="hover:text-white transition-colors">
                    Terms & Conditions
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="mt-12 pt-6 border-t border-white/[0.06] flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
            <span>© {new Date().getFullYear()} ClipForge AI. Built for creators and teams.</span>
            <span>Respects platform Terms of Service, copyright, and creator ownership.</span>
          </div>
        </div>
      </footer>
    </div>
  );
};
