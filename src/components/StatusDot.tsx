import React from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { ScanStatus } from '../types/contract';

export type StatusDotState = 'running' | 'done' | 'failed';

export interface StatusDotMeta {
  state: StatusDotState;
  labelAr: 'شغّال' | 'خلص' | 'فشل';
  bgClass: string;
  fgClass: string;
  dotBgClass: string;
}

export function getScanStatusDotMeta(status?: ScanStatus | string): StatusDotMeta {
  const clean = (status || '').toLowerCase().trim();
  if (clean === 'running' || clean === 'queued') {
    return {
      state: 'running',
      labelAr: 'شغّال',
      bgClass: 'bg-[var(--sev-medium-bg)]',
      fgClass: 'text-[var(--sev-medium-fg)]',
      dotBgClass: 'bg-[var(--sev-medium-fg)]',
    };
  }
  if (clean === 'completed' || clean === 'partial' || clean === 'done') {
    return {
      state: 'done',
      labelAr: 'خلص',
      bgClass: 'bg-[var(--pass-bg)]',
      fgClass: 'text-[var(--pass-fg)]',
      dotBgClass: 'bg-[var(--pass-fg)]',
    };
  }
  return {
    state: 'failed',
    labelAr: 'فشل',
    bgClass: 'bg-[var(--sev-critical-bg)]',
    fgClass: 'text-[var(--sev-critical-fg)]',
    dotBgClass: 'bg-[var(--sev-critical-fg)]',
  };
}

interface StatusDotProps {
  status?: ScanStatus | string;
  compact?: boolean;
  dataTestId?: string;
}

export const StatusDot: React.FC<StatusDotProps> = ({ status, compact = false, dataTestId }) => {
  const meta = getScanStatusDotMeta(status);

  return (
    <span
      data-testid={dataTestId || `status-dot-${meta.state}`}
      className={`inline-flex items-center gap-1.5 rounded-[var(--r-sm)] border border-[var(--border)] font-bold ${
        compact ? 'px-2 py-0.5 text-[12px]' : 'px-2.5 py-1 text-[12px]'
      } ${meta.bgClass} ${meta.fgClass}`}
    >
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full shrink-0 ${meta.dotBgClass} ${
          meta.state === 'running' ? 'animate-pulse' : ''
        }`}
      />
      {meta.state === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />}
      {meta.state === 'done' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      {meta.state === 'failed' && <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      <span>{meta.labelAr}</span>
    </span>
  );
};
