import React, { useEffect, useState, useMemo } from 'react';
import { FolderClock, RefreshCw, ExternalLink, PlusCircle } from 'lucide-react';
import { VisitorReportSummary } from '../types/contract';
import { apiFetch } from '../lib/api-client';
import { StatusDot } from './StatusDot';
import { formatDate } from '../lib/format';

interface ReportsPageProps {
  onOpenReport: (scanId: string, status: string) => void;
  onRescanDomain: (url: string) => void;
  onStartNewScan: () => void;
  onRunningCountChange?: (runningCount: number) => void;
}

export const ReportsPage: React.FC<ReportsPageProps> = ({
  onOpenReport,
  onRescanDomain,
  onStartNewScan,
  onRunningCountChange,
}) => {
  const [reports, setReports] = useState<VisitorReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorAr, setErrorAr] = useState<string | null>(null);
  const [selectedScanByDomain, setSelectedScanByDomain] = useState<Record<string, string>>({});

  const fetchReports = async () => {
    setLoading(true);
    setErrorAr(null);
    try {
      const res = await apiFetch('/api/reports');
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setErrorAr(data?.error || 'ما قدرتش أجيب سجل التقارير دلوقتي. جرب تحدث الصفحة.');
      } else {
        const list: VisitorReportSummary[] = Array.isArray(data.reports) ? data.reports : [];
        setReports(list);
        const runningCount = list.filter(
          (r) => r.status === 'running' || r.status === 'queued'
        ).length;
        onRunningCountChange?.(runningCount);
      }
    } catch {
      setErrorAr('تعذر الاتصال بالسيرفر لعرض التقارير. جرب تاني بعد ثواني.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const groupedDomains = useMemo(() => {
    const map = new Map<
      string,
      {
        domain: string;
        latestMs: number;
        items: VisitorReportSummary[];
      }
    >();

    for (const item of reports) {
      const dom = item.registrableDomain || 'unknown';
      const existing = map.get(dom);
      if (!existing) {
        map.set(dom, {
          domain: dom,
          latestMs: item.createdAtMs,
          items: [item],
        });
      } else {
        existing.items.push(item);
        if (item.createdAtMs > existing.latestMs) {
          existing.latestMs = item.createdAtMs;
        }
      }
    }

    const groups = Array.from(map.values());
    for (const g of groups) {
      // Sort R1, R2, R3 ascending for chips
      g.items.sort((a, b) => a.reviewNumber - b.reviewNumber || a.createdAtMs - b.createdAtMs);
    }
    // Sort domains by latest scan descending
    groups.sort((a, b) => b.latestMs - a.latestMs);
    return groups;
  }, [reports]);

  return (
    <section
      aria-label="تقاريري"
      data-testid="reports-page"
      className="max-w-[720px] mx-auto space-y-6 pb-28"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] pb-4">
        <div className="flex items-center gap-2.5">
          <FolderClock className="w-6 h-6 text-[var(--primary)] shrink-0" aria-hidden="true" />
          <div>
            <h1 className="text-[24px] font-bold text-[var(--ink)]">تقاريري</h1>
            <p className="text-[14px] text-[var(--ink-muted)]">
              آخر المراجعات المحفوظة على المتصفح ده (لحد <bdi dir="ltr">20</bdi> مراجعة).
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={fetchReports}
          aria-label="تحديث القائمة"
          className="min-h-[44px] px-3 py-2 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] text-[14px] font-bold text-[var(--ink)] hover:bg-[var(--surface-alt)] inline-flex items-center gap-1.5 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>تحديث</span>
        </button>
      </div>

      {loading && (
        <div className="space-y-3" data-testid="reports-loading-skeleton">
          {[1, 2].map((n) => (
            <div
              key={n}
              className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-md)] p-5 shadow-[var(--sh-1)] animate-pulse space-y-3"
            >
              <div className="h-5 w-40 bg-[var(--surface-alt)] rounded-[var(--r-sm)]" />
              <div className="h-8 w-64 bg-[var(--surface-alt)] rounded-[var(--r-sm)]" />
            </div>
          ))}
        </div>
      )}

      {!loading && errorAr && (
        <div
          role="alert"
          className="bg-[var(--sev-critical-bg)] border border-[var(--border)] rounded-[var(--r-md)] p-5 text-[var(--sev-critical-fg)] space-y-3"
        >
          <p className="text-[16px] font-bold">{errorAr}</p>
          <button
            type="button"
            onClick={fetchReports}
            className="min-h-[44px] px-4 py-2 rounded-[var(--r-md)] bg-[var(--surface)] text-[var(--ink)] border border-[var(--border-strong)] text-[14px] font-bold"
          >
            جرب تاني
          </button>
        </div>
      )}

      {!loading && !errorAr && groupedDomains.length === 0 && (
        <div
          data-testid="reports-empty-state"
          className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-md)] p-8 text-center shadow-[var(--sh-1)] space-y-4"
        >
          <p className="text-[18px] font-bold text-[var(--ink)]">
            لسه ما عملتش أي مراجعة من المتصفح ده.
          </p>
          <p className="text-[14px] text-[var(--ink-muted)] max-w-md mx-auto">
            ابعت لينك موقعك وهفحصه بالدليل، وكل مراجعة هتظهر هنا بترتيبها (R1, R2, R3).
          </p>
          <button
            type="button"
            onClick={onStartNewScan}
            className="min-h-[44px] px-5 py-2.5 rounded-[var(--r-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-[16px] font-bold inline-flex items-center gap-2 transition-colors"
          >
            <PlusCircle className="w-5 h-5" />
            <span>فحص جديد</span>
          </button>
        </div>
      )}

      {!loading && !errorAr && groupedDomains.length > 0 && (
        <div className="space-y-4">
          {groupedDomains.map((group) => {
            const latestItem = group.items[group.items.length - 1];
            const selectedScanId = selectedScanByDomain[group.domain] || latestItem.scanId;
            const activeItem =
              group.items.find((i) => i.scanId === selectedScanId) || latestItem;

            return (
              <div
                key={group.domain}
                data-testid={`domain-report-group-${group.domain}`}
                className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-md)] p-5 shadow-[var(--sh-1)] space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[18px] font-bold text-[var(--ink)]">
                      <bdi dir="ltr">{group.domain}</bdi>
                    </h2>
                    <StatusDot status={activeItem.status} compact />
                  </div>
                  <span className="text-[12px] text-[var(--ink-muted)]">
                    {formatDate(new Date(activeItem.createdAtMs).toISOString())}
                  </span>
                </div>

                {/* Review chips R1, R2, R3 with status dots and verdict word */}
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`مراجعات ${group.domain}`}>
                  {group.items.map((rev) => {
                    const isSelected = rev.scanId === activeItem.scanId;
                    const verdictWord =
                      rev.verdictLabelAr ||
                      rev.verdictHeadlineAr ||
                      (rev.status === 'running' || rev.status === 'queued'
                        ? 'جاري الفحص'
                        : rev.status === 'completed' || rev.status === 'partial'
                        ? 'مكتمل'
                        : 'لم يكتمل');

                    return (
                      <button
                        key={rev.scanId}
                        type="button"
                        onClick={() =>
                          setSelectedScanByDomain((prev) => ({
                            ...prev,
                            [group.domain]: rev.scanId,
                          }))
                        }
                        data-testid={`review-chip-R${rev.reviewNumber}`}
                        className={`min-h-[44px] px-3 py-1.5 rounded-[var(--r-sm)] border text-[13px] inline-flex items-center gap-2 transition-colors ${
                          isSelected
                            ? 'border-[var(--primary)] bg-[var(--surface-alt)] font-bold text-[var(--ink)]'
                            : 'border-[var(--border)] bg-[var(--surface)] text-[var(--ink-muted)] hover:bg-[var(--surface-alt)]'
                        }`}
                      >
                        <bdi dir="ltr" className="font-mono font-bold text-[var(--primary)]">
                          R{rev.reviewNumber}
                        </bdi>
                        <StatusDot status={rev.status} compact />
                        <span className="truncate max-w-[180px]">{verdictWord}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Actions: افتح & أعد الفحص */}
                <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
                  <button
                    type="button"
                    onClick={() => onRescanDomain(activeItem.requestedUrl)}
                    data-testid={`rescan-domain-btn-${group.domain}`}
                    className="min-h-[44px] px-4 py-2 rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] text-[var(--ink)] text-[14px] font-bold inline-flex items-center gap-1.5 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4 text-[var(--primary)]" />
                    <span>أعد الفحص</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onOpenReport(activeItem.scanId, activeItem.status)}
                    data-testid={`open-report-btn-${group.domain}`}
                    className="min-h-[44px] px-5 py-2 rounded-[var(--r-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-[14px] font-bold inline-flex items-center gap-1.5 transition-colors"
                  >
                    <span>افتح</span>
                    <ExternalLink className="w-4 h-4 rtl-flip" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
