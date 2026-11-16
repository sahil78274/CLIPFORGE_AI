import React, { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, KeyRound, Lock, Mail, User as UserIcon } from 'lucide-react';
import { BrandLogo } from '../../components/BrandLogo';
import { Badge, Button, Card, Input } from '../../components/ui';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';

/* ================= LOGIN PAGE ================= */
export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const setSession = useAuthStore((s) => s.setSession);
  const pushToast = useToastStore((s) => s.push);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as any)?.from || '/dashboard';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.auth.login({ email, password });
      setSession(res.user, res.wallet);
      pushToast({ type: 'success', title: `Welcome back, ${res.user.name}` });
      navigate(res.user.role === 'admin' && from === '/dashboard' ? '/dashboard' : from, {
        replace: true,
      });
    } catch (err: any) {
      setError(err?.message || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-120px)] flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md p-7 sm:p-8 space-y-6">
        <div className="space-y-2 text-center">
          <div className="flex justify-center mb-2">
            <BrandLogo compact />
          </div>
          <h1 className="text-xl font-bold text-white">Sign in to ClipForge AI</h1>
          <p className="text-xs text-zinc-400">
            Access your projects, generated clips, and credit wallet.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Email Address"
            type="email"
            required
            autoComplete="email"
            leftIcon={<Mail className="w-4 h-4" />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@studio.com"
          />
          <div className="space-y-1">
            <Input
              label="Password"
              type="password"
              required
              autoComplete="current-password"
              leftIcon={<Lock className="w-4 h-4" />}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            <div className="flex justify-end">
              <Link
                to="/forgot-password"
                className="text-xs text-[#A58DFF] hover:text-white transition-colors"
              >
                Forgot password?
              </Link>
            </div>
          </div>

          <Button
            type="submit"
            loading={loading}
            className="w-full"
            rightIcon={<ArrowRight className="w-4 h-4" />}
          >
            Sign In
          </Button>
        </form>

        <p className="text-center text-xs text-zinc-400 pt-2 border-t border-white/[0.07]">
          New to ClipForge AI?{' '}
          <Link to="/register" className="text-[#A58DFF] font-medium hover:underline">
            Create a free account
          </Link>
        </p>
      </Card>
    </div>
  );
};

/* ================= REGISTER PAGE ================= */
export const RegisterPage: React.FC = () => {
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const pushToast = useToastStore((s) => s.push);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.auth.register({ name, email, password });
      setSession(res.user, res.wallet);
      pushToast({
        type: 'success',
        title: 'Account created!',
        description: `${res.wallet.availableCredits} welcome credits added to your wallet.`,
      });
      navigate('/dashboard', { replace: true });
    } catch (err: any) {
      setError(err?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-120px)] flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md p-7 sm:p-8 space-y-6">
        <div className="space-y-2 text-center">
          <Badge variant="brand">Includes Free Welcome Credits</Badge>
          <h1 className="text-xl font-bold text-white pt-1">Create your creator account</h1>
          <p className="text-xs text-zinc-400">
            No credit card or monthly subscription required to start clipping.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Full Name"
            required
            leftIcon={<UserIcon className="w-4 h-4" />}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rohan Verma"
          />
          <Input
            label="Email Address"
            type="email"
            required
            autoComplete="email"
            leftIcon={<Mail className="w-4 h-4" />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="rohan@creator.in"
          />
          <Input
            label="Password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            leftIcon={<Lock className="w-4 h-4" />}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Minimum 8 characters"
            hint="Use at least 8 characters with letters and numbers."
          />

          <Button
            type="submit"
            loading={loading}
            className="w-full"
            rightIcon={<ArrowRight className="w-4 h-4" />}
          >
            Create Account
          </Button>
        </form>

        <p className="text-center text-xs text-zinc-400 pt-2 border-t border-white/[0.07]">
          Already registered?{' '}
          <Link to="/login" className="text-[#A58DFF] font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
};

/* ================= FORGOT & RESET PASSWORD PAGE ================= */
export const ForgotPasswordPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pushToast = useToastStore((s) => s.push);

  const initialToken = searchParams.get('token') || '';
  const [mode, setMode] = useState<'request' | 'reset'>(initialToken ? 'reset' : 'request');

  const [email, setEmail] = useState('');
  const [token, setToken] = useState(initialToken);
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.auth.forgotPassword(email);
      setStatusMsg(res.message);
      if (res.devResetToken) {
        setToken(res.devResetToken);
        setMode('reset');
        pushToast({
          type: 'info',
          title: 'Development Reset Token Generated',
          description: 'SMTP is not configured; token prefilled for local verification.',
        });
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to process request');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.auth.resetPassword({ token, password: newPassword });
      pushToast({ type: 'success', title: 'Password updated', description: res.message });
      navigate('/login');
    } catch (err: any) {
      setError(err?.message || 'Invalid or expired reset token');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-120px)] flex items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md p-7 sm:p-8 space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-xl font-bold text-white">
            {mode === 'request' ? 'Reset your password' : 'Set a new password'}
          </h1>
          <p className="text-xs text-zinc-400">
            {mode === 'request'
              ? 'Enter your account email to generate a time-limited password reset token.'
              : 'Enter your reset token and choose a new password.'}
          </p>
        </div>

        {statusMsg && (
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-300">
            {statusMsg}
          </div>
        )}

        {error && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
            {error}
          </div>
        )}

        {mode === 'request' ? (
          <form onSubmit={handleRequestReset} className="space-y-4">
            <Input
              label="Account Email"
              type="email"
              required
              leftIcon={<Mail className="w-4 h-4" />}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@studio.com"
            />
            <Button type="submit" loading={loading} className="w-full">
              Send Reset Instructions
            </Button>
            <button
              type="button"
              onClick={() => setMode('reset')}
              className="w-full text-xs text-zinc-400 hover:text-white pt-1"
            >
              Already have a reset token? Enter it here
            </button>
          </form>
        ) : (
          <form onSubmit={handleConfirmReset} className="space-y-4">
            <Input
              label="Reset Token"
              required
              leftIcon={<KeyRound className="w-4 h-4" />}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste reset token"
            />
            <Input
              label="New Password"
              type="password"
              required
              minLength={8}
              leftIcon={<Lock className="w-4 h-4" />}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Minimum 8 characters"
            />
            <Button type="submit" loading={loading} className="w-full">
              Update Password
            </Button>
          </form>
        )}

        <p className="text-center text-xs text-zinc-400 pt-2 border-t border-white/[0.07]">
          <Link to="/login" className="text-[#A58DFF] hover:underline">
            Back to Sign In
          </Link>
        </p>
      </Card>
    </div>
  );
};
