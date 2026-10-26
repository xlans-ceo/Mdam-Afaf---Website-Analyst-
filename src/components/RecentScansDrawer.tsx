import React from 'react';
import { X, Clock, Trash2 } from 'lucide-react';
import { RecentScanSummary } from '../lib/scan-lifecycle';
import { formatNumber, formatTime } from '../lib/format';

interface RecentScansDrawerProps {
  scans: RecentScanSummary[];
  onSelectScan: (scan: RecentScanSummary) => void;
  onClearHistory: () => void;
  onClose: () => void;
}

export const RecentScansDrawer: React.FC<RecentScansDrawerProps> = ({
  scans,
  onSelectScan,
  onClearHistory,
  onClose
}) => {
  return (
    <div
      className="fixed inset-0 z-50 bg-[var(--ink)]/50 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="سجل الفحوصات السابقة"
    >
      <div className="ledger-card max-w-md w-full max-h-[85vh] flex flex-col overflow-hidden bg-[var(--surface)] shadow-[var(--sh-3)]">
        <div className="p-4 border-b border-[var(--border)] bg-[var(--surface-alt)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--primary)]" />
            <h2 className="text-[16px] font-bold text-[var(--ink)]">سجل الفحوصات السابقة</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق سجل الفحوصات"
            className="p-2 rounded-[var(--r-sm)] text-[var(--ink-muted)] hover:text-[var(--ink)] hover:bg-[var(--surface)] transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {scans.length === 0 ? (
            <div className="text-center py-10 text-[15px] text-[var(--ink-muted)]">
              مفيش فحوصات سابقة محفوظة في الدفتر ده لسه.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[13px] text-[var(--ink-muted)]">
                  فتح أي تقرير سابق مجاني ومش بيسحب من حصتك.
                </p>
                <button
                  type="button"
                  onClick={onClearHistory}
                  className="inline-flex items-center gap-1 text-[12px] font-bold text-[var(--pen)] hover:underline cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>مسح السجل</span>
                </button>
              </div>
              {scans.map(s => (
                <button
                  key={s.scanId}
                  type="button"
                  onClick={() => {
                    onSelectScan(s);
                    onClose();
                  }}
                  className="w-full text-start p-3.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] hover:border-[var(--primary)] hover:bg-[var(--surface-alt)] transition-colors cursor-pointer flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="font-bold text-[15px] text-[var(--ink)] truncate">
                      <bdi dir="ltr">{s.registrableDomain || s.finalUrl || s.requestedUrl}</bdi>
                    </div>
                    <div className="text-[12px] text-[var(--ink-muted)] mt-1 flex items-center gap-2 flex-wrap">
                      <bdi dir="ltr">
                        {formatTime(s.finishedAt || s.startedAt)}
                      </bdi>
                      <span>·</span>
                      <span>
                        <bdi dir="ltr">{formatNumber(s.uniquePagesInspected ?? 1)}</bdi> صفحة
                      </span>
                      <span>·</span>
                      <span className="font-bold text-[var(--ink)]">
                        <bdi dir="ltr">{formatNumber(s.findingsCount ?? 0)}</bdi> ملاحظة
                      </span>
                    </div>
                  </div>

                  <span
                    className={`shrink-0 text-[12px] font-bold px-2.5 py-1 rounded-[var(--r-sm)] ${
                      s.verdict?.level === 'fix_before_handover'
                        ? 'bg-[var(--sev-critical-bg)] text-[var(--sev-critical-fg)]'
                        : s.verdict?.level === 'needs_work_before_launch'
                        ? 'bg-[var(--sev-medium-bg)] text-[var(--sev-medium-fg)]'
                        : 'bg-[var(--pass-bg)] text-[var(--pass-fg)]'
                    }`}
                  >
                    {s.verdict?.level === 'fix_before_handover'
                      ? 'مشاكل حرجة'
                      : s.verdict?.level === 'needs_work_before_launch'
                      ? 'محتاج شغل'
                      : 'جاهز بملاحظات'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
