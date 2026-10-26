import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ScanResult, Stage, ScanOptionsConfig } from './types/contract';
import { Header, DomainLockInfo } from './components/Header';
import { MadamAfafHero } from './components/MadamAfafHero';
import { ScanProgress } from './components/ScanProgress';
import { ReportView } from './components/ReportView';
import { DEVELOPER_CONTACT } from './config/limits';
import { RecentScansDrawer } from './components/RecentScansDrawer';
import { MadamAfafFloatingWidget } from './components/MadamAfafFloatingWidget';
import { MadamAfafDock } from './components/MadamAfafDock';
import { ReportsPage } from './components/ReportsPage';
import { PrivacyPage } from './components/PrivacyPage';
import { TermsPage } from './components/TermsPage';
import { RELEASE_CONFIG } from './config/release';
import { apiFetch } from './lib/api-client';
import {
  RECENT_SCANS_STORAGE_KEY,
  FULL_SCANS_STORAGE_KEY,
  MAX_CLIENT_POLL_DURATION_MS,
  ATTACHED_RUNNING_SCAN_MESSAGE_AR,
  ACTIVE_SCAN_ANNOUNCE_CHANNEL,
  getScanBroadcastChannelName,
  generateClientIdempotencyKey,
  RecentScanSummary,
  saveActiveScanSession,
  loadActiveScanSession,
  clearActiveScanSession,
  computePollBackoffMs,
  saveRecentScanSummaryToStorage,
  loadRecentScanSummariesFromStorage,
  saveFullScanToStorage,
  loadFullScanFromStorage,
  removeFullScanFromStorage
} from './lib/scan-lifecycle';
import { getMockDemoReport } from './lib/demo-reports';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class MadamAfafErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; onReset: () => void }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'حصل خطأ غير متوقع في عرض الصفحة'
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          dir="rtl"
          className="min-h-screen bg-[var(--bg)] text-[var(--ink)] flex items-center justify-center p-4"
        >
          <div className="max-w-md w-full ledger-card p-6 space-y-4 text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--primary)] text-[var(--on-primary)] font-bold text-[20px] flex items-center justify-center mx-auto">
              ع
            </div>
            <h1 className="text-[20px] font-bold text-[var(--ink)]">
              حقك عليا، حصل لخبطة بسيطة في عرض التقرير
            </h1>
            <p className="text-[16px] text-[var(--ink-muted)]">
              مش معناها إن الموقع واقع؛ دوس على الزرار تحت نرجّع الدفتر من أول وجديد.
            </p>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.removeItem(RECENT_SCANS_STORAGE_KEY);
                } catch {
                  // ignore
                }
                this.setState({ hasError: false, errorMessage: '' });
                this.props.onReset();
              }}
              className="w-full min-h-[48px] py-3 px-5 rounded-[var(--r-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] font-bold text-[16px] cursor-pointer"
            >
              فتح الصفحة الرئيسية من جديد
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const [domainLock, setDomainLock] = useState<DomainLockInfo | null>(null);
  const [systemAvailable, setSystemAvailable] = useState(true);
  const [activeScanId, setActiveScanId] = useState<string | null>(null);
  const [activeScanUrl, setActiveScanUrl] = useState<string>('');
  const [activeScanStartedAt, setActiveScanStartedAt] = useState<string | undefined>(undefined);
  const [scanStage, setScanStage] = useState<Stage>('url_check');
  const [stageStates, setStageStates] = useState<Record<Stage, 'pending' | 'started' | 'done' | 'skipped'>>({
    url_check: 'pending',
    discovery: 'pending',
    interaction: 'pending',
    lighthouse: 'pending',
    report: 'pending'
  });
  const [stageDetail, setStageDetail] = useState<string>('');
  const [pagesCount, setPagesCount] = useState(0);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [pollSlowWarningAr, setPollSlowWarningAr] = useState<string | null>(null);
  const [attachedScanBannerAr, setAttachedScanBannerAr] = useState<string | null>(null);
  const [unchangedNoticeAr, setUnchangedNoticeAr] = useState<string | null>(null);

  // Modals, Sheets & Pages
  const [showRecentScans, setShowRecentScans] = useState(false);
  const [showReportsPage, setShowReportsPage] = useState(
    typeof window !== 'undefined' && window.location.pathname === '/reports'
  );
  const [showPrivacyPage, setShowPrivacyPage] = useState(
    typeof window !== 'undefined' && window.location.pathname === '/privacy'
  );
  const [showTermsPage, setShowTermsPage] = useState(
    typeof window !== 'undefined' && window.location.pathname === '/terms'
  );
  const [recentScans, setRecentScans] = useState<RecentScanSummary[]>([]);
  const [heroSheetOpen, setHeroSheetOpen] = useState(false);
  const [reportSheetOpen, setReportSheetOpen] = useState(false);
  const [chatSheetOpen, setChatSheetOpen] = useState(false);
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);
  const [dockPromptCopied, setDockPromptCopied] = useState(false);
  const [serverRunningCount, setServerRunningCount] = useState(0);

  const pollAttemptRef = useRef(0);
  const pollStartedAtMsRef = useRef<number>(0);
  const startingScanRef = useRef<boolean>(false);
  const scanChannelRef = useRef<BroadcastChannel | null>(null);
  const lastOpenReportRef = useRef<ScanResult | null>(null);

  // G5.5: Load lightweight scan summaries from localStorage defensively
  useEffect(() => {
    const loaded = loadRecentScanSummariesFromStorage();
    setRecentScans(loaded);
    // Persist back sanitized summaries in case legacy bulky ScanResult objects were migrated
    if (loaded.length > 0) {
      try {
        localStorage.setItem(RECENT_SCANS_STORAGE_KEY, JSON.stringify(loaded));
      } catch {
        // ignore
      }
    }
  }, []);

  const fetchQuota = useCallback(async (domain?: string) => {
    try {
      const query = domain ? `?domain=${encodeURIComponent(domain)}` : '';
      const res = await apiFetch(`/api/quota${query}`);
      const data = await res.json();
      if (data.ok) {
        setDomainLock(
          data.quota || {
            domain: data.domain ?? null,
            pagesUsed: data.pagesUsed ?? 0,
            pagesRemaining: data.pagesRemaining ?? 10,
            maxPages: data.maxPages ?? 10,
            resetAt: data.resetAt ?? null,
            exhausted: Boolean(data.exhausted),
            remainingMinutes: data.remainingMinutes ?? 0
          }
        );
        setSystemAvailable(!data.hardDisabled);
      }
    } catch {
      // ignore network error on startup
    }
  }, []);

  useEffect(() => {
    fetchQuota();
  }, [fetchQuota]);

  const loadStoredReportById = useCallback(async (targetId: string, isPrintRoute = false) => {
    const cleanId = (targetId || '').trim();
    if (!cleanId || !/^[a-zA-Z0-9_-]{4,64}$/.test(cleanId)) {
      setError('معرّف الفحص في الرابط غير صحيح. اتأكد من الرابط أو ابدأ فحص جديد.');
      setLoading(false);
      setLoadingReport(false);
      if (window.location.pathname.startsWith('/report/')) {
        window.history.replaceState({}, '', '/');
      }
      return;
    }

    if (
      cleanId === 'mock_demo_wp_b2b_01' ||
      cleanId === 'mock_demo_spa_ai_01' ||
      cleanId.startsWith('mock_')
    ) {
      const isProdMode =
        typeof import.meta !== 'undefined' && (import.meta as any).env?.PROD === true;
      if (isProdMode) {
        setError('التقارير التجريبية (MOCK) غير متاحة في بيئة الإنتاج.');
        setLoading(false);
        setLoadingReport(false);
        if (window.location.pathname.startsWith('/report/')) {
          window.history.replaceState({}, '', '/');
        }
        return;
      }
      const demo = getMockDemoReport(
        cleanId === 'mock_demo_spa_ai_01' ? 'spa_ai_built' : 'wordpress_b2b'
      );
      setShowRecentScans(false);
      setLoading(false);
      setLoadingReport(false);
      setError(null);
      setActiveScanId(null);
      setScanResult(demo);
      return;
    }

    setShowRecentScans(false);
    setLoading(true);
    setLoadingReport(true);
    setError(null);
    setScanResult(null);
    setActiveScanId(null);

    try {
      const r = await apiFetch(`/api/scans/${cleanId}`);
      let data: any = null;
      const contentType = r.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        data = await r.json().catch(() => null);
      }
      setLoading(false);
      setLoadingReport(false);

      // Handle 404 Not Found explicitly -> first try local backup in localStorage
      if (r.status === 404) {
        const localFallback = loadFullScanFromStorage(cleanId);
        if (localFallback) {
          setScanResult(localFallback);
          clearActiveScanSession();
          if (isPrintRoute) {
            setTimeout(() => {
              if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(() => window.print());
              } else {
                window.print();
              }
            }, 400);
          }
          return;
        }

        clearActiveScanSession();
        if (window.location.pathname.startsWith('/report/')) {
          window.history.replaceState({}, '', '/');
        }
        removeFullScanFromStorage(cleanId);
        setRecentScans(prev => {
          const updated = prev.filter(s => s.scanId !== cleanId);
          try {
            localStorage.setItem(RECENT_SCANS_STORAGE_KEY, JSON.stringify(updated));
          } catch {
            // ignore
          }
          return updated;
        });
        setError('انتهت صلاحية هذا التقرير وتمت إزالته من السجل');
        return;
      }

      // Handle 410 Gone explicitly (deleted by user or expired after 30 days)
      if (r.status === 410) {
        clearActiveScanSession();
        if (window.location.pathname.startsWith('/report/')) {
          window.history.replaceState({}, '', '/');
        }
        removeFullScanFromStorage(cleanId);
        setRecentScans(prev => {
          const updated = prev.filter(s => s.scanId !== cleanId);
          try {
            localStorage.setItem(RECENT_SCANS_STORAGE_KEY, JSON.stringify(updated));
          } catch {
            // ignore
          }
          return updated;
        });
        setError(
          data?.error ||
            (data?.reason === 'deleted'
              ? 'التقرير ده اتمسح خلاص من الدفتر.'
              : 'انتهت صلاحية هذا التقرير وتمت إزالته من السجل')
        );
        return;
      }

      if (data && data.ok && data.scan) {
        if (data.scan.status === 'queued' || data.scan.status === 'running') {
          // If the report URL points to an in-flight scan, resume polling it
          setActiveScanId(cleanId);
          setActiveScanUrl(data.scan.requestedUrl || '');
          setActiveScanStartedAt(data.scan.startedAt);
          setScanStage(data.scan.currentStage || 'url_check');
          setStageStates(data.scan.stageStates);
          setStageDetail(data.scan.stageDetail || '');
          setPagesCount(data.scan.inspectedPagesCount || 0);
          return;
        }

        if (data.scan.result) {
          saveFullScanToStorage(data.scan.result);
          setScanResult(data.scan.result);
          clearActiveScanSession();
          if (isPrintRoute) {
            setTimeout(() => {
              if (document.fonts && document.fonts.ready) {
                document.fonts.ready.then(() => window.print());
              } else {
                window.print();
              }
            }, 400);
          }
          return;
        }

        if (
          data.scan.status === 'failed' ||
          data.scan.status === 'cancelled' ||
          data.scan.status === 'interrupted'
        ) {
          setError(
            data.scan.errorMessage ||
              'الفحص ده مكملش أو اتلغى. تقدر تبدأ فحص جديد للموقع في أي وقت.'
          );
          clearActiveScanSession();
          return;
        }
      }

      const localFallback = loadFullScanFromStorage(cleanId);
      if (localFallback) {
        setScanResult(localFallback);
        clearActiveScanSession();
        return;
      }

      setError(
        data?.error ||
          'انتهت صلاحية هذا التقرير وتمت إزالته من السجل'
      );
    } catch {
      setLoading(false);
      setLoadingReport(false);
      const localFallback = loadFullScanFromStorage(cleanId);
      if (localFallback) {
        setScanResult(localFallback);
        clearActiveScanSession();
        return;
      }
      setError('تعذر الاتصال بالسيرفر لتحميل التقرير. اتأكد من اتصالك بالإنترنت وحاول مرة تانية.');
    }
  }, []);

  // Support direct report link /report/:id or /report/:id/print AND G5.3 active scan restoration
  useEffect(() => {
    const handleRoute = () => {
      const path = window.location.pathname;
      if (path === '/privacy') {
        setShowPrivacyPage(true);
        setShowTermsPage(false);
        setShowReportsPage(false);
        return;
      }
      if (path === '/terms') {
        setShowTermsPage(true);
        setShowPrivacyPage(false);
        setShowReportsPage(false);
        return;
      }
      setShowPrivacyPage(false);
      setShowTermsPage(false);
      if (path === '/reports') {
        setShowReportsPage(true);
        return;
      }
      setShowReportsPage(false);
      const match = path.match(/^\/report\/([a-zA-Z0-9_-]{4,64})\/?(\/print)?\/?$/i);
      if (match) {
        const targetId = match[1];
        const isPrintRoute = Boolean(match[2]);
        loadStoredReportById(targetId, isPrintRoute);
        return;
      }

      if (path.startsWith('/report/')) {
        setError('معرّف الفحص في الرابط غير صحيح. اتأكد من الرابط أو ابدأ فحص جديد.');
        window.history.replaceState({}, '', '/');
        return;
      }

      // G6.2: Support shared read-only report /share/:token or /share/:token/print
      const shareMatch = path.match(/^\/share\/([a-zA-Z0-9_-]{4,64})\/?(\/print)?\/?$/i);
      if (shareMatch) {
        const token = shareMatch[1];
        const isPrintRoute = Boolean(shareMatch[2]);
        setLoading(true);
        setError(null);
        setScanResult(null);
        setActiveScanId(null);
        apiFetch(`/api/share/${token}`)
          .then(async r => {
            const contentType = r.headers.get('content-type') || '';
            const data = contentType.includes('application/json')
              ? await r.json().catch(() => null)
              : null;
            return { status: r.status, data };
          })
          .then(({ status, data }) => {
            setLoading(false);
            if (data && data.ok && data.report) {
              setScanResult(data.report);
              if (isPrintRoute) {
                setTimeout(() => {
                  if (document.fonts && document.fonts.ready) {
                    document.fonts.ready.then(() => window.print());
                  } else {
                    window.print();
                  }
                }, 400);
              }
              return;
            }

            if (window.location.pathname.startsWith('/share/')) {
              window.history.replaceState({}, '', '/');
            }

            if (status === 410) {
              if (data?.code === 'expired') {
                setError('انتهت صلاحية رابط المشاركة (الروابط صالحة لمدة 7 أيام فقط). اطلب من صاحب التقرير إنشاء رابط جديد.');
              } else if (data?.code === 'revoked') {
                setError('تم إلغاء رابط المشاركة ده من صاحب التقرير.');
              } else if (data?.code === 'deleted') {
                setError('التقرير ده اتمسح خلاص من قبل صاحبه.');
              } else {
                setError(data?.error || 'التقرير المشارك لم يعد متاحاً.');
              }
              return;
            }

            if (status === 404) {
              setError(data?.error || 'رابط المشاركة غير صحيح أو غير موجود. اتأكد من الرابط وحاول تاني.');
              return;
            }

            setError(data?.error || 'تعذر تحميل التقرير المشارك.');
          })
          .catch(() => {
            setLoading(false);
            setError('تعذر الاتصال بالسيرفر لتحميل التقرير المشارك.');
          });
        return;
      }

      // G5.3: Restore active in-flight scan from sessionStorage on refresh/navigation
      const savedSession = loadActiveScanSession();
      if (savedSession) {
        setActiveScanId(savedSession.scanId);
        setActiveScanUrl(savedSession.requestedUrl);
        setActiveScanStartedAt(savedSession.startedAt);
        setLoading(true);
      }
    };

    handleRoute();
    window.addEventListener('popstate', handleRoute);
    return () => window.removeEventListener('popstate', handleRoute);
  }, [loadStoredReportById]);

  const saveScanToHistory = useCallback((result: ScanResult) => {
    const updated = saveRecentScanSummaryToStorage(result);
    setRecentScans(updated);
  }, []);

  const clearHistory = () => {
    try {
      localStorage.removeItem(RECENT_SCANS_STORAGE_KEY);
      localStorage.removeItem(FULL_SCANS_STORAGE_KEY);
      setRecentScans([]);
    } catch {
      // ignore
    }
  };

  // G5.4: Exponential backoff polling without aborting server job on client timeout
  const pollScanOnce = useCallback(
    async (scanIdToPoll: string): Promise<'continue' | 'stop'> => {
      try {
        const res = await apiFetch(`/api/scans/${scanIdToPoll}`);
        const data = await res.json();
        if (!data.ok) {
          clearActiveScanSession();
          setError(data.error || 'فشل جلب حالة الفحص');
          setActiveScanId(null);
          setLoading(false);
          return 'stop';
        }

        const { scan } = data;
        setScanStage(scan.currentStage);
        setStageStates(scan.stageStates);
        setStageDetail(scan.stageDetail || '');
        setPagesCount(scan.inspectedPagesCount || 0);
        if (scan.requestedUrl) setActiveScanUrl(scan.requestedUrl);
        if (scan.startedAt) setActiveScanStartedAt(scan.startedAt);

        if (scan.status === 'completed' || scan.status === 'partial') {
          clearActiveScanSession();
          if (scan.result?.unchangedDeployment && lastOpenReportRef.current) {
            setUnchangedNoticeAr(
              scan.result.unchangedMessageAr ||
                'ما لقيتش تغيير في الموقع المنشور. غالبًا التعديلات ما اتنشرتش.'
            );
            setScanResult(lastOpenReportRef.current);
          } else {
            setUnchangedNoticeAr(
              scan.result?.unchangedDeployment
                ? scan.result.unchangedMessageAr ||
                    'ما لقيتش تغيير في الموقع المنشور. غالبًا التعديلات ما اتنشرتش.'
                : null
            );
            setScanResult(scan.result);
            if (scan.result && !scan.result.unchangedDeployment) {
              saveScanToHistory(scan.result);
            }
          }
          try {
            scanChannelRef.current?.postMessage({
              type: 'scan_completed',
              scanId: scanIdToPoll,
              result: scan.result
            });
          } catch {
            // ignore BroadcastChannel errors
          }
          setActiveScanId(null);
          setLoading(false);
          setPollSlowWarningAr(null);
          setAttachedScanBannerAr(null);
          fetchQuota();
          return 'stop';
        }

        if (
          scan.status === 'failed' ||
          scan.status === 'blocked' ||
          scan.status === 'cancelled' ||
          scan.status === 'interrupted'
        ) {
          clearActiveScanSession();
          const errMsg = scan.errorMessage || 'تعذر إكمال الفحص للموقع المطلوب.';
          setError(errMsg);
          try {
            scanChannelRef.current?.postMessage({
              type: 'scan_stopped',
              scanId: scanIdToPoll,
              errorMessage: errMsg
            });
          } catch {
            // ignore
          }
          setActiveScanId(null);
          setLoading(false);
          setPollSlowWarningAr(null);
          setAttachedScanBannerAr(null);
          fetchQuota();
          return 'stop';
        }

        try {
          scanChannelRef.current?.postMessage({
            type: 'scan_progress',
            scanId: scanIdToPoll,
            currentStage: scan.currentStage,
            stageStates: scan.stageStates,
            stageDetail: scan.stageDetail || '',
            inspectedPagesCount: scan.inspectedPagesCount || 0,
            requestedUrl: scan.requestedUrl,
            startedAt: scan.startedAt
          });
        } catch {
          // ignore
        }

        return 'continue';
      } catch {
        // Transient network hiccup on client: never abort server scan, keep polling with backoff
        return 'continue';
      }
    },
    [fetchQuota, saveScanToHistory]
  );

  // P2c.3: BroadcastChannel cross-tab attachment (active scan announcement + per-scanId channel)
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    let announceChannel: BroadcastChannel | null = null;
    try {
      announceChannel = new BroadcastChannel(ACTIVE_SCAN_ANNOUNCE_CHANNEL);
      announceChannel.onmessage = (ev: MessageEvent) => {
        const msg = ev?.data;
        if (!msg || typeof msg !== 'object') return;
        if (
          msg.type === 'scan_started' &&
          typeof msg.scanId === 'string' &&
          !activeScanId &&
          !scanResult
        ) {
          setActiveScanId(msg.scanId);
          setActiveScanUrl(msg.requestedUrl || '');
          setActiveScanStartedAt(msg.startedAt || new Date().toISOString());
          setAttachedScanBannerAr(ATTACHED_RUNNING_SCAN_MESSAGE_AR);
          setLoading(true);
        }
      };
    } catch {
      // ignore if BroadcastChannel unsupported
    }
    return () => {
      try {
        announceChannel?.close();
      } catch {
        // ignore
      }
    };
  }, [activeScanId, scanResult]);

  useEffect(() => {
    if (!activeScanId || typeof BroadcastChannel === 'undefined') {
      if (scanChannelRef.current) {
        try {
          scanChannelRef.current.close();
        } catch {
          // ignore
        }
        scanChannelRef.current = null;
      }
      return;
    }

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(getScanBroadcastChannelName(activeScanId));
      scanChannelRef.current = channel;
      channel.onmessage = (ev: MessageEvent) => {
        const msg = ev?.data;
        if (!msg || typeof msg !== 'object' || msg.scanId !== activeScanId) return;
        if (msg.type === 'scan_progress') {
          if (msg.currentStage) setScanStage(msg.currentStage);
          if (msg.stageStates) setStageStates(msg.stageStates);
          if (typeof msg.stageDetail === 'string') setStageDetail(msg.stageDetail);
          if (typeof msg.inspectedPagesCount === 'number') setPagesCount(msg.inspectedPagesCount);
          if (msg.requestedUrl) setActiveScanUrl(msg.requestedUrl);
          if (msg.startedAt) setActiveScanStartedAt(msg.startedAt);
        } else if (msg.type === 'scan_completed' && msg.result) {
          clearActiveScanSession();
          setScanResult(msg.result);
          saveScanToHistory(msg.result);
          setActiveScanId(null);
          setLoading(false);
          setPollSlowWarningAr(null);
          setAttachedScanBannerAr(null);
          fetchQuota();
        } else if (msg.type === 'scan_stopped') {
          clearActiveScanSession();
          setError(msg.errorMessage || 'تم إيقاف الفحص.');
          setActiveScanId(null);
          setLoading(false);
          setPollSlowWarningAr(null);
          setAttachedScanBannerAr(null);
          fetchQuota();
        }
      };
    } catch {
      // ignore
    }

    return () => {
      try {
        channel?.close();
      } catch {
        // ignore
      }
      if (scanChannelRef.current === channel) {
        scanChannelRef.current = null;
      }
    };
  }, [activeScanId, fetchQuota, saveScanToHistory]);

  useEffect(() => {
    if (!activeScanId) return;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    pollAttemptRef.current = 0;
    pollStartedAtMsRef.current = Date.now();
    setPollSlowWarningAr(null);

    const scheduleNext = () => {
      if (cancelled) return;
      const elapsedMs = Date.now() - pollStartedAtMsRef.current;
      if (elapsedMs > MAX_CLIENT_POLL_DURATION_MS) {
        // G5.4: Do NOT abort the server job on client poll timeout; show calm retry banner
        setPollSlowWarningAr(
          'الفحص على السيرفر بياخد وقت أطول من المعتاد بسبب سرعة الموقع. الفحص لسه شغال وماتلغاش — تقدر تحدث الحالة دلوقتي.'
        );
        return;
      }

      const delayMs = computePollBackoffMs(pollAttemptRef.current);
      timerId = setTimeout(async () => {
        if (cancelled) return;
        pollAttemptRef.current += 1;
        const outcome = await pollScanOnce(activeScanId);
        if (!cancelled && outcome === 'continue') {
          scheduleNext();
        }
      }, delayMs);
    };

    // Perform an immediate status check (e.g. when restoring from sessionStorage) then schedule backoff
    pollScanOnce(activeScanId).then(outcome => {
      if (!cancelled && outcome === 'continue') {
        scheduleNext();
      }
    });

    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [activeScanId, pollScanOnce]);

  const handleStartScan = async (params: {
    url: string;
    purpose?: string;
    keyJourney?: string;
    aiClaims?: string;
    options?: ScanOptionsConfig;
    isAuthorized: boolean;
    rescanMode?: 'same_pages' | 'remaining_pages';
    forceRescan?: boolean;
  }) => {
    if (startingScanRef.current) return;
    startingScanRef.current = true;
    const idempotencyKey = generateClientIdempotencyKey();

    if (scanResult) {
      lastOpenReportRef.current = scanResult;
    }
    setUnchangedNoticeAr(null);
    setError(null);
    setScanResult(null);
    setShowReportsPage(false);
    setPollSlowWarningAr(null);
    setAttachedScanBannerAr(null);
    setLoading(true);
    setLoadingReport(false);

    try {
      const res = await apiFetch('/api/scans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(params)
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setError(data.error || 'تعذر بدء الفحص حالياً');
        setLoading(false);
        fetchQuota();
        return;
      }

      const startedAtIso = new Date().toISOString();
      saveActiveScanSession({
        scanId: data.scanId,
        requestedUrl: params.url,
        startedAt: startedAtIso
      });

      if (data.reused) {
        setAttachedScanBannerAr(ATTACHED_RUNNING_SCAN_MESSAGE_AR);
      }

      if (typeof BroadcastChannel !== 'undefined') {
        try {
          const announce = new BroadcastChannel(ACTIVE_SCAN_ANNOUNCE_CHANNEL);
          announce.postMessage({
            type: 'scan_started',
            scanId: data.scanId,
            requestedUrl: params.url,
            startedAt: startedAtIso
          });
          announce.close();
        } catch {
          // ignore
        }
      }

      setActiveScanId(data.scanId);
      setActiveScanUrl(params.url);
      setActiveScanStartedAt(startedAtIso);
      setScanStage('url_check');
      setStageStates({
        url_check: 'started',
        discovery: 'pending',
        interaction: 'pending',
        lighthouse: 'pending',
        report: 'pending'
      });
      setStageDetail(
        data.reused ? ATTACHED_RUNNING_SCAN_MESSAGE_AR : 'التحقق من أمان الرابط وصلاحية النطاق'
      );
      setPagesCount(0);
    } catch {
      setError('حدث خطأ في الاتصال بالخادم. حاول مرة أخرى.');
      setLoading(false);
    } finally {
      startingScanRef.current = false;
    }
  };

  // G5.2: Cancel active scan via POST /api/scans/:id/cancel
  const handleCancelScan = async () => {
    if (!activeScanId || cancelling) return;
    const scanIdToCancel = activeScanId;
    setCancelling(true);
    try {
      const res = await apiFetch(`/api/scans/${scanIdToCancel}/cancel`, {
        method: 'POST'
      });
      const data = await res.json().catch(() => ({}));
      clearActiveScanSession();
      try {
        scanChannelRef.current?.postMessage({
          type: 'scan_stopped',
          scanId: scanIdToCancel,
          errorMessage: data?.scan?.errorMessage || 'تم إلغاء الفحص بناءً على طلبك.'
        });
      } catch {
        // ignore
      }
      setActiveScanId(null);
      setLoading(false);
      setPollSlowWarningAr(null);
      setAttachedScanBannerAr(null);
      if (data?.quota) {
        setDomainLock(data.quota);
      } else {
        fetchQuota();
      }
      setError(data?.scan?.errorMessage || 'تم إلغاء الفحص بناءً على طلبك.');
    } catch {
      clearActiveScanSession();
      setActiveScanId(null);
      setLoading(false);
      setAttachedScanBannerAr(null);
      setError('تم إيقاف متابعة الفحص.');
    } finally {
      setCancelling(false);
    }
  };

  const resetToHome = () => {
    clearActiveScanSession();
    setScanResult(null);
    setActiveScanId(null);
    setShowReportsPage(false);
    setShowPrivacyPage(false);
    setShowTermsPage(false);
    setError(null);
    setLoading(false);
    setLoadingReport(false);
    setPollSlowWarningAr(null);
    setAttachedScanBannerAr(null);
    if (window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/');
    }
  };

  const openReportsView = () => {
    setShowReportsPage(true);
    setShowPrivacyPage(false);
    setShowTermsPage(false);
    setError(null);
    if (window.location.pathname !== '/reports') {
      window.history.pushState({}, '', '/reports');
    }
  };

  const openPrivacyView = () => {
    setShowPrivacyPage(true);
    setShowTermsPage(false);
    setShowReportsPage(false);
    setError(null);
    if (window.location.pathname !== '/privacy') {
      window.history.pushState({}, '', '/privacy');
    }
  };

  const openTermsView = () => {
    setShowTermsPage(true);
    setShowPrivacyPage(false);
    setShowReportsPage(false);
    setError(null);
    if (window.location.pathname !== '/terms') {
      window.history.pushState({}, '', '/terms');
    }
  };

  const handleReportDeleted = (deletedId: string) => {
    try {
      removeFullScanFromStorage(deletedId);
      setRecentScans(prev => {
        const updated = prev.filter(s => s.scanId !== deletedId);
        localStorage.setItem(RECENT_SCANS_STORAGE_KEY, JSON.stringify(updated));
        return updated;
      });
    } catch {
      // ignore
    }
    resetToHome();
    fetchQuota();
  };

  const isLandingScreen =
    !loadingReport &&
    !activeScanId &&
    !scanResult &&
    !showReportsPage &&
    !showPrivacyPage &&
    !showTermsPage;

  const activeDockView: 'home' | 'scanning' | 'report' | 'reports' | 'privacy' | 'terms' =
    showPrivacyPage
      ? 'privacy'
      : showTermsPage
      ? 'terms'
      : showReportsPage
      ? 'reports'
      : activeScanId
      ? 'scanning'
      : scanResult
      ? 'report'
      : 'home';
  const isAnySheetOpen =
    heroSheetOpen || reportSheetOpen || chatSheetOpen || showRecentScans;

  return (
    <MadamAfafErrorBoundary onReset={resetToHome}>
      <div
        dir="rtl"
        className="min-h-screen bg-[var(--bg)] text-[var(--ink)] flex flex-col justify-between"
      >
        <div className={isLandingScreen ? 'hidden' : ''}>
          <Header
            domainLock={domainLock}
            recentScansCount={recentScans.length}
            onOpenRecentScans={openReportsView}
            onResetHome={resetToHome}
          />
        </div>

        <main className="flex-1 pb-24 sm:pb-24">
          {showReportsPage && (
            <div className="px-4 py-6">
              <ReportsPage
                onOpenReport={(scanId) => {
                  setShowReportsPage(false);
                  window.history.pushState({}, '', `/report/${scanId}`);
                  loadStoredReportById(scanId, false);
                }}
                onRescanDomain={(targetUrl) => {
                  setShowReportsPage(false);
                  handleStartScan({
                    url: targetUrl,
                    isAuthorized: true,
                  });
                }}
                onStartNewScan={resetToHome}
                onRunningCountChange={setServerRunningCount}
              />
            </div>
          )}

          {showPrivacyPage && (
            <PrivacyPage
              onBack={() => {
                window.history.pushState({}, '', '/');
                resetToHome();
              }}
            />
          )}

          {showTermsPage && (
            <TermsPage
              onBack={() => {
                window.history.pushState({}, '', '/');
                resetToHome();
              }}
            />
          )}

          {!showReportsPage && !showPrivacyPage && !showTermsPage && loadingReport && !activeScanId && !scanResult && (
            <div className="max-w-xl mx-auto px-4 py-12 text-center">
              <div className="ledger-card p-8 space-y-4">
                <div className="w-10 h-10 rounded-full bg-[var(--primary)] text-[var(--on-primary)] font-bold text-[18px] flex items-center justify-center mx-auto animate-pulse">
                  ع
                </div>
                <p className="text-[16px] font-bold text-[var(--ink)]">
                  جاري فتح التقرير من الدفتر...
                </p>
              </div>
            </div>
          )}

          {isLandingScreen && (
            <MadamAfafHero
              domainLock={domainLock}
              systemAvailable={systemAvailable}
              onStartScan={handleStartScan}
              onSheetOpenChange={setHeroSheetOpen}
              onOpenSampleReport={reportId => {
                setError(null);
                setActiveScanId(null);
                setScanResult(getMockDemoReport(reportId));
              }}
              loading={loading}
              error={error}
            />
          )}

          {!showReportsPage && !showPrivacyPage && !showTermsPage && activeScanId && (
            <ScanProgress
              stage={scanStage}
              stageStates={stageStates}
              detail={stageDetail}
              pagesCount={pagesCount}
              url={activeScanUrl}
              startedAt={activeScanStartedAt}
              onCancel={handleCancelScan}
              cancelling={cancelling}
              pollSlowWarningAr={pollSlowWarningAr}
              attachedMessageAr={attachedScanBannerAr}
              onRetryPoll={() => {
                pollStartedAtMsRef.current = Date.now();
                setPollSlowWarningAr(null);
                pollScanOnce(activeScanId);
              }}
            />
          )}

          {!showReportsPage && !showPrivacyPage && !showTermsPage && scanResult && (
            <ReportView
              result={scanResult}
              unchangedNoticeAr={unchangedNoticeAr}
              initialPrintMode={typeof window !== 'undefined' && window.location.pathname.endsWith('/print')}
              onNewScan={resetToHome}
              onSheetOpenChange={setReportSheetOpen}
              onRescanDomain={(targetUrl, rescanOpts) => {
                handleStartScan({
                  url: targetUrl,
                  isAuthorized: true,
                  rescanMode: rescanOpts?.rescanMode,
                  forceRescan: rescanOpts?.forceRescan
                });
              }}
              onReportDeleted={() => handleReportDeleted(scanResult.scanId)}
            />
          )}
        </main>

        {/* Footer with Developer Attribution & LinkedIn Contact (hidden on calm landing screen) */}
        <footer
          className={
            isLandingScreen
              ? 'hidden'
              : 'py-4 pb-28 sm:pb-24 text-center no-print space-y-2 border-t'
          }
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs font-bold">
            <a
              href="https://www.linkedin.com/in/mo7amadsultan/"
              target="_blank"
              rel="noopener noreferrer"
              data-testid="footer-linkedin-link"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border transition-colors hover:bg-[var(--surface-alt)]"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--primary)',
                color: 'var(--primary)',
                borderRadius: 'var(--r-sm)'
              }}
            >
              <span>تواصل مع المطور:</span>
              <span>
                <bdi dir="ltr" className="font-mono">LinkedIn</bdi> ({DEVELOPER_CONTACT.DEVELOPER_NAME_AR})
              </span>
            </a>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-bold pt-1">
            <span
              data-testid="app-footer-alpha-badge"
              className="px-2.5 py-1 rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-alt)] text-[var(--primary)] font-bold"
            >
              {RELEASE_CONFIG.badgeTextAr}
            </span>
            <button
              type="button"
              onClick={openPrivacyView}
              className="underline text-[var(--ink)] hover:text-[var(--primary)] cursor-pointer"
            >
              الخصوصية
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={openTermsView}
              className="underline text-[var(--ink)] hover:text-[var(--primary)] cursor-pointer"
            >
              الشروط
            </button>
          </div>
          <div className="text-xs text-[var(--ink-muted)]">
            التخزين الحالي: مؤقت (FileStore) · يوصى بتشغيل نسخة واحدة (Single Instance)
          </div>
          <div>
            <a
              href="https://www.linkedin.com/in/mo7amadsultan/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-medium text-[var(--ink-muted)] hover:text-[var(--primary)] transition-colors"
            >
              دفتر المراجعة — مدام عفاف · تطوير {DEVELOPER_CONTACT.DEVELOPER_NAME_AR}
            </a>
          </div>
        </footer>

        <MadamAfafFloatingWidget
          scanResult={scanResult}
          isScanning={Boolean(activeScanId)}
          onOpenChange={setChatSheetOpen}
          onTriggerScan={targetUrl => {
            handleStartScan({
              url: targetUrl,
              isAuthorized: true
            });
          }}
        />

        <MadamAfafDock
          activeView={activeDockView}
          hasOpenReport={Boolean(scanResult) && !showReportsPage && !showPrivacyPage && !showTermsPage}
          hasRunningScan={Boolean(activeScanId) || serverRunningCount > 0}
          isAnySheetOpen={isAnySheetOpen}
          moreSheetOpen={moreSheetOpen}
          onMoreSheetOpenChange={setMoreSheetOpen}
          onNewScan={resetToHome}
          onOpenReports={openReportsView}
          onOpenPrivacy={openPrivacyView}
          onOpenTerms={openTermsView}
          onCopyPrompt={() => {
            window.dispatchEvent(new CustomEvent('dock-copy-prompt'));
            setDockPromptCopied(true);
            setTimeout(() => setDockPromptCopied(false), 2000);
          }}
          onOpenChat={() => {
            window.dispatchEvent(new CustomEvent('open-madam-afaf-chat'));
          }}
          onPrintReport={() => {
            window.dispatchEvent(new CustomEvent('dock-print-report'));
          }}
          onExportJson={() => {
            window.dispatchEvent(new CustomEvent('dock-export-json'));
          }}
          onShareReport={() => {
            window.dispatchEvent(new CustomEvent('dock-share-report'));
          }}
          promptCopiedFeedback={dockPromptCopied}
        />

        {showRecentScans && (
          <RecentScansDrawer
            scans={recentScans}
            onSelectScan={summary => {
              setShowRecentScans(false);
              setActiveScanId(null);
              setError(null);
              loadStoredReportById(summary.scanId, false);
            }}
            onClearHistory={clearHistory}
            onClose={() => setShowRecentScans(false)}
          />
        )}
      </div>
    </MadamAfafErrorBoundary>
  );
}

export default App;
