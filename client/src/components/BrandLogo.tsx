import React from 'react';
import { Scissors } from 'lucide-react';
import { cn } from '../utils/cn';

export const BrandLogo: React.FC<{ className?: string; compact?: boolean }> = ({
  className,
  compact = false,
}) => (
  <div className={cn('inline-flex items-center gap-2.5 select-none', className)}>
    <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[#7C5CFF] to-[#38BDF8] p-[1px] shadow-[0_0_20px_-4px_rgba(124,92,255,0.6)]">
      <div className="w-full h-full rounded-[11px] bg-[#0D0D12] flex items-center justify-center">
        <Scissors className="w-4 h-4 text-[#9E85FF]" />
      </div>
    </div>
    {!compact && (
      <div className="flex items-baseline gap-1.5">
        <span className="text-[15px] font-semibold tracking-tight text-white">ClipForge</span>
        <span className="text-[11px] font-semibold tracking-wider uppercase px-1.5 py-0.5 rounded bg-[#7C5CFF]/15 text-[#B4A2FF] border border-[#7C5CFF]/25">
          AI
        </span>
      </div>
    )}
  </div>
);
