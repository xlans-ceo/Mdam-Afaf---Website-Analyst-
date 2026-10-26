import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Clock, XCircle } from 'lucide-react';
import { Stage } from '../types/contract';
import { StatusDot } from './StatusDot';

export interface ScanProgressProps {
  stage?: Stage;
  currentStage?: Stage;
  stageStates: Record<Stage, 'pending' | 'started' | 'done' | 'skipped'>;
  detail?: string;
  stageDetail?: string;
  pagesCount?: number;
  inspectedPagesCount?: number;
  url?: string;
  startedAt?: string;
  onCancel?: () => void;
  cancelling?: boolean;
  pollSlowWarningAr?: string | null;
  onRetryPoll?: () => void;
  attachedMessageAr?: string | null;
}

const STAGE_LABELS_AR: Record<Stage, string> = {
  url_check: 'فحص الرابط وحالة الموقع والأمان',
  discovery: 'اكتشاف الصفحات الأساسية',
  interaction: 'فحص الروابط والصور والهوية',
  lighthouse: 'قياس استجابة السيرفر والأداء',
  report: 'تجهيز دفتر المراجعة وخطة الإصلاح',
};

export const ScanProgress: React.FC<ScanProgressProps> = ({
  stage,
  currentStage,
  stageStates,
  detail,
  stageDetail,
  pagesCount,
  inspectedPagesCount,
  url,
  startedAt,
  onCancel,
  cancelling = false,
  pollSlowWarningAr,
  onRetryPoll,
  attachedMessageAr,
}) => {
  const activeStageKey = currentStage || stage || 'url_check';
  const activeStageTitle =
    detail || stageDetail || STAGE_LABELS_AR[activeStageKey] || 'جاري الفحص بالدليل...';
  const count = pagesCount ?? inspectedPagesCount ?? 0;
  const discoveryDone =
    stageStates.discovery === 'done' ||
    stageStates.interaction === 'started' ||
    stageStates.interaction === 'done' ||
    stageStates.lighthouse === 'started' ||
    stageStates.lighthouse === 'done' ||
    stageStates.report === 'started' ||
    stageStates.report === 'done' ||
    count > 0;

  const initialStartMs = startedAt ? new Date(startedAt).getTime() : Date.now();
  const startTimeRef = useRef<number>(
    Number.isFinite(initialStartMs) ? initialStartMs : Date.now()
  );
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(() =>
    Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000))
  );

  useEffect(() => {
    if (startedAt) {
      const parsed = new Date(startedAt).getTime();
      if (Number.isFinite(parsed)) {
        startTimeRef.current = parsed;
      }
    }
  }, [startedAt]);

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startTimeRef.current) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <section
      aria-label="تقدم الفحص المباشر"
      aria-live="polite"
      data-testid="scan-progress-card"
      className="max-w-[560px] mx-auto my-8 sm:my-16 p-6 sm:p-8 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] shadow-[var(--sh-2)] space-y-5 text-center"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] pb-4">
        <StatusDot status="running" />
        <div
          aria-label="الوقت المنقضي"
          className="inline-flex items-center gap-1.5 text-[14px] font-bold text-[var(--ink-muted)]"
        >
          <Clock className="w-4 h-4 text-[var(--primary)] shrink-0" aria-hidden="true" />
          <bdi dir="ltr" className="font-mono" data-testid="scan-elapsed-time">
            {formatTime(elapsedSeconds)}
          </bdi>
        </div>
      </div>

      {url && (
        <div className="text-[14px] text-[var(--ink-muted)]">
          <bdi dir="ltr" className="font-mono font-bold text-[var(--primary)] break-all">
            {url}
          </bdi>
        </div>
      )}

      {attachedMessageAr && (
        <div
          role="status"
          data-testid="attached-scan-banner"
          className="p-3 rounded-[var(--r-md)] border border-[var(--pass-fg)] bg-[var(--pass-bg)] text-[var(--pass-fg)] text-[14px] font-bold"
        >
          {attachedMessageAr}
        </div>
      )}

      {/* Stage Name from Real Events */}
      <div className="py-4 px-4 rounded-[var(--r-md)] bg-[var(--surface-alt)] border border-[var(--border)] space-y-2">
        <div className="inline-flex items-center justify-center gap-2 text-[18px] font-bold text-[var(--ink)]">
          <Loader2 className="w-5 h-5 animate-spin text-[var(--primary)] shrink-0" aria-hidden="true" />
          <span data-testid="scan-stage-name">{activeStageTitle}</span>
        </div>

        {/* N/M only after discovery */}
        {discoveryDone && (
          <div
            data-testid="scan-pages-counter"
            className="text-[14px] font-bold text-[var(--primary)]"
          >
            <bdi dir="ltr" className="font-mono">
              {count}/10
            </bdi>{' '}
            صفحات
          </div>
        )}
      </div>

      {/* Calm note */}
      <p className="text-[14px] text-[var(--ink-muted)] leading-[1.7]">
        تقدر تقفل الصفحة أو تفتح حاجة تانية؛ الفحص مكمل
      </p>

      {pollSlowWarningAr && (
        <div
          role="status"
          className="p-3 rounded-[var(--r-md)] border border-[var(--sev-medium-fg)] bg-[var(--sev-medium-bg)] text-[var(--sev-medium-fg)] text-[12px] font-bold flex flex-wrap items-center justify-between gap-2"
        >
          <span>{pollSlowWarningAr}</span>
          {onRetryPoll && (
            <button
              type="button"
              onClick={onRetryPoll}
              className="px-3 py-1 rounded-[var(--r-sm)] bg-[var(--surface)] border border-[var(--sev-medium-fg)] font-bold"
            >
              تحديث الآن
            </button>
          )}
        </div>
      )}

      {/* Cancel link */}
      {onCancel && (
        <div className="pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelling}
            aria-label="إلغاء الفحص"
            data-testid="cancel-scan-btn"
            className="min-h-[44px] px-4 py-2 rounded-[var(--r-md)] text-[14px] font-bold text-[var(--sev-critical-fg)] hover:bg-[var(--sev-critical-bg)] inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          >
            <XCircle className="w-4 h-4 shrink-0" />
            <span>{cancelling ? 'جاري الإلغاء...' : 'إلغاء'}</span>
          </button>
        </div>
      )}
    </section>
  );
};
