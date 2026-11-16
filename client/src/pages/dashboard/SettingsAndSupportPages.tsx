import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CheckCircle2,
  AlertTriangle,
  Lock,
  Save,
  Send,
  Server,
  User as UserIcon,
} from 'lucide-react';
import { ASPECT_RATIOS } from '@clipforge/shared';
import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  Switch,
  Textarea,
} from '../../components/ui';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';

/* ================= SETTINGS PAGE ================= */
export const SettingsPage: React.FC = () => {
  const { user, refreshSession } = useAuthStore();
  const pushToast = useToastStore((s) => s.push);

  const [name, setName] = useState(user?.name || '');
  const [defaultAspectRatio, setDefaultAspectRatio] = useState(
    user?.preferences?.defaultAspectRatio || '9:16'
  );
  const [defaultLanguage, setDefaultLanguage] = useState(
    user?.preferences?.defaultLanguage || 'en'
  );
  const [watermarkText, setWatermarkText] = useState(user?.preferences?.watermarkText || '');
  const [emailNotifications, setEmailNotifications] = useState(
    user?.preferences?.emailNotifications ?? true
  );
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      await api.users.updateProfile({
        name,
        preferences: {
          defaultAspectRatio: defaultAspectRatio as any,
          defaultLanguage,
          watermarkText,
          emailNotifications,
        },
      });
      await refreshSession();
      pushToast({ type: 'success', title: 'Studio settings saved' });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Could not update profile', description: err?.message });
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPassword(true);
    try {
      await api.users.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      pushToast({ type: 'success', title: 'Password updated successfully' });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Password change failed', description: err?.message });
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">Account & Studio Settings</h1>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          Configure your profile, default export presets, and account security.
        </p>
      </div>

      <Card className="p-6 space-y-5">
        <div className="flex items-center gap-2 text-base font-semibold text-white">
          <UserIcon className="w-4 h-4 text-[#A58DFF]" /> Profile & Default Studio Preferences
        </div>

        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Display Name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input label="Account Email" value={user?.email || ''} disabled />
            <Select
              label="Default Export Aspect Ratio"
              value={defaultAspectRatio}
              onChange={(e) => setDefaultAspectRatio(e.target.value as any)}
              options={ASPECT_RATIOS.map((r) => ({ value: r, label: r }))}
            />
            <Select
              label="Default Speech Language"
              value={defaultLanguage}
              onChange={(e) => setDefaultLanguage(e.target.value)}
              options={[
                { value: 'en', label: 'English (en)' },
                { value: 'hi', label: 'Hindi (hi)' },
                { value: 'auto', label: 'Auto-detect' },
              ]}
            />
          </div>

          <Input
            label="Default Brand Watermark Text"
            value={watermarkText}
            onChange={(e) => setWatermarkText(e.target.value)}
            placeholder="@YourHandle"
          />

          <Switch
            checked={emailNotifications}
            onChange={setEmailNotifications}
            label="Processing Completion Alerts"
            description="Notify inside dashboard when clips finish rendering"
          />

          <Button type="submit" loading={savingProfile} leftIcon={<Save className="w-4 h-4" />}>
            Save Preferences
          </Button>
        </form>
      </Card>

      <Card className="p-6 space-y-5">
        <div className="flex items-center gap-2 text-base font-semibold text-white">
          <Lock className="w-4 h-4 text-[#38BDF8]" /> Change Password
        </div>

        <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
          <Input
            label="Current Password"
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
          <Input
            label="New Password"
            type="password"
            required
            minLength={8}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Button type="submit" variant="secondary" loading={savingPassword}>
            Update Password
          </Button>
        </form>
      </Card>
    </div>
  );
};

/* ================= HELP & SUPPORT + CAPABILITY DIAGNOSTICS ================= */
export const HelpSupportPage: React.FC = () => {
  const { user } = useAuthStore();
  const pushToast = useToastStore((s) => s.push);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const capsQuery = useQuery({
    queryKey: ['system-capabilities'],
    queryFn: () => api.jobs.capabilities(),
  });

  const handleSendSupport = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      const res = await api.notifications.submitContact({
        name: user?.name || 'Creator',
        email: user?.email || 'creator@clipforge.local',
        subject,
        message,
      });
      setSubject('');
      setMessage('');
      pushToast({
        type: 'success',
        title: 'Support ticket created',
        description: `Reference: ${res.ticketRef}`,
      });
    } catch (err: any) {
      pushToast({ type: 'error', title: 'Could not submit ticket', description: err?.message });
    } finally {
      setSending(false);
    }
  };

  const caps = capsQuery.data;

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight">
          Help, Diagnostics & Support
        </h1>
        <p className="text-xs sm:text-sm text-zinc-400 mt-1">
          Live runtime service status, external integration configuration notices, and creator
          support.
        </p>
      </div>

      {/* Live System Integration Status */}
      <Card className="p-6 space-y-4">
        <div className="flex items-center gap-2 text-base font-semibold text-white">
          <Server className="w-4 h-4 text-[#A58DFF]" /> Runtime Service & External Credentials Status
        </div>

        {caps && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="p-4 rounded-xl bg-[#0E0E14] border border-white/[0.08] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">FFmpeg & FFprobe Media Engine</span>
                <Badge variant={caps.ffmpeg.available ? 'success' : 'danger'}>
                  {caps.ffmpeg.available ? 'READY' : 'NOT FOUND'}
                </Badge>
              </div>
              <p className="text-zinc-400">
                H.264 video rendering, ASS subtitle burning, EBU R128 loudness normalization.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-[#0E0E14] border border-white/[0.08] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">
                  AI Provider ({caps.ai.provider.toUpperCase()})
                </span>
                <Badge variant={caps.ai.configured ? 'success' : 'warning'}>
                  {caps.ai.configured ? 'CONFIGURED' : 'NOT CONFIGURED'}
                </Badge>
              </div>
              <p className="text-zinc-400">
                {caps.ai.configured
                  ? `Connected using model ${caps.ai.model}.`
                  : caps.ai.setupInstructions ||
                    'Set GEMINI_API_KEY in .env to enable Gemini LLM moment & copy generation. Deterministic NLP fallback is active.'}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-[#0E0E14] border border-white/[0.08] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">Speech Transcription Engine</span>
                <Badge variant={caps.transcription.whisperModelCached ? 'success' : 'info'}>
                  {caps.transcription.whisperModelCached
                    ? 'FASTER-WHISPER CACHED'
                    : `FALLBACK: ${caps.transcription.offlineFallbackEngine.toUpperCase()}`}
                </Badge>
              </div>
              <p className="text-zinc-400">
                {caps.transcription.setupInstructions ||
                  'Uses Faster-Whisper when model weights are cached/online, or embedded subtitles + offline PocketSphinx ASR.'}
              </p>
            </div>

            <div className="p-4 rounded-xl bg-[#0E0E14] border border-white/[0.08] space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">Razorpay Payments Gateway</span>
                <Badge variant={caps.payments.razorpayConfigured ? 'success' : 'warning'}>
                  {caps.payments.razorpayConfigured ? 'CONFIGURED' : 'NOT CONFIGURED (SANDBOX)'}
                </Badge>
              </div>
              <p className="text-zinc-400">
                {caps.payments.razorpayConfigured
                  ? 'Live/Test Razorpay Orders & Webhook verification active.'
                  : 'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env for live INR checkout.'}
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* Support Ticket Form */}
      <Card className="p-6 space-y-4">
        <h2 className="text-base font-semibold text-white">Submit a Support Request</h2>
        <form onSubmit={handleSendSupport} className="space-y-4">
          <Input
            label="Subject"
            required
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Describe your issue or question"
          />
          <Textarea
            label="Details"
            rows={4}
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Include your project name or job ID if relevant..."
          />
          <Button type="submit" loading={sending} leftIcon={<Send className="w-4 h-4" />}>
            Submit Support Ticket
          </Button>
        </form>
      </Card>
    </div>
  );
};
