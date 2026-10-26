import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  AlertCircle,
  Globe,
  Gauge,
  SearchCheck,
  Code2,
  Mic,
  CheckCircle2,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  Link2,
  Terminal,
  RefreshCw,
  ChevronDown,
  X,
} from 'lucide-react';
import { normalizeUserDomainOrUrl } from '../lib/url-gatekeeper';
import { DomainLockInfo } from './Header';
import { ScanOptionsConfig } from '../types/contract';
import { formatNumber } from '../lib/format';
import { MOCK_DEMO_REPORTS } from '../lib/demo-reports';
import { FEATURE_FLAGS } from '../config/limits';

interface MadamAfafHeroProps {
  domainLock?: DomainLockInfo | null;
  systemAvailable: boolean;
  onStartScan: (params: {
    url: string;
    purpose?: string;
    keyJourney?: string;
    aiClaims?: string;
    options?: ScanOptionsConfig;
    isAuthorized: boolean;
  }) => void;
  onOpenSampleReport?: (reportId?: 'wordpress_b2b' | 'spa_ai_built') => void;
  onSheetOpenChange?: (open: boolean) => void;
  loading: boolean;
  error?: string | null;
}

const DESKTOP_SITE_TYPES = [
  { id: 'company', label: 'موقع شركة / مصنع' },
  { id: 'store', label: 'متجر إلكتروني' },
  { id: 'landing', label: 'صفحة هبوط' },
  { id: 'booking', label: 'منصة خدمات' },
];

const DESKTOP_INSPECTION_PILLARS = [
  {
    icon: Globe,
    title: 'حالة الموقع والمنصة وفحص حتى 10 صفحات',
    desc: 'كشف الصيانة أو الحجب، وتحديد ووردبريس/Elementor أو SPA وفحص الصفحات الأساسية',
  },
  {
    icon: Gauge,
    title: 'سرعة السيرفر وحجم الميديا بدون تخمين',
    desc: 'قياس TTFB الفعلي وحجم الصور والفيديو، وذكر ما لم يُقَس بصراحة',
  },
  {
    icon: SearchCheck,
    title: 'مراجعة السيو والهوية والأسواق',
    desc: 'فحص العناوين، تكرار Alt، تطابق اسم البراند، وجاهزية التصدير واللغة',
  },
  {
    icon: Code2,
    title: 'مقارنة كلام الـ AI بالواقع + خطة إصلاح',
    desc: 'جدول "قالك إيه الـ AI؟" بالدليل، مع خطوات إصلاح لمنصتك وبرومبت جاهز',
  },
];

export const MadamAfafHero: React.FC<MadamAfafHeroProps> = ({
  domainLock,
  systemAvailable,
  onStartScan,
  onOpenSampleReport,
  onSheetOpenChange,
  loading,
  error,
}) => {
  const [url, setUrl] = useState('');
  const [selectedPurpose, setSelectedPurpose] = useState<string>('');
  const [aiClaims, setAiClaims] = useState<string>('');
  const [optionsPopoverOpen, setOptionsPopoverOpen] = useState<boolean>(false);
  const [aiClaimsPopoverOpen, setAiClaimsPopoverOpen] = useState<boolean>(false);
  const [showUrlHint, setShowUrlHint] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [scanOptions, setScanOptions] = useState<Required<ScanOptionsConfig>>({
    checkPageSpeed: true,
    checkLinksAndErrors: true,
    checkSeo: true,
    checkSecurityAndMobile: true,
  });

  useEffect(() => {
    onSheetOpenChange?.(optionsPopoverOpen || aiClaimsPopoverOpen);
  }, [optionsPopoverOpen, aiClaimsPopoverOpen, onSheetOpenChange]);

  const allChecked =
    scanOptions.checkPageSpeed &&
    scanOptions.checkLinksAndErrors &&
    scanOptions.checkSeo &&
    scanOptions.checkSecurityAndMobile;

  const toggleAllOptions = () => {
    const nextValue = !allChecked;
    setScanOptions({
      checkPageSpeed: true,
      checkLinksAndErrors: nextValue,
      checkSeo: nextValue,
      checkSecurityAndMobile: nextValue,
    });
  };

  const toggleSingleOption = (key: keyof Required<ScanOptionsConfig>) => {
    setScanOptions((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      const anyActive =
        updated.checkPageSpeed ||
        updated.checkLinksAndErrors ||
        updated.checkSeo ||
        updated.checkSecurityAndMobile;
      if (!anyActive) return prev;
      return updated;
    });
  };

  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const inFlightSubmitRef = useRef<boolean>(false);

  useEffect(() => {
    if (!loading) {
      inFlightSubmitRef.current = false;
    }
  }, [loading]);

  const handleSubmitScan = (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || inFlightSubmitRef.current) return;
    setLocalError(null);
    const rawValue = url.trim();

    if (!rawValue) {
      setShowUrlHint(true);
      urlInputRef.current?.focus();
      return;
    }

    const normalized = normalizeUserDomainOrUrl(rawValue);
    if (!normalized) {
      setLocalError('اكتب اسم الموقع صح (مثال: example.com)');
      urlInputRef.current?.focus();
      return;
    }

    setShowUrlHint(false);
    inFlightSubmitRef.current = true;
    onStartScan({
      url: normalized,
      purpose: selectedPurpose || undefined,
      aiClaims: aiClaims.trim() || undefined,
      options: scanOptions,
      isAuthorized: true,
    });
  };

  const handleOpenChatWithVoice = () => {
    window.dispatchEvent(
      new CustomEvent('open-madam-afaf-chat', { detail: { speakGreeting: true } })
    );
  };

  const steps = [
    { icon: Link2, label: 'ابعت اللينك' },
    { icon: SearchCheck, label: 'شوف المشاكل بالدليل' },
    { icon: Terminal, label: 'انسخ البرومبت' },
    { icon: RefreshCw, label: 'أعد الفحص' },
  ];

  return (
    <div className="max-w-[720px] mx-auto px-4 pt-6 sm:pt-12 pb-28">
      <div className="space-y-6 text-center">
        {/* 1. Top Logo: Wordmark + Avatar */}
        <div
          className="inline-flex items-center justify-center gap-3 mx-auto"
          data-testid="landing-top-brand"
        >
          <div
            aria-hidden="true"
            className="w-[40px] h-[40px] rounded-full bg-[var(--primary)] text-[var(--on-primary)] flex items-center justify-center font-bold text-[20px] select-none shrink-0 shadow-[var(--sh-1)]"
          >
            ع
          </div>
          <span className="text-[24px] sm:text-[30px] font-bold text-[var(--ink)] leading-[1.35]">
            مدام{' '}
            <span className="border-b-[3px] border-[var(--pen)] pb-0.5">عفاف</span>
          </span>
        </div>

        {/* 2. Headline */}
        <div className="space-y-2">
          <h1 className="text-[24px] sm:text-[36px] font-bold text-[var(--ink)] leading-[1.35]">
            ما بتخمنش. بتشوف، وبتورّيك الدليل.
          </h1>
        </div>

        {/* Domain Lock Banner when active */}
        {domainLock && domainLock.domain && (
          <div
            role="status"
            data-testid="domain-lock-status-banner"
            className={`p-3.5 border rounded-[var(--r-md)] text-[14px] flex flex-wrap items-center justify-between gap-2.5 text-start ${
              domainLock.exhausted
                ? 'bg-[var(--sev-medium-bg)] border-[var(--sev-medium-fg)] text-[var(--ink)]'
                : 'bg-[var(--surface-alt)] border-[var(--primary)] text-[var(--ink)]'
            }`}
          >
            <div className="space-y-0.5">
              <div className="font-bold flex flex-wrap items-center gap-1.5">
                <span>النطاق المفعّل حالياً:</span>
                <bdi dir="ltr" className="font-mono text-[var(--primary)]">
                  {domainLock.domain}
                </bdi>
              </div>
              <div className="text-[12px] text-[var(--ink-muted)]">
                <span>
                  الرصيد المتبقي:{' '}
                  <bdi dir="ltr" className="font-mono font-bold text-[var(--ink)]">
                    {formatNumber(domainLock.pagesRemaining)}/
                    {formatNumber(domainLock.maxPages || 10)}
                  </bdi>{' '}
                  صفحات
                </span>
                {typeof domainLock.remainingMinutes === 'number' &&
                  domainLock.remainingMinutes > 0 && (
                    <span>
                      {' '}
                      · يتجدد بعد{' '}
                      <bdi dir="ltr">{formatNumber(domainLock.remainingMinutes)}</bdi> دقيقة
                    </span>
                  )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                if (domainLock.domain) {
                  setUrl(domainLock.domain);
                  setShowUrlHint(false);
                  setLocalError(null);
                }
              }}
              className="min-h-[44px] px-3 py-1.5 rounded-[var(--r-sm)] border border-[var(--primary)] bg-[var(--surface)] text-[var(--primary)] text-[12px] font-bold cursor-pointer shrink-0"
            >
              فحص نفس النطاق
            </button>
          </div>
        )}

        {/* Error Banner */}
        {(error || localError) && (
          <div
            role="alert"
            className="p-3.5 border border-[var(--sev-critical-fg)] bg-[var(--sev-critical-bg)] text-[var(--sev-critical-fg)] rounded-[var(--r-md)] text-[14px] font-bold flex items-start gap-2.5 text-start"
          >
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <span>{error || localError}</span>
          </div>
        )}

        {/* 3. ONE Input + Primary Button "افحص" (same row on desktop, stacked on mobile) */}
        <form
          onSubmit={handleSubmitScan}
          className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] p-4 sm:p-5 shadow-[var(--sh-1)] space-y-3"
        >
          <label htmlFor="target-url" className="sr-only">
            رابط الموقع (فحص موقع جديد الآن)
          </label>
          <div className="flex flex-col sm:flex-row items-stretch gap-2.5">
            <input
              ref={urlInputRef}
              id="target-url"
              type="text"
              inputMode="url"
              dir="ltr"
              disabled={loading || !systemAvailable}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (e.target.value.trim()) {
                  setShowUrlHint(false);
                  setLocalError(null);
                }
              }}
              placeholder="example.com"
              className={`flex-1 min-h-[48px] px-4 py-3 text-[16px] sm:text-[18px] font-bold font-mono text-start rounded-[var(--r-md)] border-2 transition-colors ${
                showUrlHint
                  ? 'bg-[var(--sev-medium-bg)] border-[var(--sev-medium-fg)] text-[var(--ink)]'
                  : 'bg-[var(--bg)] border-[var(--border-strong)] text-[var(--ink)]'
              }`}
            />

            <button
              type="submit"
              disabled={loading || !systemAvailable}
              data-testid="landing-primary-scan-btn"
              className="min-h-[48px] px-7 py-3 rounded-[var(--r-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-[18px] font-bold shadow-[var(--sh-1)] inline-flex items-center justify-center gap-2 cursor-pointer transition-colors shrink-0"
            >
              <span>{loading ? 'شغّال...' : 'افحص'}</span>
              <ArrowLeft className="w-5 h-5 shrink-0" />
            </button>
          </div>

          {showUrlHint && !url.trim() && (
            <p
              role="status"
              className="text-[14px] font-bold text-[var(--sev-medium-fg)] text-start"
            >
              حط اللينك الأول (مثال: <bdi dir="ltr">example.com</bdi>)
            </p>
          )}

          {/* Tiny Caption */}
          <p
            aria-label="افحص مواقعك أو مواقع معاك إذن صاحبها"
            className="text-[12px] text-[var(--ink-muted)] flex items-center justify-center gap-1.5 pt-0.5"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-[var(--primary)] shrink-0" />
            <span>موقعك أو موقع معاك إذن صاحبه</span>
            <span className="sr-only">افحص مواقعك أو مواقع معاك إذن صاحبها</span>
          </p>
        </form>

        {/* 4. Quiet 4-Step Strip */}
        <div
          aria-label="خطوات المراجعة"
          data-testid="landing-4step-strip"
          className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[14px] text-[var(--ink-muted)]"
        >
          {steps.map((step, idx) => {
            const Icon = step.icon;
            return (
              <div
                key={idx}
                className="bg-[var(--surface-alt)]/70 border border-[var(--border)] rounded-[var(--r-md)] px-3 py-2.5 flex items-center justify-center gap-2"
              >
                <Icon className="w-4 h-4 text-[var(--primary)] shrink-0" aria-hidden="true" />
                <span className="font-medium text-[var(--ink)] whitespace-nowrap">
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>

        {/* 5. Two Small Pills under the 4-step strip */}
        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => {
              setAiClaimsPopoverOpen(false);
              setOptionsPopoverOpen(true);
            }}
            data-testid="landing-options-pill"
            aria-label={allChecked ? 'هنفحص: الكل ▾' : 'هنفحص: مخصص ▾'}
            className="min-h-[44px] px-4 py-2 rounded-[var(--r-lg)] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] text-[14px] font-bold text-[var(--ink)] inline-flex items-center gap-1.5 cursor-pointer transition-colors"
          >
            <span>{allChecked ? 'هنفحص: الكل' : 'هنفحص: مخصص'}</span>
            <ChevronDown className="w-4 h-4 text-[var(--ink-muted)] shrink-0" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={() => {
              setOptionsPopoverOpen(false);
              setAiClaimsPopoverOpen(true);
            }}
            data-testid="landing-ai-claims-pill"
            className={`min-h-[44px] px-4 py-2 rounded-[var(--r-lg)] border text-[14px] font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors ${
              aiClaims.trim()
                ? 'border-[var(--primary)] bg-[var(--surface-alt)] text-[var(--primary)]'
                : 'border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] text-[var(--ink-muted)]'
            }`}
          >
            <Sparkles className="w-4 h-4 text-[var(--primary)] shrink-0" />
            <span>الـ AI قالك إيه؟ (اختياري)</span>
          </button>
        </div>

        {/* Popover / Bottom Sheet 1: Scan Options */}
        {optionsPopoverOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--ink)]/30 p-0 sm:p-4 text-start"
            onClick={() => setOptionsPopoverOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label="خيارات الفحص"
            data-testid="landing-options-sheet"
          >
            <div
              className="w-full sm:max-w-md bg-[var(--surface)] border-t sm:border border-[var(--border)] rounded-t-[var(--r-lg)] sm:rounded-[var(--r-lg)] shadow-[var(--sh-3)] p-5 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
                <div>
                  <h2 className="text-[18px] font-bold text-[var(--ink)]">هنفحص إيه؟</h2>
                  <p className="text-[12px] text-[var(--ink-muted)]">لحد 10 صفحات في المراجعة</p>
                </div>
                <button
                  type="button"
                  onClick={() => setOptionsPopoverOpen(false)}
                  aria-label="إغلاق خيارات الفحص"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[var(--r-sm)] text-[var(--ink-muted)] hover:bg-[var(--surface-alt)]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-[14px] font-bold text-[var(--ink)]">اختار الجوانب:</span>
                <button
                  type="button"
                  onClick={toggleAllOptions}
                  className="min-h-[44px] px-3 py-1 rounded-[var(--r-sm)] border border-[var(--primary)] text-[12px] font-bold text-[var(--primary)]"
                >
                  {allChecked ? 'تحديد مخصص' : 'فحص الكل'}
                </button>
              </div>

              <div className="space-y-2 text-[14px]">
                {[
                  {
                    key: 'checkPageSpeed' as const,
                    label: 'السرعة والأداء (PageSpeed)',
                  },
                  {
                    key: 'checkLinksAndErrors' as const,
                    label: 'الروابط والأخطاء التقنية',
                  },
                  {
                    key: 'checkSeo' as const,
                    label: 'السيو والظهور في جوجل (SEO)',
                  },
                  {
                    key: 'checkSecurityAndMobile' as const,
                    label: 'الأمان الأساسي وتجربة الموبايل',
                  },
                ].map((opt) => (
                  <label
                    key={opt.key}
                    className={`min-h-[44px] flex items-center gap-3 p-3 rounded-[var(--r-md)] border cursor-pointer select-none ${
                      scanOptions[opt.key]
                        ? 'border-[var(--primary)] bg-[var(--surface-alt)]'
                        : 'border-[var(--border)] bg-[var(--surface)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={scanOptions[opt.key]}
                      onChange={() => toggleSingleOption(opt.key)}
                      className="w-4 h-4 accent-[var(--primary)] shrink-0"
                    />
                    <span className="font-medium text-[var(--ink)]">{opt.label}</span>
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setOptionsPopoverOpen(false)}
                className="w-full min-h-[44px] py-2.5 rounded-[var(--r-md)] bg-[var(--primary)] text-[var(--on-primary)] text-[16px] font-bold"
              >
                تمام
              </button>
            </div>
          </div>
        )}

        {/* Popover / Bottom Sheet 2: AI Claims */}
        {aiClaimsPopoverOpen && (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--ink)]/30 p-0 sm:p-4 text-start"
            onClick={() => setAiClaimsPopoverOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label="الـ AI قالك إيه؟"
            data-testid="landing-ai-claims-sheet"
          >
            <div
              className="w-full sm:max-w-md bg-[var(--surface)] border-t sm:border border-[var(--border)] rounded-t-[var(--r-lg)] sm:rounded-[var(--r-lg)] shadow-[var(--sh-3)] p-5 space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
                <div>
                  <h2 className="text-[18px] font-bold text-[var(--ink)]">
                    الـ AI قالك إيه؟ (اختياري)
                  </h2>
                  <p className="text-[12px] text-[var(--ink-muted)]">
                    اكتب الوعود اللي اتقالتلك عشان أقارنها بالواقع بالدليل.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setAiClaimsPopoverOpen(false)}
                  aria-label="إغلاق"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[var(--r-sm)] text-[var(--ink-muted)] hover:bg-[var(--surface-alt)]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <textarea
                rows={3}
                value={aiClaims}
                onChange={(e) => setAiClaims(e.target.value)}
                placeholder="مثال: قالي إن الموقع سريع والسيو متظبط وجاهز للإطلاق..."
                className="w-full p-3 text-[16px] rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--bg)] text-[var(--ink)]"
              />

              <div className="flex flex-wrap gap-1.5 text-[12px]">
                {[
                  'الموقع متجاوب على الموبايل والسيو متظبط وجاهز للإطلاق',
                  'الموقع سريع ومؤمن بالكامل وكل الروابط شغالة',
                ].map((sample, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setAiClaims(sample)}
                    className="px-2.5 py-1.5 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-alt)] text-[var(--ink)] font-medium cursor-pointer"
                  >
                    + «{sample}»
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setAiClaimsPopoverOpen(false)}
                className="w-full min-h-[44px] py-2.5 rounded-[var(--r-md)] bg-[var(--primary)] text-[var(--on-primary)] text-[16px] font-bold"
              >
                حفظ
              </button>
            </div>
          </div>
        )}

        {/* Feature-flag gated blocks (OFF by default per B1.4) */}
        {FEATURE_FLAGS.SHOW_LANDING_EXAMPLES && (
          <div className="hidden lg:block pt-3 space-y-2.5 border-t border-[var(--border)]">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[var(--ink)]">
                <SlidersHorizontal className="w-3.5 h-3.5 text-[var(--primary)]" />
                <span>تحديد نوع الموقع (اختياري):</span>
              </span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {DESKTOP_SITE_TYPES.map((t) => {
                const isSelected = selectedPurpose === t.label;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedPurpose(isSelected ? '' : t.label)}
                    className="py-2 px-2 border text-xs font-bold"
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {FEATURE_FLAGS.SHOW_MOCK_SAMPLE_BUTTONS && onOpenSampleReport && (
          <div className="mt-4 pt-3.5 border-t border-[var(--border)] space-y-2">
            <button
              type="button"
              data-testid="open-sample-report-btn"
              onClick={() => onOpenSampleReport('wordpress_b2b')}
              className="min-h-[44px] p-2.5 border text-start"
            >
              {MOCK_DEMO_REPORTS[0].labelAr}
            </button>
          </div>
        )}

        {FEATURE_FLAGS.SHOW_METHODOLOGY_PANEL && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-[var(--primary)]" />
              <h2>منهجية الفحص الصادق</h2>
            </div>
            {DESKTOP_INSPECTION_PILLARS.map((item, i) => (
              <div key={i}>{item.title}</div>
            ))}
          </div>
        )}

        {FEATURE_FLAGS.SHOW_VOICE_TEASER && (
          <div>
            <button type="button" onClick={handleOpenChatWithVoice}>
              <Mic className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
