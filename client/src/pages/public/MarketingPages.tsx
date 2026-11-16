import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Captions,
  Check,
  CheckCircle2,
  Cpu,
  Crop,
  FileCheck2,
  Film,
  Layers,
  Lock,
  Mail,
  Mic,
  Scissors,
  Send,
  Shield,
  Sparkles,
  Volume2,
  Wand2,
} from 'lucide-react';
import { PIPELINE_STAGES, PIPELINE_STAGE_LABELS } from '@clipforge/shared';
import { Badge, Button, Card, Input, Textarea } from '../../components/ui';
import { api } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useToastStore } from '../../stores/toastStore';
import { formatCurrencyINR } from '../../utils/format';
import { cn } from '../../utils/cn';

/* ================= FEATURES PAGE ================= */
export const FeaturesPage: React.FC = () => {
  const groups = [
    {
      badge: 'AI Moment Intelligence',
      title: 'Sentence-aligned clip discovery',
      items: [
        {
          icon: Mic,
          title: 'Multi-Engine Speech Transcription',
          desc: 'Integrates Faster-Whisper CTranslate2 models with automatic embedded-subtitle and offline ASR fallbacks so timestamps remain aligned.',
        },
        {
          icon: Cpu,
          title: 'Configurable AI Provider Architecture',
          desc: 'Connect Google Gemini or any OpenAI-compatible LLM endpoint to score hooks, discussions, educational insights, and emotional turns.',
        },
        {
          icon: Scissors,
          title: 'Zero-Duplicate Non-Overlapping Selection',
          desc: 'Enforces strict temporal separation across selected clips while snapping boundaries to natural pauses and complete thoughts.',
        },
      ],
    },
    {
      badge: 'Automated Video Studio',
      title: 'Broadcast-ready visual & audio finishing',
      items: [
        {
          icon: Crop,
          title: 'OpenCV Face & Speaker Reframing',
          desc: 'Converts 16:9 widescreen footage into 9:16 vertical, 1:1 square, or 16:9 exports centered around tracked subjects.',
        },
        {
          icon: Captions,
          title: 'Customizable ASS Animated Subtitles',
          desc: 'Configure typography, font scale, vertical placement, highlight color, box opacity, and karaoke/word-pop effects.',
        },
        {
          icon: Volume2,
          title: 'Clean Audio Mastering',
          desc: 'Combines FFT noise reduction, synchronized silence trimming, optional ambient beds, and EBU R128 loudness normalization.',
        },
      ],
    },
    {
      badge: 'Publishing & Reliability',
      title: 'Metadata, ownership, and verified exports',
      items: [
        {
          icon: Wand2,
          title: 'Platform-Specific Copy & Hooks',
          desc: 'Generates 3 title options, opening hooks, hashtags, thumbnail copy, and tailored descriptions for Shorts, Reels, and TikTok.',
        },
        {
          icon: FileCheck2,
          title: 'FFprobe Output Verification',
          desc: 'Every rendered clip is inspected for valid H.264/AAC streams, non-zero duration, and browser compatibility before completion.',
        },
        {
          icon: Lock,
          title: 'Signed Downloads & Tenant Isolation',
          desc: 'Strict owner checks and signed download URLs protect every source file and generated clip.',
        },
      ],
    },
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-16">
      <div className="max-w-3xl space-y-4">
        <Badge variant="brand">Platform Capabilities</Badge>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Every stage of short-form video production, automated end to end.
        </h1>
        <p className="text-base text-zinc-400 leading-relaxed">
          ClipForge AI pairs modern speech & vision pipelines with deterministic FFmpeg rendering so
          creators spend less time scrubbing timelines and more time publishing.
        </p>
      </div>

      {groups.map((g) => (
        <div key={g.title} className="space-y-6 pt-8 border-t border-white/[0.07]">
          <div>
            <Badge>{g.badge}</Badge>
            <h2 className="text-2xl font-bold text-white mt-2">{g.title}</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {g.items.map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.title} className="p-6 space-y-3">
                  <div className="w-10 h-10 rounded-xl bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center text-[#A992FF]">
                    <Icon className="w-5 h-5" />
                  </div>
                  <h3 className="text-base font-semibold text-white">{item.title}</h3>
                  <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">{item.desc}</p>
                </Card>
              );
            })}
          </div>
        </div>
      ))}

      <Card className="p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-[#14141D]">
        <div>
          <h3 className="text-lg font-semibold text-white">Test the full pipeline right now</h3>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Register in seconds and process a real video using your welcome credits.
          </p>
        </div>
        <Link to="/register">
          <Button rightIcon={<ArrowRight className="w-4 h-4" />}>Launch Clip Studio</Button>
        </Link>
      </Card>
    </div>
  );
};

/* ================= HOW IT WORKS PAGE ================= */
export const HowItWorksPage: React.FC = () => {
  const stageDescriptions: Record<string, string> = {
    importing: 'Validates direct uploads or permitted media URLs with strict SSRF & size checks.',
    validating: 'Runs FFprobe to inspect container integrity, video resolution, frame rate, and audio tracks.',
    extracting_audio: 'Extracts normalized 16kHz mono PCM audio for speech recognition and loudness profiling.',
    transcribing: 'Generates timestamped speech segments and word timings via Faster-Whisper or fallback ASR.',
    detecting_scenes: 'Analyzes frame histograms, motion vectors, and Haar face positions with OpenCV.',
    analyzing_content: 'Computes speech energy curves, discourse markers, and AI semantic structure.',
    detecting_moments: 'Scores candidate windows for strong hooks, insights, humor, and complete exchanges.',
    selecting_clips: 'Selects non-overlapping clips matching your requested duration window and count.',
    editing: 'Builds smart vertical/square crop coordinates, ASS animated captions, and audio mastering filters.',
    rendering: 'Executes H.264 + AAC FFmpeg encoding with faststart web optimization and JPEG thumbnails.',
    validating_output: 'Re-probes every output MP4 to guarantee playable video streams before deducting credits.',
    completed: 'Publishes clips + platform metadata to your library and settles reserved wallet credits.',
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-12">
      <div className="space-y-4">
        <Badge variant="brand">12-Stage Processing Pipeline</Badge>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          How ClipForge AI processes your video
        </h1>
        <p className="text-base text-zinc-400 leading-relaxed max-w-3xl">
          Unlike prototypes that display simulated progress bars, ClipForge AI executes a genuine
          12-stage background worker pipeline persisted in MongoDB and streamed to your Processing
          Queue in real time.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PIPELINE_STAGES.map((stage, index) => (
          <Card key={stage} className="p-5 flex items-start gap-4">
            <div className="w-8 h-8 rounded-lg bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center text-xs font-mono font-bold text-[#B4A2FF] shrink-0">
              {String(index + 1).padStart(2, '0')}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">
                {PIPELINE_STAGE_LABELS[stage]}
              </h3>
              <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                {stageDescriptions[stage]}
              </p>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6 border-amber-500/25 bg-amber-500/[0.05] space-y-2">
        <h3 className="text-sm font-semibold text-amber-200">
          Transparent Platform & Copyright Policy
        </h3>
        <p className="text-xs text-zinc-300 leading-relaxed">
          ClipForge AI never bypasses DRM, private account locks, authentication walls, or social
          platform anti-scraping protections. Direct media URLs (such as S3/CDN MP4 links) import
          directly; for restricted social links, download your own original recording from your
          creator studio and upload the file directly.
        </p>
      </Card>
    </div>
  );
};

/* ================= PRICING PAGE ================= */
export const PricingPage: React.FC = () => {
  const { user } = useAuthStore();
  const packagesQuery = useQuery({
    queryKey: ['public-packages'],
    queryFn: () => api.payments.packages(),
  });
  const capsQuery = useQuery({
    queryKey: ['public-capabilities'],
    queryFn: () => api.jobs.capabilities(),
  });

  const welcomeCredits = capsQuery.data?.limits.welcomeCredits ?? 60;
  const creditsPerMin = capsQuery.data?.limits.creditsPerMinuteProcessed ?? 10;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-14">
      <div className="text-center max-w-3xl mx-auto space-y-4">
        <Badge variant="brand">Flexible Credit Wallet</Badge>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Transparent credit packages with zero mandatory subscriptions
        </h1>
        <p className="text-base text-zinc-400">
          Every new creator receives{' '}
          <span className="text-white font-semibold">{welcomeCredits} welcome credits</span> upon
          registration. Processing uses approximately{' '}
          <span className="text-white font-semibold">{creditsPerMin} credits per minute</span> of
          source video, and failed jobs automatically release reserved credits.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {(packagesQuery.data?.items || []).map((pkg) => (
          <Card
            key={pkg._id}
            className={cn(
              'p-7 flex flex-col justify-between',
              pkg.popular && 'border-[#7C5CFF]/60 shadow-glow'
            )}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-white">{pkg.name}</h2>
                {pkg.popular && <Badge variant="brand">Most Selected</Badge>}
              </div>
              <div className="pt-1">
                <span className="text-4xl font-bold text-white tabular-nums">
                  {formatCurrencyINR(pkg.amountPaise)}
                </span>
                <div className="text-xs text-[#A992FF] font-medium mt-1">
                  {pkg.credits} Credits included (configurable package)
                </div>
              </div>
              <p className="text-xs text-zinc-400 leading-relaxed">{pkg.description}</p>
              <ul className="space-y-2.5 pt-4 border-t border-white/[0.08]">
                {pkg.features.map((feat) => (
                  <li key={feat} className="flex items-start gap-2.5 text-xs text-zinc-300">
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>{feat}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="pt-6 mt-6 border-t border-white/[0.06]">
              <Link to={user ? '/dashboard/wallet' : '/register'}>
                <Button variant={pkg.popular ? 'primary' : 'secondary'} className="w-full">
                  {user ? 'Purchase in Credit Wallet' : 'Register & Claim Free Credits'}
                </Button>
              </Link>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-6 bg-[#121219] grid grid-cols-1 md:grid-cols-3 gap-6">
        <div>
          <h3 className="text-sm font-semibold text-white">Immutable Credit Ledger</h3>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            Every welcome grant, job reservation, completion settlement, refund, and admin
            adjustment is recorded in an auditable ledger.
          </p>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Verified Razorpay Checkout</h3>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            Orders are created server-side and credited strictly after cryptographic HMAC-SHA256
            signature or webhook verification.
          </p>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Automatic Failure Protection</h3>
          <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
            If a video fails validation or rendering is cancelled, 100% of reserved credits are
            automatically released back to your available balance.
          </p>
        </div>
      </Card>
    </div>
  );
};

/* ================= ABOUT PAGE ================= */
export const AboutPage: React.FC = () => (
  <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-12">
    <div className="space-y-4">
      <Badge variant="brand">About ClipForge AI</Badge>
      <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
        Built to make short-form video repurposing fast, honest, and reliable.
      </h1>
      <p className="text-base text-zinc-400 leading-relaxed">
        Long-form creators invest hours recording podcasts, tutorials, streams, and interviews—yet
        extracting vertical clips, tracking speakers, syncing captions, and writing platform copy
        still consumes an entire afternoon per episode.
      </p>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      <Card className="p-6 space-y-2.5">
        <Film className="w-5 h-5 text-[#9E85FF]" />
        <h3 className="text-base font-semibold text-white">Real Media Engineering</h3>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Powered by FFmpeg, FFprobe, OpenCV, and Python speech pipelines rather than brittle
          browser-only canvas hacks.
        </p>
      </Card>
      <Card className="p-6 space-y-2.5">
        <Shield className="w-5 h-5 text-[#38BDF8]" />
        <h3 className="text-base font-semibold text-white">Respect for Creators</h3>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Strict tenant isolation, compliant media ingestion, and transparent AI scoring without
          exaggerated virality promises.
        </p>
      </Card>
      <Card className="p-6 space-y-2.5">
        <Sparkles className="w-5 h-5 text-emerald-400" />
        <h3 className="text-base font-semibold text-white">Modular AI Providers</h3>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Clean provider abstraction supporting Google Gemini, OpenAI-compatible models, and
          deterministic offline NLP fallbacks.
        </p>
      </Card>
    </div>
  </div>
);

/* ================= CONTACT PAGE ================= */
export const ContactPage: React.FC = () => {
  const pushToast = useToastStore((s) => s.push);
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [submitting, setSubmitting] = useState(false);
  const [ticketRef, setTicketRef] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.notifications.submitContact(form);
      setTicketRef(res.ticketRef);
      setForm({ name: '', email: '', subject: '', message: '' });
      pushToast({
        type: 'success',
        title: 'Inquiry received',
        description: `Reference ID: ${res.ticketRef}`,
      });
    } catch (err: any) {
      pushToast({
        type: 'error',
        title: 'Could not send message',
        description: err?.message || 'Please check all fields and try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-10">
      <div className="space-y-3">
        <Badge variant="brand">Contact & Support</Badge>
        <h1 className="text-3xl sm:text-4xl font-bold text-white">Get in touch with our team</h1>
        <p className="text-sm text-zinc-400">
          Have questions about custom credit packages, API configuration, or billing? Send us a
          message and receive a tracked ticket reference.
        </p>
      </div>

      <Card className="p-6 sm:p-8">
        {ticketRef ? (
          <div className="py-8 text-center space-y-4">
            <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto" />
            <h3 className="text-lg font-semibold text-white">Message logged successfully</h3>
            <p className="text-xs text-zinc-400 max-w-md mx-auto">
              Your support reference is{' '}
              <span className="font-mono text-zinc-200">{ticketRef}</span>. Our support queue has
              recorded your request.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setTicketRef(null)}>
              Send Another Message
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Your Name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Aarav Sharma"
              />
              <Input
                label="Email Address"
                type="email"
                required
                leftIcon={<Mail className="w-4 h-4" />}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="aarav@example.com"
              />
            </div>
            <Input
              label="Subject"
              required
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="Team workflow inquiry or technical support"
            />
            <Textarea
              label="Message"
              rows={5}
              required
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Tell us how we can help..."
            />
            <Button type="submit" loading={submitting} leftIcon={<Send className="w-4 h-4" />}>
              Submit Message
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
};
