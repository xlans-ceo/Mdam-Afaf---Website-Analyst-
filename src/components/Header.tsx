import React from 'react';
import { MessageSquareCode, History } from 'lucide-react';
import { MadamAfafAvatar } from './MadamAfafAvatar';

export interface DomainLockInfo {
  domain: string | null;
  pagesUsed: number;
  pagesRemaining: number;
  maxPages?: number;
  resetAt: string | null;
  exhausted: boolean;
  remainingMinutes?: number;
}

interface HeaderProps {
  domainLock?: DomainLockInfo | null;
  scanMode?: string;
  recentScansCount?: number;
  onOpenRecentScans?: () => void;
  onResetHome?: () => void;
}


export const Header: React.FC<HeaderProps> = ({
  domainLock,
  recentScansCount = 0,
  onOpenRecentScans,
  onResetHome
}) => {
  const handleOpenChat = () => {
    window.dispatchEvent(new CustomEvent('open-madam-afaf-chat'));
  };

  return (
    <header
      className="no-print border-b"
      style={{
        backgroundColor: 'var(--surface)',
        borderColor: 'var(--border)'
      }}
    >
      <div className="max-w-xl lg:max-w-[1200px] mx-auto px-4 h-12 flex items-center justify-between gap-3">
        {/* Signature Wordmark & Madam Afaf Cartoon Avatar */}
        <button
          type="button"
          onClick={onResetHome}
          className="flex items-center gap-2.5 text-start cursor-pointer shrink-0"
        >
          <MadamAfafAvatar size={36} />
          <div className="flex items-center gap-2.5">
            <span
              className="text-lg sm:text-xl font-bold whitespace-nowrap"
              style={{ color: 'var(--ink)' }}
            >
              مدام <span className="afaf-pen-underline">عفاف</span>
            </span>
            <span
              className="hidden md:inline-block text-xs font-medium px-2.5 py-0.5 border whitespace-nowrap"
              style={{
                backgroundColor: 'var(--surface-alt)',
                borderColor: 'var(--border)',
                color: 'var(--ink-muted)',
                borderRadius: 'var(--r-sm)'
              }}
            >
              دفتر المراجعة بالدليل
            </span>
          </div>
        </button>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">

          {recentScansCount > 0 && onOpenRecentScans && (
            <button
              type="button"
              onClick={onOpenRecentScans}
              className="inline-flex items-center gap-1.5 px-3 py-2 border text-xs font-bold cursor-pointer transition-colors"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                color: 'var(--ink)',
                borderRadius: 'var(--r-sm)'
              }}
            >
              <History className="w-4 h-4 shrink-0" />
              <span>تقاريري (<bdi dir="ltr">{recentScansCount}</bdi>)</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleOpenChat}
            className="hidden lg:inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold transition-colors cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: 'var(--primary)',
              color: 'var(--on-primary)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            <MessageSquareCode className="w-4 h-4 shrink-0" />
            <span>اسأل مدام عفاف</span>
          </button>
        </div>
      </div>
    </header>
  );
};
