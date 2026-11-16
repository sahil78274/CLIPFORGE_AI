import React from 'react';
import { Badge, Card } from '../../components/ui';

export const PrivacyPolicyPage: React.FC = () => (
  <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-8">
    <div className="space-y-2">
      <Badge>Legal</Badge>
      <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
      <p className="text-xs text-zinc-500">Last updated: November 2026</p>
    </div>

    <Card className="p-6 sm:p-8 space-y-6 text-sm text-zinc-300 leading-relaxed">
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">1. Data We Process</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          ClipForge AI collects account credentials (name, email address, bcrypt-hashed password),
          uploaded source videos, generated transcripts, rendered video clips, credit ledger entries,
          and Razorpay payment verification identifiers necessary to operate your studio workspace.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">2. Media Ownership & Isolation</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          You retain full ownership of all videos you upload and all clips generated in your
          account. Every project, video, and clip record is strictly scoped to your authenticated
          account ID, and downloads require cryptographically signed tokens.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">3. AI & Sub-Processor Usage</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          When an external AI provider (such as Google Gemini) is configured by the workspace
          operator, transcript segments—not your raw payment data—are sent strictly to identify
          clip boundaries and generate publishing copy. Temporary audio/subtitle working files are
          cleaned up automatically after rendering completes.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">4. Security Controls</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          Sessions are protected with HTTP-only cookies, Helmet security headers, rate limiting,
          SSRF network blocks, and server-side Razorpay HMAC signature verification.
        </p>
      </section>
    </Card>
  </div>
);

export const TermsPage: React.FC = () => (
  <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 space-y-8">
    <div className="space-y-2">
      <Badge>Legal</Badge>
      <h1 className="text-3xl font-bold text-white">Terms and Conditions</h1>
      <p className="text-xs text-zinc-500">Last updated: November 2026</p>
    </div>

    <Card className="p-6 sm:p-8 space-y-6 text-sm text-zinc-300 leading-relaxed">
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">1. Authorized Content Only</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          You confirm that you own the rights or have explicit permission to upload, import, and
          repurpose any video submitted to ClipForge AI. ClipForge AI does not circumvent DRM,
          private content protections, or third-party platform Terms of Service.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">2. Credit Accounting & Payments</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          Processing credits are reserved prior to job execution and deducted only upon validated
          clip generation. Failed or cancelled jobs release reserved credits back to your wallet.
          Purchased credit packages are verified server-side via Razorpay.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">3. No Virality Guarantee</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          Engagement potential scores and suggested posting windows are editorial heuristics only and
          do not guarantee views, monetization, or algorithmic distribution on third-party social
          networks.
        </p>
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold text-white">4. Acceptable Use</h2>
        <p className="text-xs sm:text-sm text-zinc-400">
          Uploading malicious binaries, attempting SSRF probes, abusing rate limits, or sharing
          illegal content will result in immediate account suspension by platform administrators.
        </p>
      </section>
    </Card>
  </div>
);
