import React, { useState, useRef } from 'react';
import {
  PlusCircle,
  FolderClock,
  Terminal,
  MessageCircle,
  MoreHorizontal,
  Printer,
  Download,
  Share2,
  Shield,
  FileText,
  ExternalLink,
  X,
  Check,
} from 'lucide-react';
import { OFFICIAL_LINKEDIN_URL } from '../config/limits';

export interface MadamAfafDockProps {
  activeView: 'home' | 'scanning' | 'report' | 'reports' | 'privacy' | 'terms';
  hasOpenReport: boolean;
  hasRunningScan: boolean;
  isAnySheetOpen: boolean;
  moreSheetOpen: boolean;
  onMoreSheetOpenChange: (open: boolean) => void;
  onNewScan: () => void;
  onOpenReports: () => void;
  onCopyPrompt: () => void;
  onOpenChat: () => void;
  onPrintReport?: () => void;
  onExportJson?: () => void;
  onShareReport?: () => void;
  onOpenPrivacy?: () => void;
  onOpenTerms?: () => void;
  promptCopiedFeedback?: boolean;
}

export const MadamAfafDock: React.FC<MadamAfafDockProps> = ({
  activeView,
  hasOpenReport,
  hasRunningScan,
  isAnySheetOpen,
  moreSheetOpen,
  onMoreSheetOpenChange,
  onNewScan,
  onOpenReports,
  onCopyPrompt,
  onOpenChat,
  onPrintReport,
  onExportJson,
  onShareReport,
  onOpenPrivacy,
  onOpenTerms,
  promptCopiedFeedback = false,
}) => {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [bouncingId, setBouncingId] = useState<string | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const triggerBounce = (id: string, callback: () => void) => {
    setBouncingId(id);
    setTimeout(() => {
      setBouncingId((prev) => (prev === id ? null : prev));
    }, 220);
    callback();
  };

  const items = [
    {
      id: 'new_scan',
      label: 'فحص جديد',
      ariaLabel: 'فحص جديد',
      icon: PlusCircle,
      active: activeView === 'home',
      disabled: false,
      onClick: () => triggerBounce('new_scan', onNewScan),
    },
    {
      id: 'reports',
      label: 'تقاريري',
      ariaLabel: hasRunningScan ? 'تقاريري (فحص شغّال)' : 'تقاريري',
      icon: FolderClock,
      active: activeView === 'reports',
      disabled: false,
      badgeRunning: hasRunningScan,
      onClick: () => triggerBounce('reports', onOpenReports),
    },
    {
      id: 'prompt',
      label: promptCopiedFeedback ? 'اتنسخ!' : 'البرومبت',
      ariaLabel: hasOpenReport ? 'انسخ البرومبت' : 'البرومبت (افتح تقرير الأول)',
      icon: promptCopiedFeedback ? Check : Terminal,
      active: false,
      disabled: !hasOpenReport,
      onClick: () => {
        if (!hasOpenReport) return;
        triggerBounce('prompt', onCopyPrompt);
      },
    },
    {
      id: 'chat',
      label: 'شات عفاف',
      ariaLabel: 'شات عفاف',
      icon: MessageCircle,
      active: false,
      disabled: false,
      onClick: () => triggerBounce('chat', onOpenChat),
    },
    {
      id: 'more',
      label: 'المزيد',
      ariaLabel: 'المزيد من الخيارات',
      icon: MoreHorizontal,
      active: moreSheetOpen,
      disabled: false,
      onClick: () => triggerBounce('more', () => onMoreSheetOpenChange(!moreSheetOpen)),
    },
  ];

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    // In RTL, ArrowLeft moves to next item, ArrowRight moves to previous item
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = (idx + 1) % items.length;
      setFocusedIndex(next);
      buttonRefs.current[next]?.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const prev = (idx - 1 + items.length) % items.length;
      setFocusedIndex(prev);
      buttonRefs.current[prev]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedIndex(0);
      buttonRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = items.length - 1;
      setFocusedIndex(last);
      buttonRefs.current[last]?.focus();
    }
  };

  return (
    <>
      {/* "المزيد" Sheet */}
      {moreSheetOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--ink)]/30 p-0 sm:p-4 no-print"
          onClick={() => onMoreSheetOpenChange(false)}
          role="dialog"
          aria-modal="true"
          aria-label="المزيد من الخيارات"
          data-testid="dock-more-sheet"
        >
          <div
            className="w-full sm:max-w-md bg-[var(--surface)] border-t sm:border border-[var(--border)] rounded-t-[var(--r-lg)] sm:rounded-[var(--r-lg)] shadow-[var(--sh-3)] p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <h2 className="text-[18px] font-bold text-[var(--ink)]">المزيد</h2>
              <button
                type="button"
                onClick={() => onMoreSheetOpenChange(false)}
                aria-label="إغلاق القائمة"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[var(--r-sm)] text-[var(--ink-muted)] hover:bg-[var(--surface-alt)] hover:text-[var(--ink)]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                disabled={!hasOpenReport}
                onClick={() => {
                  onMoreSheetOpenChange(false);
                  onPrintReport?.();
                }}
                data-testid="dock-more-print"
                className="min-h-[44px] w-full flex items-center justify-between px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] text-[14px] font-bold text-[var(--ink)] hover:bg-[var(--surface-alt)] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <Printer className="w-4 h-4 text-[var(--primary)]" />
                  <span>PDF/طباعة</span>
                </span>
                {!hasOpenReport && <span className="text-[12px] text-[var(--ink-muted)] font-normal">افتح تقرير الأول</span>}
              </button>

              <button
                type="button"
                disabled={!hasOpenReport}
                onClick={() => {
                  onMoreSheetOpenChange(false);
                  onExportJson?.();
                }}
                data-testid="dock-more-json"
                className="min-h-[44px] w-full flex items-center justify-between px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] text-[14px] font-bold text-[var(--ink)] hover:bg-[var(--surface-alt)] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <Download className="w-4 h-4 text-[var(--primary)]" />
                  <span>تصدير JSON</span>
                </span>
                {!hasOpenReport && <span className="text-[12px] text-[var(--ink-muted)] font-normal">افتح تقرير الأول</span>}
              </button>

              <button
                type="button"
                disabled={!hasOpenReport}
                onClick={() => {
                  onMoreSheetOpenChange(false);
                  onShareReport?.();
                }}
                data-testid="dock-more-share"
                className="min-h-[44px] w-full flex items-center justify-between px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] text-[14px] font-bold text-[var(--ink)] hover:bg-[var(--surface-alt)] disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <Share2 className="w-4 h-4 text-[var(--primary)]" />
                  <span>مشاركة</span>
                </span>
                {!hasOpenReport && <span className="text-[12px] text-[var(--ink-muted)] font-normal">افتح تقرير الأول</span>}
              </button>

              <div className="border-t border-[var(--border)] my-1" />

              <div className="grid grid-cols-2 gap-2">
                <a
                  href="/privacy"
                  onClick={(e) => {
                    if (onOpenPrivacy) {
                      e.preventDefault();
                      onMoreSheetOpenChange(false);
                      onOpenPrivacy();
                    }
                  }}
                  data-testid="dock-more-privacy"
                  className="min-h-[44px] flex items-center gap-2 px-3 py-2 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-alt)] text-[14px] font-bold text-[var(--ink)] hover:border-[var(--border-strong)] transition-colors"
                >
                  <Shield className="w-4 h-4 text-[var(--primary)] shrink-0" />
                  <span>الخصوصية</span>
                </a>

                <a
                  href="/terms"
                  onClick={(e) => {
                    if (onOpenTerms) {
                      e.preventDefault();
                      onMoreSheetOpenChange(false);
                      onOpenTerms();
                    }
                  }}
                  data-testid="dock-more-terms"
                  className="min-h-[44px] flex items-center gap-2 px-3 py-2 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface-alt)] text-[14px] font-bold text-[var(--ink)] hover:border-[var(--border-strong)] transition-colors"
                >
                  <FileText className="w-4 h-4 text-[var(--primary)] shrink-0" />
                  <span>الشروط</span>
                </a>
              </div>

              <a
                href={OFFICIAL_LINKEDIN_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="dock-more-linkedin"
                className="min-h-[44px] w-full flex items-center justify-between px-4 py-2.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] text-[14px] font-bold text-[var(--primary)] hover:bg-[var(--surface-alt)] transition-colors"
              >
                <span className="inline-flex items-center gap-2.5">
                  <ExternalLink className="w-4 h-4 shrink-0" />
                  <span dir="ltr">LinkedIn</span>
                </span>
                <span className="text-[12px] text-[var(--ink-muted)] font-normal">تواصل</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Dock Bar (hidden when any sheet is open) */}
      {!isAnySheetOpen && !moreSheetOpen && (
        <nav
          aria-label="شريط التنقل السريع"
          data-testid="madam-afaf-dock"
          dir="rtl"
          className="fixed bottom-0 inset-x-0 sm:bottom-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 z-40 no-print"
        >
          <div className="madam-dock-container bg-[var(--surface)]/95 backdrop-blur-md border-t sm:border border-[var(--border-strong)] sm:rounded-[var(--r-lg)] shadow-[var(--sh-2)] px-2 sm:px-3 py-1.5 pb-[max(6px,env(safe-area-inset-bottom))] flex items-center justify-between sm:justify-center gap-1 sm:gap-2 overflow-x-auto snap-x snap-mandatory">
            {items.map((item, idx) => {
              const Icon = item.icon;
              const isHovered = hoveredIndex === idx;
              const isNeighbor =
                hoveredIndex !== null && Math.abs(hoveredIndex - idx) === 1;
              const isBouncing = bouncingId === item.id;

              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    buttonRefs.current[idx] = el;
                  }}
                  type="button"
                  tabIndex={focusedIndex === idx ? 0 : -1}
                  aria-label={item.ariaLabel}
                  aria-disabled={item.disabled}
                  disabled={item.disabled}
                  data-testid={`dock-item-${item.id}`}
                  onFocus={() => setFocusedIndex(idx)}
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onKeyDown={(e) => handleKeyDown(e, idx)}
                  onClick={item.onClick}
                  className={`madam-dock-item snap-start shrink-0 relative group min-h-[44px] min-w-[62px] sm:min-w-[68px] px-2.5 py-1.5 rounded-[var(--r-md)] flex flex-col items-center justify-center gap-1 transition-all ${
                    isHovered ? 'madam-dock-hovered' : isNeighbor ? 'madam-dock-neighbor' : ''
                  } ${isBouncing ? 'madam-dock-bounce' : ''} ${
                    item.active
                      ? 'bg-[var(--primary)] text-[var(--on-primary)] font-bold'
                      : item.disabled
                      ? 'text-[var(--ink-muted)] opacity-45 cursor-not-allowed'
                      : 'text-[var(--ink)] hover:bg-[var(--surface-alt)] font-medium'
                  }`}
                >
                  {/* Desktop Tooltip */}
                  <span
                    role="tooltip"
                    className="hidden sm:block pointer-events-none opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap px-2.5 py-1 rounded-[var(--r-sm)] bg-[var(--ink)] text-[var(--surface)] text-[12px] font-bold shadow-[var(--sh-1)]"
                  >
                    {item.label}
                  </span>

                  <div className="relative flex items-center justify-center">
                    <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
                    {item.badgeRunning && (
                      <span
                        data-testid="dock-running-dot"
                        title="شغّال"
                        className="absolute -top-1 -start-2 inline-flex items-center gap-0.5 px-1 py-0.5 rounded-full bg-[var(--sev-medium-bg)] text-[var(--sev-medium-fg)] border border-[var(--border)] text-[12px] font-bold"
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--sev-medium-fg)] animate-pulse" />
                        <span className="sr-only">شغّال</span>
                      </span>
                    )}
                  </div>

                  <span className="text-[12px] leading-tight whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </>
  );
};
