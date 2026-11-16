import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Captions,
  Check,
  ChevronDown,
  Cpu,
  Crop,
  FileVideo,
  Globe,
  Layers,
  Mic,
  Play,
  Scissors,
  ShieldCheck,
  Sliders,
  Sparkles,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import { Badge, Button, Card } from '../../components/ui';
import { api } from '../../services/api';
import type { UrlCheckResult } from '../../types/api';
import { formatCurrencyINR } from '../../utils/format';
import { cn } from '../../utils/cn';

const WORKFLOW_AUDIENCES = [
  {
    role: 'YouTubers & Long-Form Creators',
    summary: 'Turn 30-minute episodes and deep dives into structured vertical YouTube Shorts.',
  },
  {
    role: 'Podcasters & Interview Hosts',
    summary: 'Isolate complete exchanges, punchy insights, and speaker-tracked 9:16 cuts.',
  },
  {
    role: 'Instagram & Reels Creators',
    summary: 'Export high-contrast word-highlighted captions formatted for mobile feeds.',
  },
  {
    role: 'Educators & Online Coaches',
    summary: 'Extract standalone lesson takeaways without mid-sentence truncation.',
  },
  {
    role: 'Gamers & Streamers',
    summary: 'Detect high-energy audio spikes and scene transitions across stream VODs.',
  },
  {
    role: 'B2B Teams & Digital Marketers',
    summary: 'Repurpose webinars, product demos, and founder talks with consistent branding.',
  },
];

const FAQS = [
  {
    q: 'How does ClipForge AI select moments from long-form videos?',
    a: 'Our 12-stage processor combines Faster-Whisper / speech transcription, OpenCV scene & face detection, acoustic energy profiling, and configurable LLM discourse analysis (Gemini or OpenAI-compatible providers) to locate complete, self-contained hooks, explanations, and exchanges.',
  },
  {
    q: 'Can I import any YouTube, Instagram, or TikTok link directly?',
    a: 'ClipForge AI strictly respects platform Terms of Service, copyright, and access controls. Direct MP4/WebM media URLs and authorized API streams can be imported directly; when a social platform restricts automated third-party downloading, our URL inspector explains why and switches smoothly to direct drag-and-drop upload.',
  },
  {
    q: 'Does an engagement score guarantee a clip will go viral?',
    a: 'No. Engagement potential scores (0–100) are analytical estimates based on hook structure, pacing, speech clarity, and scene dynamics to help you prioritize edits—never a guarantee of audience reach.',
  },
  {
    q: 'How does credit billing work?',
    a: 'Every new account receives welcome credits upon registration with no mandatory monthly subscription. Credits are reserved before a job starts, deducted only when validated MP4 clips finish rendering, and automatically released back to your wallet if a job fails or is cancelled.',
  },
];

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const [demoUrl, setDemoUrl] = useState('');
  const [checkingUrl, setCheckingUrl] = useState(false);
  const [urlResult, setUrlResult] = useState<UrlCheckResult | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Interactive Studio Preview controls (honest UI preview)
  const [previewRatio, setPreviewRatio] = useState<'9:16' | '1:1' | '16:9'>('9:16');
  const [previewHighlight, setPreviewHighlight] = useState('#38BDF8');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const packagesQuery = useQuery({
    queryKey: ['public-packages'],
    queryFn: () => api.payments.packages(),
  });

  const handleInspectUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!demoUrl.trim()) return;
    setCheckingUrl(true);
    setUrlError(null);
    setUrlResult(null);
    try {
      const res = await api.videos.checkUrl(demoUrl.trim());
      setUrlResult(res);
    } catch (err: any) {
      setUrlError(err?.message || 'Unable to inspect URL');
    } finally {
      setCheckingUrl(false);
    }
  };

  return (
    <div className="relative">
      {/* Subtle Top Radial Backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[540px] bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(124,92,255,0.18),transparent)]"
      />

      {/* HERO SECTION */}
      <section className="relative pt-16 pb-20 sm:pt-24 sm:pb-28 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <Badge variant="brand" className="px-3 py-1">
            <Sparkles className="w-3.5 h-3.5" /> 12-Stage AI Repurposing & FFmpeg Rendering Engine
          </Badge>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-[1.08]">
            Turn long-form videos into{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#A58DFF] via-white to-[#38BDF8]">
              structured short clips
            </span>{' '}
            in minutes.
          </h1>

          <p className="text-base sm:text-lg text-zinc-400 max-w-2xl mx-auto leading-relaxed">
            Upload source footage or inspect an accessible media link. ClipForge AI transcribes
            speech, detects key moments, reframes speakers into 9:16, burns animated captions, and
            generates platform-ready metadata.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link to="/register">
              <Button size="lg" rightIcon={<ArrowRight className="w-4 h-4" />}>
                Start Free with Welcome Credits
              </Button>
            </Link>
            <Link to="/dashboard/create">
              <Button variant="secondary" size="lg" leftIcon={<Upload className="w-4 h-4" />}>
                Upload Source Video
              </Button>
            </Link>
          </div>
        </div>

        {/* REAL URL INSPECTOR BAR */}
        <Card className="mt-12 max-w-3xl mx-auto p-3 sm:p-4 bg-[#121218]/95 border-white/12">
          <form onSubmit={handleInspectUrl} className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1">
              <Globe className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="url"
                value={demoUrl}
                onChange={(e) => setDemoUrl(e.target.value)}
                placeholder="Paste a direct MP4 URL or YouTube / Instagram / TikTok link to verify import eligibility..."
                className="w-full h-11 pl-10 pr-4 rounded-xl bg-[#0B0B10] border border-white/10 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-[#7C5CFF]"
              />
            </div>
            <Button type="submit" loading={checkingUrl} className="h-11 px-5 shrink-0">
              Check Source URL
            </Button>
          </form>

          {urlError && (
            <div className="mt-3 px-3.5 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-300">
              {urlError}
            </div>
          )}

          {urlResult && (
            <div className="mt-3 p-3.5 rounded-xl bg-[#0D0D13] border border-white/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant={urlResult.importableDirectly ? 'success' : 'warning'}>
                    Platform: {urlResult.platform.toUpperCase()}
                  </Badge>
                  <span className="text-xs font-medium text-zinc-200">
                    {urlResult.importableDirectly
                      ? 'Direct server import supported'
                      : 'Direct upload recommended'}
                  </span>
                </div>
                <p className="text-xs text-zinc-400">{urlResult.reason}</p>
              </div>
              <Button
                size="sm"
                variant={urlResult.importableDirectly ? 'primary' : 'secondary'}
                onClick={() =>
                  navigate(
                    `/dashboard/create?tab=${
                      urlResult.importableDirectly ? 'url' : 'upload'
                    }&url=${encodeURIComponent(demoUrl)}`
                  )
                }
              >
                {urlResult.importableDirectly ? 'Import in Studio' : 'Upload File Instead'}
              </Button>
            </div>
          )}
        </Card>

        {/* INTERACTIVE PRODUCT INTERFACE PREVIEW */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mt-14 rounded-2xl border border-white/10 bg-[#101016] shadow-studio overflow-hidden"
        >
          <div className="px-5 py-3 border-b border-white/[0.07] bg-[#14141C] flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
              <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
              <span className="ml-2 text-xs font-medium text-zinc-400">
                ClipForge Studio — Reframing & Animated Caption Configurator Preview
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(['9:16', '1:1', '16:9'] as const).map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => setPreviewRatio(ratio)}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
                    previewRatio === ratio
                      ? 'bg-[#7C5CFF] text-white'
                      : 'bg-white/[0.04] text-zinc-400 hover:text-white'
                  )}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-0">
            {/* Left Canvas Preview */}
            <div className="lg:col-span-7 p-6 sm:p-8 flex flex-col items-center justify-center studio-grid-bg border-b lg:border-b-0 lg:border-r border-white/[0.07] min-h-[360px]">
              <div
                className={cn(
                  'relative rounded-2xl border border-white/15 bg-gradient-to-b from-[#1A1A26] via-[#12121A] to-[#0B0B10] shadow-2xl flex flex-col justify-between p-5 transition-all duration-300 overflow-hidden',
                  previewRatio === '9:16' && 'w-[220px] h-[360px]',
                  previewRatio === '1:1' && 'w-[290px] h-[290px]',
                  previewRatio === '16:9' && 'w-full max-w-[440px] h-[250px]'
                )}
              >
                <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                  <span className="px-2 py-0.5 rounded bg-black/50 border border-white/10">
                    FACE TRACK: X=0.52
                  </span>
                  <span className="px-2 py-0.5 rounded bg-black/50 border border-white/10">
                    {previewRatio}
                  </span>
                </div>

                {/* Simulated Speaker Framing Reticle */}
                <div className="mx-auto my-auto w-20 h-20 rounded-full border border-dashed border-[#7C5CFF]/50 flex items-center justify-center">
                  <Play className="w-6 h-6 text-zinc-300" />
                </div>

                {/* Live Caption Style Preview */}
                <div className="text-center px-2 py-2 rounded-xl bg-black/70 border border-white/10">
                  <p className="text-xs sm:text-sm font-bold tracking-tight text-white leading-snug">
                    Retention jumps when every clip opens on a{' '}
                    <span style={{ color: previewHighlight }}>complete</span> hook.
                  </p>
                </div>
              </div>
            </div>

            {/* Right Pipeline & Controls Summary */}
            <div className="lg:col-span-5 p-6 space-y-5 bg-[#121218]">
              <div>
                <div className="text-xs uppercase tracking-wider text-zinc-500 font-semibold">
                  Interactive Highlight Accent
                </div>
                <div className="flex items-center gap-2.5 mt-2">
                  {[
                    { hex: '#38BDF8', name: 'Cyan' },
                    { hex: '#A78BFA', name: 'Violet' },
                    { hex: '#34D399', name: 'Emerald' },
                    { hex: '#FBBF24', name: 'Amber' },
                  ].map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      onClick={() => setPreviewHighlight(c.hex)}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-xs font-medium border flex items-center gap-2',
                        previewHighlight === c.hex
                          ? 'border-white/40 bg-white/[0.08] text-white'
                          : 'border-white/10 text-zinc-400'
                      )}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: c.hex }}
                      />
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2.5 pt-2 border-t border-white/[0.07]">
                <div className="text-xs uppercase tracking-wider text-zinc-500 font-semibold">
                  Real Pipeline Capabilities
                </div>
                {[
                  'OpenCV Haar face & active motion horizontal reframing',
                  'ASS subtitle rendering with word-level color highlights',
                  'EBU R128 (-16 LUFS) loudness normalization & FFT denoise',
                  'Segment-accurate silence compaction preserving caption sync',
                  'FFprobe stream verification before marking any clip ready',
                ].map((line) => (
                  <div key={line} className="flex items-start gap-2.5 text-xs text-zinc-300">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <span>{line}</span>
                  </div>
                ))}
              </div>

              <div className="pt-2">
                <Link to="/dashboard/create">
                  <Button className="w-full" rightIcon={<ArrowRight className="w-4 h-4" />}>
                    Open Full Clip Studio
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </motion.div>
      </section>

      {/* HOW IT WORKS */}
      <section className="py-20 border-t border-white/[0.06] px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="max-w-2xl mb-12">
          <Badge variant="default">Architecture</Badge>
          <h2 className="text-2xl sm:text-3xl font-bold text-white mt-3">
            From raw footage to ready-to-post shorts in four deterministic phases
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {[
            {
              step: '01',
              icon: FileVideo,
              title: 'Ingest & Validate',
              desc: 'Upload MP4/MOV/WebM/MKV files with live progress or import direct media URLs with SSRF protection and FFprobe stream verification.',
            },
            {
              step: '02',
              icon: Mic,
              title: 'Transcribe & Detect Scenes',
              desc: 'Extract 16kHz PCM audio for speech transcription alongside OpenCV scene-boundary and speaker face-center tracking.',
            },
            {
              step: '03',
              icon: Cpu,
              title: 'AI Moment Selection',
              desc: 'Identify non-overlapping hooks, insights, and exchanges aligned to complete sentence boundaries.',
            },
            {
              step: '04',
              icon: Scissors,
              title: 'Reframe, Burn & Export',
              desc: 'Render H.264 MP4 clips in 9:16, 1:1, or 16:9 with animated subtitles, normalized audio, and platform metadata.',
            },
          ].map((s) => {
            const Icon = s.icon;
            return (
              <Card key={s.step} className="p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="w-10 h-10 rounded-xl bg-[#7C5CFF]/15 border border-[#7C5CFF]/30 flex items-center justify-center text-[#A992FF]">
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-xs font-mono text-zinc-500">{s.step}</span>
                </div>
                <h3 className="text-base font-semibold text-white">{s.title}</h3>
                <p className="text-xs text-zinc-400 leading-relaxed">{s.desc}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* AI CLIPPING & EDITING CAPABILITIES */}
      <section className="py-20 border-t border-white/[0.06] px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-start">
          <div className="space-y-4">
            <Badge variant="brand">Automated Editing Engine</Badge>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">
              Engineered for precision, not black-box guesswork
            </h2>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Every generated clip passes through configurable visual, audio, and typographical
              stages powered by Python, OpenCV, and FFmpeg—giving you repeatable studio output.
            </p>
            <div className="pt-2">
              <Link to="/features">
                <Button variant="outline" rightIcon={<ArrowRight className="w-4 h-4" />}>
                  Explore All Technical Capabilities
                </Button>
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              {
                icon: Crop,
                title: 'Smart 9:16 Speaker Reframing',
                desc: 'Tracks face coordinates and visual motion to keep active subjects centered in vertical crops.',
              },
              {
                icon: Captions,
                title: 'Animated Word Subtitles',
                desc: 'Customize font size, vertical placement, colors, background opacity, and karaoke/word-pop highlights.',
              },
              {
                icon: Volume2,
                title: 'Broadcast Audio Chain',
                desc: 'Applies FFT noise reduction, dead-air silence trimming, and EBU R128 loudness normalization.',
              },
              {
                icon: Wand2,
                title: 'Multi-Platform Metadata',
                desc: 'Generates 3 title options, hooks, hashtags, thumbnail copy, and descriptions for Shorts, Reels, and TikTok.',
              },
              {
                icon: Sliders,
                title: 'Flexible Duration Windows',
                desc: 'Choose 15–30s, 30–45s, 45–60s, 60–90s, or custom bounds while preserving full sentences.',
              },
              {
                icon: ShieldCheck,
                title: 'Ledger-Backed Credits',
                desc: 'Immutable credit reservation and automatic release on failed or cancelled background jobs.',
              },
            ].map((feat) => {
              const Icon = feat.icon;
              return (
                <Card key={feat.title} className="p-5 space-y-2.5">
                  <Icon className="w-4 h-4 text-[#38BDF8]" />
                  <h3 className="text-sm font-semibold text-white">{feat.title}</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">{feat.desc}</p>
                </Card>
              );
            })}
          </div>
        </div>
      </section>

      {/* SUPPORTED WORKFLOWS */}
      <section className="py-20 border-t border-white/[0.06] px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <Badge>Supported Workflows</Badge>
          <h2 className="text-2xl sm:text-3xl font-bold text-white mt-3">
            Built for solo creators, podcasts, educators, and media teams
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {WORKFLOW_AUDIENCES.map((item) => (
            <Card key={item.role} className="p-5 flex items-start gap-3.5">
              <Layers className="w-4 h-4 text-[#9E85FF] shrink-0 mt-1" />
              <div>
                <h3 className="text-sm font-semibold text-white">{item.role}</h3>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{item.summary}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* PRICING PREVIEW */}
      <section className="py-20 border-t border-white/[0.06] px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-10">
          <div>
            <Badge variant="brand">Pay-As-You-Create</Badge>
            <h2 className="text-2xl sm:text-3xl font-bold text-white mt-3">
              Start free. Top up credit packages only when needed.
            </h2>
            <p className="text-sm text-zinc-400 mt-1">
              No mandatory monthly lock-in. Package rates are transparently managed by platform
              administrators.
            </p>
          </div>
          <Link to="/pricing">
            <Button variant="secondary" size="sm">
              Full Pricing Details
            </Button>
          </Link>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {(packagesQuery.data?.items || []).slice(0, 3).map((pkg) => (
            <Card
              key={pkg._id}
              className={cn(
                'p-6 flex flex-col justify-between',
                pkg.popular && 'border-[#7C5CFF]/50 shadow-glow'
              )}
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-white">{pkg.name}</h3>
                  {pkg.popular && <Badge variant="brand">Popular</Badge>}
                </div>
                <div>
                  <span className="text-3xl font-bold text-white tabular-nums">
                    {formatCurrencyINR(pkg.amountPaise)}
                  </span>
                  <span className="text-xs text-zinc-400 ml-2">
                    for {pkg.credits} processing credits
                  </span>
                </div>
                <p className="text-xs text-zinc-400">{pkg.description}</p>
                <ul className="space-y-2 pt-2 border-t border-white/[0.07]">
                  {pkg.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-xs text-zinc-300">
                      <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Link to="/register" className="mt-6 block">
                <Button variant={pkg.popular ? 'primary' : 'secondary'} className="w-full">
                  Get Started
                </Button>
              </Link>
            </Card>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 border-t border-white/[0.06] px-4 sm:px-6 lg:px-8 max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <Badge>FAQ</Badge>
          <h2 className="text-2xl sm:text-3xl font-bold text-white mt-3">
            Frequently asked questions
          </h2>
        </div>

        <div className="space-y-3">
          {FAQS.map((item, idx) => {
            const open = openFaq === idx;
            return (
              <Card key={item.q} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenFaq(open ? null : idx)}
                  className="w-full px-5 py-4 text-left flex items-center justify-between gap-4"
                >
                  <span className="text-sm font-semibold text-zinc-100">{item.q}</span>
                  <ChevronDown
                    className={cn(
                      'w-4 h-4 text-zinc-400 transition-transform shrink-0',
                      open && 'rotate-180'
                    )}
                  />
                </button>
                {open && (
                  <div className="px-5 pb-4 text-xs sm:text-sm text-zinc-400 leading-relaxed border-t border-white/[0.05] pt-3">
                    {item.a}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </section>

      {/* CTA */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 max-w-5xl mx-auto">
        <Card className="p-8 sm:p-12 text-center bg-gradient-to-b from-[#171723] to-[#111117] border-[#7C5CFF]/30 space-y-5">
          <h2 className="text-2xl sm:text-3xl font-bold text-white">
            Ready to repurpose your next recording?
          </h2>
          <p className="text-sm text-zinc-400 max-w-xl mx-auto">
            Create your free ClipForge AI account, receive welcome credits immediately, and render
            your first batch of vertical clips in our studio.
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Link to="/register">
              <Button size="lg" rightIcon={<ArrowRight className="w-4 h-4" />}>
                Create Free Account
              </Button>
            </Link>
            <Link to="/how-it-works">
              <Button variant="outline" size="lg">
                Read Pipeline Walkthrough
              </Button>
            </Link>
          </div>
        </Card>
      </section>
    </div>
  );
};
