import React, { useState, useEffect } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  Volume2,
  VolumeX,
  RotateCcw,
  ShieldAlert,
  HelpCircle,
  EyeOff,
  Layers,
  ListChecks,
  Printer,
  Download,
  Trash2,
  Code2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  History,
  Info,
  Share2,
  ExternalLink,
  MoreHorizontal,
  X,
  FileCode2,
  ShieldCheck
} from 'lucide-react';
import { Finding, ScanResult, TaxonomyCategory } from '../types/contract';
import {
  buildDeveloperMarkdownHandoff,
  buildRepairPrompts,
  estimatePromptTokens
} from '../lib/repair-prompt-builder';
import { getPlatformLabelAr } from '../lib/platform-adapter';
import {
  computeVerdict,
  evaluateAiClaims,
  formatArabicNoteCount,
  getNotMeasuredThreeLines
} from '../lib/honest-checks';
import { decodeUrlForDisplay } from '../lib/html-dom';
import {
  buildTextFragmentUrl,
  formatDate,
  formatNumber,
  hasRealVisibleText
} from '../lib/format';
import {
  HIGH_PROFILE_NOTICE_AR,
  isHighProfileDomain
} from '../config/limits';
import { computeFindingFingerprint } from '../lib/fingerprint';
import { speakMadamText, stopMadamSpeech } from '../lib/voice-client';
import { apiFetch } from '../lib/api-client';
import { DEVELOPER_CONTACT } from '../config/limits';
import { StatusDot } from './StatusDot';
import { getVerifiedAiBuilderById } from '../knowledge/ai-builders';
import { RELEASE_CONFIG } from '../config/release';

function formatDomainPathDisplay(rawUrl: string): string {
  const decoded = decodeUrlForDisplay(rawUrl);
  return decoded.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

interface ReportViewProps {
  result: ScanResult;
  onNewScan: () => void;
  onRescanDomain?: (
    url: string,
    options?: { rescanMode?: 'same_pages' | 'remaining_pages'; forceRescan?: boolean }
  ) => void;
  onReportDeleted?: (scanId: string) => void;
  onSheetOpenChange?: (open: boolean) => void;
  initialPrintMode?: boolean;
  unchangedNoticeAr?: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  security: 'فحوصات أمان أساسية (من الواجهة العامة)',
  accessibility: 'سهولة الوصول والفورم',
  seo: 'محركات البحث (SEO)',
  links: 'الروابط والتنقل',
  content: 'المحتوى والهوية واللغات',
  performance: 'السرعة وحجم الميديا',
  responsive: 'التجاوب والموبايل'
};

const SITE_TYPE_LABELS: Record<string, string> = {
  b2b_manufacturer: 'مصنع / شركة صناعية وتصدير',
  b2b_services: 'شركة خدمات وأعمال',
  ecommerce: 'متجر إلكتروني',
  portfolio: 'معرض أعمال',
  landing: 'صفحة هبوط',
  blog: 'مدونة / محتوى',
  corporate: 'موقع شركة تعريفي',
  unknown: 'غير محدد'
};

const CONVERSION_LABELS: Record<string, string> = {
  whatsapp: 'تواصل واتساب مباشر',
  phone: 'اتصال هاتفي',
  form: 'نموذج تواصل',
  cart: 'سلة شراء',
  none: 'غير واضح في الكود'
};

const METHOD_LABELS: Record<string, string> = {
  static_html: 'فحص كود HTML',
  http: 'فحص HTTP والشبكة',
  psi: 'قياس PageSpeed',
  rendered: 'متصفح حي',
  llm_judgment: 'ملاحظة لغوية'
};

const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: 'مؤكد بالدليل',
  likely: 'مرجّح',
  suspected: 'محتمل',
  unverified: 'غير متحقق'
};

export const ReportView: React.FC<ReportViewProps> = ({
  result,
  onNewScan,
  onRescanDomain,
  onReportDeleted,
  onSheetOpenChange,
  initialPrintMode = false,
  unchangedNoticeAr = null
}) => {
  // Progressive disclosure: Technical details & accordions collapsed by default
  const [showTechnicalDetails, setShowTechnicalDetails] = useState<boolean>(initialPrintMode);
  const [isPrintMode, setIsPrintMode] = useState<boolean>(initialPrintMode);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [expandedEvidenceIds, setExpandedEvidenceIds] = useState<Record<string, boolean>>({});
  const [copiedMaster, setCopiedMaster] = useState(false);
  const [copiedFindingId, setCopiedFindingId] = useState<string | null>(null);
  const [copiedEvidenceId, setCopiedEvidenceId] = useState<string | null>(null);
  const [isSpeakingReport, setIsSpeakingReport] = useState(false);
  const [feedbackState, setFeedbackState] = useState<Record<string, 'up' | 'down'>>({});
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [revokingShare, setRevokingShare] = useState(false);
  const [activeShareUrl, setActiveShareUrl] = useState<string | null>(null);
  const [shareToast, setShareToast] = useState<string | null>(null);
  const [findingsFilter, setFindingsFilter] = useState<'all' | 'confirmed' | 'needs_verification'>('all');
  const [allCategoriesExpanded, setAllCategoriesExpanded] = useState(false);
  const [showMoreActionsMenu, setShowMoreActionsMenu] = useState(false);
  const [showMasterPromptSheet, setShowMasterPromptSheet] = useState(false);
  const [masterSheetTab, setMasterSheetTab] = useState<'ai' | 'dev'>('ai');
  const [confirmedOnlyPrompt, setConfirmedOnlyPrompt] = useState(true);
  const [copiedDevMarkdown, setCopiedDevMarkdown] = useState(false);
  const [toolbarScrolledOut, setToolbarScrolledOut] = useState(false);
  const [copiedUrlKey, setCopiedUrlKey] = useState<string | null>(null);
  const [detailsTab, setDetailsTab] = useState<'confirmed' | 'needs_verification' | 'passed' | 'not_measured'>('confirmed');
  const [expandedDetailItemId, setExpandedDetailItemId] = useState<string | null>(null);
  const [publishChecked, setPublishChecked] = useState<boolean>(false);
  const [rescanMode, setRescanMode] = useState<'same_pages' | 'remaining_pages'>('same_pages');
  const [selectedToolOverride, setSelectedToolOverride] = useState<string>('');
  const [showLimitationsSheet, setShowLimitationsSheet] = useState<boolean>(false);
  const [findingDownReasons, setFindingDownReasons] = useState<Record<string, string>>({});
  const [ratingCardDismissed, setRatingCardDismissed] = useState<boolean>(() => {
    try {
      return Boolean(localStorage.getItem(`madam_rated_${result.scanId}`));
    } catch {
      return false;
    }
  });
  const [ratingCardVisible, setRatingCardVisible] = useState(false);
  const [ratingStars, setRatingStars] = useState<number>(0);
  const [selectedRatingReasons, setSelectedRatingReasons] = useState<string[]>([]);
  const [ratingComment, setRatingComment] = useState('');
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [ratingSubmitting, setRatingSubmitting] = useState(false);

  const triggerRatingCard = React.useCallback(() => {
    try {
      if (localStorage.getItem(`madam_rated_${result.scanId}`)) return;
    } catch {}
    setRatingCardVisible(true);
  }, [result.scanId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      triggerRatingCard();
    }, 45000);
    return () => clearTimeout(timer);
  }, [triggerRatingCard]);

  useEffect(() => {
    onSheetOpenChange?.(showMasterPromptSheet || showLimitationsSheet || showMoreActionsMenu);
  }, [showMasterPromptSheet, showLimitationsSheet, showMoreActionsMenu, onSheetOpenChange]);

  useEffect(() => {
    const onScroll = () => {
      setToolbarScrolledOut(window.scrollY > 200);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleCopyUrl = (urlToCopy: string, key: string) => {
    navigator.clipboard.writeText(urlToCopy);
    setCopiedUrlKey(key);
    setTimeout(() => setCopiedUrlKey(null), 2000);
  };

  const isHighProfile = Boolean(
    result.isHighProfileDomain ||
      isHighProfileDomain(result.registrableDomain || result.finalUrl || result.requestedUrl)
  );
  const highProfileNotice = result.highProfileNoticeAr || HIGH_PROFILE_NOTICE_AR;

  const isSectionOpen = (key: string) => isPrintMode || Boolean(openSections[key]);
  const toggleSection = (key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };
  const openAndScrollToSection = (key: string, elementId: string) => {
    setOpenSections(prev => ({ ...prev, [key]: true }));
    setTimeout(() => {
      document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };
  const jumpToFindingCard = (findingId: string) => {
    const targetFinding = (result.findings || []).find(f => f.id === findingId);
    const catKey = targetFinding ? `cat-${targetFinding.category}` : '';
    setOpenSections(prev => ({
      ...prev,
      findings: true,
      ...(catKey ? { [catKey]: true } : {})
    }));
    setTimeout(() => {
      document.getElementById(`finding-${findingId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  };

  // Interactive AI Claims evaluator if user didn't supply claims before scanning
  const [customAiClaims, setCustomAiClaims] = useState(result.aiClaimsText || '');
  const activeClaimsComparison =
    result.aiClaimsComparison && result.aiClaimsComparison.length > 0 && customAiClaims === (result.aiClaimsText || '')
      ? result.aiClaimsComparison
      : evaluateAiClaims({
          aiClaimsText: customAiClaims,
          findings: result.findings || [],
          passes: result.passes || [],
          notMeasured: result.notMeasured || []
        });

  useEffect(() => {
    return () => {
      stopMadamSpeech();
    };
  }, []);

  // Trigger print when entering print mode
  useEffect(() => {
    if (!isPrintMode) return;
    const prevTitle = document.title;
    const dateStr = new Date(result.startedAt || Date.now())
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
    const cleanDom = (result.registrableDomain || 'site').replace(/[^a-zA-Z0-9.-]/g, '-');
    document.title = `madam-afaf-${cleanDom}-${dateStr}`;

    const runPrint = async () => {
      try {
        if ((document as any).fonts?.ready) {
          await (document as any).fonts.ready;
        }
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          window.print();
        } catch {
          // ignore
        }
      }, 150);
    };

    runPrint();
    return () => {
      document.title = prevTitle;
    };
  }, [isPrintMode, result.registrableDomain, result.startedAt]);

  const allFindings = result.findings || [];
  // A3: RC002 is a question only in "محتاج قرار منك", not counted in findings or verdict
  const findings = allFindings.filter(f => f.ruleId !== 'RC002');
  const passes = result.passes || [];
  const notMeasured = result.notMeasured || [];
  const profile = result.siteProfile;
  const siteStatus = result.siteStatus;
  const isStatusReportOnly = Boolean(siteStatus && siteStatus.state !== 'ok');

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const mediumCount = findings.filter(f => f.severity === 'medium').length;
  const lowCount = findings.filter(f => f.severity === 'low' || f.severity === 'improvement').length;

  const topPriorities = findings.slice(0, 5);
  const humanDecisionItems = allFindings.filter(f => f.needsHumanDecision);

  const confirmedFindingsList = findings.filter(
    f => f.confidence === 'confirmed' || f.kind === 'confirmed_defect'
  );
  const needsVerificationFindingsList = findings.filter(
    f => f.confidence !== 'confirmed' && f.kind !== 'confirmed_defect'
  );

  const effectiveFindingsFilter = isPrintMode ? 'all' : findingsFilter;
  const filteredFindings =
    effectiveFindingsFilter === 'confirmed'
      ? confirmedFindingsList
      : effectiveFindingsFilter === 'needs_verification'
      ? needsVerificationFindingsList
      : findings;

  // Group findings by category
  const findingsByCategory = new Map<TaxonomyCategory, Finding[]>();
  for (const f of filteredFindings) {
    const cat = (f.category as TaxonomyCategory) || 'content';
    const arr = findingsByCategory.get(cat) || [];
    arr.push(f);
    findingsByCategory.set(cat, arr);
  }

  const confirmedCriticalOrHigh = findings.some(
    f => (f.severity === 'critical' || f.severity === 'high') && f.confidence === 'confirmed'
  );
  const confirmedMedium = findings.some(
    f => f.severity === 'medium' && f.confidence === 'confirmed'
  );

  // Verdict styling using locked CSS variables (Section 4 & Section 5)
  const verdictLevel =
    result.verdict?.level ||
    (isStatusReportOnly
      ? 'status_only'
      : confirmedCriticalOrHigh
      ? 'fix_before_handover'
      : confirmedMedium
      ? 'needs_work_before_launch'
      : 'ready_with_notes');

  const verdictTheme = {
    fix_before_handover: {
      bg: 'var(--sev-critical-bg)',
      fg: 'var(--sev-critical-fg)',
      label: result.verdict?.labelAr || 'فيه مشاكل لازم تتحل قبل الاستلام',
      icon: ShieldAlert
    },
    needs_work_before_launch: {
      bg: 'var(--sev-medium-bg)',
      fg: 'var(--sev-medium-fg)',
      label: result.verdict?.labelAr || 'محتاج شغل قبل الإطلاق',
      icon: AlertTriangle
    },
    ready_with_notes: {
      bg: 'var(--pass-bg)',
      fg: 'var(--pass-fg)',
      label: result.verdict?.labelAr || 'جاهز بملاحظات',
      icon: CheckCircle2
    },
    status_only: {
      bg: 'var(--sev-low-bg)',
      fg: 'var(--sev-low-fg)',
      label: result.verdict?.labelAr || 'تقرير حالة الموقع (لم يكتمل الفحص المعتاد)',
      icon: Info
    }
  }[verdictLevel];

  const VerdictIcon = verdictTheme.icon;

  const getSeverityBadgeStyle = (sev: Finding['severity']) => {
    switch (sev) {
      case 'critical':
        return {
          bg: 'var(--sev-critical-bg)',
          fg: 'var(--sev-critical-fg)',
          label: 'خطير',
          icon: '⛔'
        };
      case 'high':
        return {
          bg: 'var(--sev-high-bg)',
          fg: 'var(--sev-high-fg)',
          label: 'مهم جدًا',
          icon: '⚠️'
        };
      case 'medium':
        return {
          bg: 'var(--sev-medium-bg)',
          fg: 'var(--sev-medium-fg)',
          label: 'متوسط',
          icon: '◆'
        };
      default:
        return {
          bg: 'var(--sev-low-bg)',
          fg: 'var(--sev-low-fg)',
          label: 'تحسين بسيط',
          icon: 'ℹ️'
        };
    }
  };

  const handleToggleSpeech = () => {
    if (isSpeakingReport) {
      stopMadamSpeech();
      setIsSpeakingReport(false);
      return;
    }
    const textToSpeak =
      result.summaryAr ||
      `راجعت موقع ${result.registrableDomain} بالدليل. لقيت ${findings.length} ملاحظات و${passes.length} نقطة سليمة.`;
    speakMadamText(textToSpeak, {
      onStart: () => setIsSpeakingReport(true),
      onEnd: () => setIsSpeakingReport(false)
    });
  };

  const copyMasterPrompt = () => {
    if (!result.masterRepairPrompt) return;
    navigator.clipboard.writeText(result.masterRepairPrompt);
    setCopiedMaster(true);
    triggerRatingCard();
    setTimeout(() => setCopiedMaster(false), 2500);
  };

  const copyIndividualFix = (f: Finding) => {
    const text =
      result.individualRepairPrompts?.[f.id] ||
      `${f.titleAr || f.title}\nالرابط: ${f.url || result.finalUrl || result.requestedUrl}\nاللي شفته: ${f.observed}\nالحل: ${f.recommendedFix}`;
    navigator.clipboard.writeText(text);
    setCopiedFindingId(f.id);
    triggerRatingCard();
    setTimeout(() => setCopiedFindingId(null), 2000);
  };

  const copyEvidenceSnippet = (findingId: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedEvidenceId(findingId);
    setTimeout(() => setCopiedEvidenceId(null), 2000);
  };

  const handleVoteFeedback = async (f: Finding, vote: 'up' | 'down', reason?: string) => {
    setFeedbackState(prev => ({ ...prev, [f.id]: vote }));
    if (reason) {
      setFindingDownReasons(prev => ({ ...prev, [f.id]: reason }));
    }
    const fingerprint = computeFindingFingerprint(f);
    try {
      await apiFetch('/api/feedback/finding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scanId: result.scanId,
          findingId: f.id,
          ruleId: f.ruleId,
          rulesetVersion: result.rulesetVersion || '2.0.0',
          vote,
          reasons: reason ? [reason] : undefined,
          fingerprint,
          domain: result.registrableDomain
        })
      });
    } catch {
      // keep optimistic UI state
    }
  };

  const handleExportJson = () => {
    const exportPayload: ScanResult = {
      ...result,
      ...(isHighProfile
        ? {
            isHighProfileDomain: true,
            highProfileNoticeAr: highProfileNotice
          }
        : {})
    };
    const jsonString = JSON.stringify(exportPayload, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date(result.startedAt || Date.now()).toISOString().slice(0, 10);
    a.href = url;
    a.download = `madam-afaf-${result.registrableDomain || 'report'}-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    triggerRatingCard();
  };

  const handleDeleteReport = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/scans/${result.scanId}`, { method: 'DELETE' });
    } catch {
      // ignore
    } finally {
      setDeleting(false);
      if (onReportDeleted) {
        onReportDeleted(result.scanId);
      } else {
        onNewScan();
      }
    }
  };

  const handleShareReport = async () => {
    if (sharing || result.isMockFallback) return;
    setSharing(true);
    try {
      const res = await apiFetch(`/api/scans/${result.scanId}/share`, {
        method: 'POST'
      });
      const data = await res.json();
      if (data.ok && data.shareUrl) {
        const fullUrl = `${window.location.origin}${data.shareUrl}`;
        setActiveShareUrl(fullUrl);
        await navigator.clipboard.writeText(fullUrl);
        setShareToast('تم نسخ رابط المشاركة (صالح لمدة 7 أيام)');
        triggerRatingCard();
        setTimeout(() => setShareToast(null), 3500);
      } else {
        setShareToast(data.error || 'تعذر إنشاء رابط المشاركة.');
        setTimeout(() => setShareToast(null), 3500);
      }
    } catch {
      setShareToast('حدث خطأ في الاتصال.');
      setTimeout(() => setShareToast(null), 3500);
    } finally {
      setSharing(false);
    }
  };

  const handleRevokeShareReport = async () => {
    if (revokingShare || result.isMockFallback) return;
    setRevokingShare(true);
    try {
      const res = await apiFetch(`/api/scans/${result.scanId}/share`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.ok) {
        setActiveShareUrl(null);
        setShareToast('تم إلغاء رابط المشاركة بنجاح — لم يعد متاحاً للوصول.');
        setTimeout(() => setShareToast(null), 3500);
      } else {
        setShareToast(data.error || 'تعذر إلغاء رابط المشاركة.');
        setTimeout(() => setShareToast(null), 3500);
      }
    } catch {
      setShareToast('حدث خطأ أثناء إلغاء رابط المشاركة.');
      setTimeout(() => setShareToast(null), 3500);
    } finally {
      setRevokingShare(false);
    }
  };

  const handleToggleExpandAllFindings = () => {
    const nextExpanded = !allCategoriesExpanded;
    setAllCategoriesExpanded(nextExpanded);
    setShowTechnicalDetails(nextExpanded);
    setOpenSections(prev => {
      const next: Record<string, boolean> = { ...prev, findings: nextExpanded };
      for (const f of findings) {
        next[`cat-${f.category}`] = nextExpanded;
      }
      return next;
    });
  };

  const toggleEvidenceExpanded = (findingId: string) => {
    setExpandedEvidenceIds(prev => ({
      ...prev,
      [findingId]: !prev[findingId]
    }));
  };

  const effectiveToolOverride =
    selectedToolOverride && selectedToolOverride !== 'مش عارف'
      ? selectedToolOverride
      : undefined;

  const builtPrompts = buildRepairPrompts({
    requestedUrl: result.requestedUrl,
    finalUrl: result.finalUrl,
    scanId: result.scanId,
    startedAt: result.startedAt,
    siteProfile: result.siteProfile,
    verdict: result.verdict,
    findings,
    toolOverride: effectiveToolOverride
  });

  const activeAiMasterPrompt = effectiveToolOverride
    ? confirmedOnlyPrompt
      ? builtPrompts.confirmedOnlyMasterPrompt
      : builtPrompts.masterPrompt
    : confirmedOnlyPrompt
    ? result.confirmedOnlyMasterRepairPrompt || builtPrompts.confirmedOnlyMasterPrompt
    : result.masterRepairPrompt || builtPrompts.masterPrompt;

  const activeDeveloperMarkdown = confirmedOnlyPrompt
    ? result.confirmedOnlyDeveloperMarkdownHandoff ||
      buildDeveloperMarkdownHandoff(
        {
          requestedUrl: result.requestedUrl,
          finalUrl: result.finalUrl,
          scanId: result.scanId,
          startedAt: result.startedAt,
          siteProfile: result.siteProfile,
          verdict: result.verdict,
          findings
        },
        { confirmedOnly: true }
      )
    : result.developerMarkdownHandoff || builtPrompts.developerMarkdownHandoff;

  const masterTokens = estimatePromptTokens(activeAiMasterPrompt || '');

  const computedVerdictFallback = computeVerdict({
    findings,
    passes,
    notMeasured,
    profile
  });
  const verdictDrivers =
    result.verdict?.drivers && result.verdict.drivers.length > 0
      ? result.verdict.drivers
      : computedVerdictFallback.drivers || [];

  const handleCopyActiveAiPrompt = () => {
    if (!activeAiMasterPrompt) return;
    navigator.clipboard.writeText(activeAiMasterPrompt);
    setCopiedMaster(true);
    setTimeout(() => setCopiedMaster(false), 2500);
  };

  const handleCopyDeveloperMarkdown = () => {
    if (!activeDeveloperMarkdown) return;
    navigator.clipboard.writeText(activeDeveloperMarkdown);
    setCopiedDevMarkdown(true);
    setTimeout(() => setCopiedDevMarkdown(false), 2500);
  };

  const handleDownloadDeveloperMarkdown = () => {
    if (!activeDeveloperMarkdown) return;
    const blob = new Blob([activeDeveloperMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date(result.startedAt || Date.now()).toISOString().slice(0, 10);
    a.href = url;
    a.download = `madam-afaf-${result.registrableDomain || 'handoff'}-${dateStr}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const verifiedBuilder = getVerifiedAiBuilderById(profile?.builder);
  const showToolChipSelector =
    !verifiedBuilder &&
    (!profile?.platform ||
      profile.platform === 'unknown' ||
      profile.platform === 'spa' ||
      profile.platform === 'custom') &&
    findings.length > 0;
  const promptToolTargetLabel = verifiedBuilder
    ? verifiedBuilder.nameAr
    : effectiveToolOverride || 'الـ AI';
  const reviewNumber = result.reviewNumber || 1;
  const topThreePriorities = findings.slice(0, 3);
  const pagesSampleCount = Math.max(
    1,
    result.uniquePagesInspected || (Array.isArray(result.pages) ? result.pages.length : 1)
  );
  const activeUnchangedNotice =
    unchangedNoticeAr ||
    (result.unchangedDeployment
      ? result.unchangedMessageAr ||
        'ما لقيتش تغيير في الموقع المنشور. غالبًا التعديلات ما اتنشرتش.'
      : null);
  const remainingDiscoveredCount = Array.isArray(result.discoveredNotScanned)
    ? result.discoveredNotScanned.length
    : 0;

  useEffect(() => {
    const onDockPrint = () => {
      setShowTechnicalDetails(true);
      setIsPrintMode(true);
    };
    const onDockExport = () => {
      handleExportJson();
    };
    const onDockShare = () => {
      handleShareReport();
    };
    const onDockCopyPrompt = () => {
      handleCopyActiveAiPrompt();
    };
    window.addEventListener('dock-print-report', onDockPrint);
    window.addEventListener('dock-export-json', onDockExport);
    window.addEventListener('dock-share-report', onDockShare);
    window.addEventListener('dock-copy-prompt', onDockCopyPrompt);
    return () => {
      window.removeEventListener('dock-print-report', onDockPrint);
      window.removeEventListener('dock-export-json', onDockExport);
      window.removeEventListener('dock-share-report', onDockShare);
      window.removeEventListener('dock-copy-prompt', onDockCopyPrompt);
    };
  }, [activeAiMasterPrompt, result]);

  return (
    <div className="max-w-[840px] mx-auto px-4 pt-5 sm:pt-8 pb-28">
      {result.isMockFallback && (
        <div
          role="status"
          data-testid="mock-demo-banner"
          className="p-4 mb-4 border-2 text-xs sm:text-sm font-bold flex flex-wrap items-center justify-between gap-3 avoid-break"
          style={{
            backgroundColor: 'var(--sev-medium-bg)',
            borderColor: 'var(--sev-medium-fg)',
            color: 'var(--sev-medium-fg)',
            borderRadius: 'var(--r-md)'
          }}
        >
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <span className="block">
                عينة توضيحية (MOCK) — ده نموذج استرشادي لعرض شكل الدفتر والأدلة، ومش فحص حقيقي لموقعك ومش بيسحب من حصتك.
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onNewScan}
            className="no-print min-h-[40px] px-3.5 py-1.5 border text-xs font-bold cursor-pointer shrink-0"
            style={{
              backgroundColor: 'var(--primary)',
              borderColor: 'var(--primary)',
              color: 'var(--on-primary)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            افحص موقعك الحقيقي الآن
          </button>
        </div>
      )}

      {isHighProfile && (
        <div
          role="status"
          data-testid="high-profile-domain-banner"
          className="p-3.5 mb-4 border text-xs sm:text-sm font-bold flex items-start gap-2.5 avoid-break"
          style={{
            backgroundColor: 'var(--sev-medium-bg)',
            borderColor: 'var(--sev-medium-fg)',
            color: 'var(--sev-medium-fg)',
            borderRadius: 'var(--r-md)'
          }}
        >
          <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{highProfileNotice}</span>
        </div>
      )}

      {result.isSharedView && (
        <div
          role="status"
          className="no-print p-3.5 mb-4 border text-xs sm:text-sm font-bold flex items-center justify-between gap-3"
          style={{
            backgroundColor: 'var(--surface-alt)',
            borderColor: 'var(--primary)',
            color: 'var(--primary)',
            borderRadius: 'var(--r-md)'
          }}
        >
          <div className="flex items-center gap-2">
            <Info className="w-4 h-4 shrink-0" />
            <span>نسخة مشاركة للقراءة فقط — الرابط صالح لمدة 7 أيام.</span>
          </div>
          <span className="text-xs font-mono font-normal" style={{ color: 'var(--ink-muted)' }}>
            noindex
          </span>
        </div>
      )}

      {/* =====================================================================
          B2.6 CALM SINGLE-COLUMN REPORT SCREEN (max ~840px, NO side panels, NOT ten accordions)
      ===================================================================== */}
      {!isPrintMode && (
        <div className="no-print space-y-5 mb-8" data-testid="b2-calm-report-view">
          {shareToast && (
            <div
              role="status"
              className="p-3.5 rounded-[var(--r-md)] border border-[var(--primary)] bg-[var(--surface-alt)] text-[var(--ink)] text-[14px] font-bold flex items-center justify-between gap-2"
            >
              <span>{shareToast}</span>
              {activeShareUrl && (
                <button
                  type="button"
                  data-testid="revoke-share-btn"
                  onClick={handleRevokeShareReport}
                  className="px-3 py-1 rounded-[var(--r-sm)] border border-[var(--sev-critical-fg)] bg-[var(--sev-critical-bg)] text-[var(--sev-critical-fg)] text-[12px] font-bold"
                >
                  إلغاء الرابط
                </button>
              )}
            </div>
          )}

          {/* (1) Header line: domain · "مراجعة رقم N" · status dot · date */}
          <header
            aria-label="ملخص المراجعة"
            data-testid="b2-report-header-line"
            className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-md)] p-4 shadow-[var(--sh-1)] flex flex-wrap items-center justify-between gap-2 text-[14px]"
          >
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <bdi dir="ltr" className="font-mono font-bold text-[16px] text-[var(--primary)] truncate">
                {result.registrableDomain || formatDomainPathDisplay(result.finalUrl || result.requestedUrl)}
              </bdi>
              <span className="text-[var(--ink-muted)]" aria-hidden="true">·</span>
              <span className="font-bold text-[var(--ink)]">
                مراجعة رقم <bdi dir="ltr">{formatNumber(reviewNumber)}</bdi>
              </span>
              <span className="text-[var(--ink-muted)]" aria-hidden="true">·</span>
              <StatusDot status={result.status} compact />
            </div>
            <span className="text-[12px] text-[var(--ink-muted)]">
              {formatDate(result.startedAt)}
            </span>
          </header>

          {/* B3.4: Comparison block at the top of every re-scan report, shown even when user did not ask */}
          {result.rescanComparison && (
            <section
              aria-label="مقارنة إعادة الفحص"
              data-testid="b3-rescan-comparison-block"
              className="bg-[var(--surface)] border border-[var(--primary)] rounded-[var(--r-lg)] p-4 sm:p-5 shadow-[var(--sh-1)] space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[16px] font-bold text-[var(--ink)]">
                  <History className="w-5 h-5 text-[var(--primary)] shrink-0" aria-hidden="true" />
                  <span>مقارنة بالمراجعة السابقة</span>
                </div>
                <span
                  data-testid="b3-rescan-counts-pill"
                  className="px-3 py-1 rounded-[var(--r-sm)] bg-[var(--surface-alt)] border border-[var(--border)] text-[13px] font-bold text-[var(--ink)]"
                >
                  اتحل ✔ <bdi dir="ltr">{formatNumber(result.rescanComparison.resolvedRuleIds.length)}</bdi>{' '}
                  / لسه <bdi dir="ltr">{formatNumber(result.rescanComparison.stillOpenRuleIds.length)}</bdi>{' '}
                  / جديد <bdi dir="ltr">{formatNumber(result.rescanComparison.newRuleIds.length)}</bdi>
                </span>
              </div>

              {(result.rescanComparison.resolvedConfirmedCount ??
                result.rescanComparison.resolvedRuleIds.length) > 0 && (
                <p
                  data-testid="b3-resolved-confirmed-line"
                  className="p-3 rounded-[var(--r-md)] bg-[var(--pass-bg)] border border-[var(--pass-fg)] text-[var(--pass-fg)] text-[14px] font-bold"
                >
                  ✔ التعديلات اللي طلبتها اتنفذت:{' '}
                  <bdi dir="ltr">
                    {formatNumber(
                      result.rescanComparison.resolvedConfirmedCount ??
                        result.rescanComparison.resolvedRuleIds.length
                    )}
                  </bdi>{' '}
                  ملاحظة اتحلت
                </p>
              )}

              {result.rescanComparison.allConfirmedResolved && (
                <p
                  data-testid="b3-all-confirmed-resolved-line"
                  className="p-3 rounded-[var(--r-md)] bg-[var(--pass-bg)] border border-[var(--pass-fg)] text-[var(--pass-fg)] text-[14px] font-bold"
                >
                  كل المشاكل المؤكدة اتحلت في العينة دي
                </p>
              )}

              {Array.isArray(result.rescanComparison.metricDeltas) &&
                result.rescanComparison.metricDeltas.length > 0 && (
                  <div className="overflow-x-auto pt-1">
                    <table
                      data-testid="b3-rescan-metrics-table"
                      className="w-full text-start border-collapse text-[13px]"
                    >
                      <thead>
                        <tr className="border-b border-[var(--border)] text-[var(--ink-muted)]">
                          <th className="py-1.5 pe-2 font-bold text-start">المقياس</th>
                          <th className="py-1.5 px-2 font-bold text-start">قبل → بعد</th>
                          <th className="py-1.5 px-2 font-bold text-start">الفرق</th>
                          <th className="py-1.5 ps-2 font-bold text-start">الحالة</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.rescanComparison.metricDeltas.map((m, idx) => (
                          <tr key={`${m.metric}-${idx}`} className="border-b border-[var(--border)] last:border-0">
                            <td className="py-2 pe-2 font-mono font-bold text-[var(--ink)]">
                              <bdi dir="ltr">{m.metric}</bdi>{' '}
                              <span className="px-1.5 py-0.5 rounded-[var(--r-sm)] bg-[var(--surface-alt)] border border-[var(--border)] text-[12px] font-mono text-[var(--ink-muted)]">
                                <bdi dir="ltr">{m.note || 'lab'}</bdi>
                              </span>
                            </td>
                            <td className="py-2 px-2 font-mono text-[var(--ink)]">
                              <bdi dir="ltr">
                                {m.before}
                                {m.unit ? ` ${m.unit}` : ''} → {m.after}
                                {m.unit ? ` ${m.unit}` : ''}
                              </bdi>
                            </td>
                            <td className="py-2 px-2 font-mono text-[var(--ink-muted)]">
                              <bdi dir="ltr">{m.deltaText || '0'}</bdi>
                            </td>
                            <td className="py-2 ps-2 font-bold">
                              <span
                                className={`px-2 py-0.5 rounded-[var(--r-sm)] text-[12px] ${
                                  m.statusAr === 'تحسّن'
                                    ? 'bg-[var(--pass-bg)] text-[var(--pass-fg)]'
                                    : m.statusAr === 'اتراجع'
                                    ? 'bg-[var(--sev-critical-bg)] text-[var(--sev-critical-fg)]'
                                    : 'bg-[var(--surface-alt)] text-[var(--ink-muted)]'
                                }`}
                              >
                                {m.statusAr}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>
          )}

          {/* (2) Verdict sentence + three small counters (مؤكدة / محتاجة تحقق / ما اتقاستش) + "من عينة N صفحات" */}
          <section
            aria-label="الخلاصة"
            data-testid="b2-verdict-card"
            className="verdict-stamp p-5 sm:p-6 space-y-4"
            style={{
              backgroundColor: verdictTheme.bg,
              borderColor: verdictTheme.fg,
              color: verdictTheme.fg,
              borderRadius: 'var(--r-lg)',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <VerdictIcon className="w-6 h-6 shrink-0" aria-hidden="true" />
                <h1 className="text-[20px] sm:text-[24px] font-bold leading-[1.35]">
                  {result.verdict?.headlineAr || verdictTheme.label}
                </h1>
              </div>
              <span className="px-2.5 py-1 rounded-[var(--r-sm)] bg-[var(--surface)]/90 border border-[var(--border)] text-[var(--ink)] text-[12px] font-bold">
                من عينة <bdi dir="ltr">{formatNumber(pagesSampleCount)}</bdi> صفحات
              </span>
            </div>

            {result.verdict?.summaryLinesAr?.[0] && (
              <p className="text-[14px] sm:text-[16px] text-[var(--ink)] font-medium leading-[1.7] line-clamp-2">
                {result.verdict.summaryLinesAr[0]}
              </p>
            )}

            {/* Three small counters */}
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="bg-[var(--surface)]/95 border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-center">
                <span className="block text-[18px] font-bold font-mono text-[var(--ink)]">
                  <bdi dir="ltr">{formatNumber(confirmedFindingsList.length)}</bdi>
                </span>
                <span className="block text-[12px] font-bold text-[var(--ink-muted)]">مؤكدة</span>
              </div>
              <div className="bg-[var(--surface)]/95 border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-center">
                <span className="block text-[18px] font-bold font-mono text-[var(--ink)]">
                  <bdi dir="ltr">{formatNumber(needsVerificationFindingsList.length)}</bdi>
                </span>
                <span className="block text-[12px] font-bold text-[var(--ink-muted)]">محتاجة تحقق</span>
              </div>
              <div className="bg-[var(--surface)]/95 border border-[var(--border)] rounded-[var(--r-md)] p-2.5 text-center">
                <span className="block text-[18px] font-bold font-mono text-[var(--ink)]">
                  <bdi dir="ltr">{formatNumber(notMeasured.length)}</bdi>
                </span>
                <span className="block text-[12px] font-bold text-[var(--ink-muted)]">ما اتقاستش</span>
              </div>
            </div>
          </section>

          {/* (3) "أهم حاجات تصلحها": at most 3 cards (title, one "ليه ده يهمك؟" line, location) */}
          {topThreePriorities.length > 0 && (
            <section
              aria-label="أهم حاجات تصلحها"
              data-testid="b2-top-priorities"
              className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] p-5 shadow-[var(--sh-1)] space-y-3"
            >
              <h2 className="text-[18px] font-bold text-[var(--ink)]">أهم حاجات تصلحها</h2>
              <div className="space-y-2.5">
                {topThreePriorities.map((f) => {
                  const sevStyle = getSeverityBadgeStyle(f.severity);
                  const whyLine =
                    f.whyItMattersAr || f.explanationAr || f.observed || '';
                  const locText =
                    f.where?.sectionAr ||
                    f.location ||
                    formatDomainPathDisplay(f.url || result.finalUrl || result.requestedUrl);
                  return (
                    <div
                      key={f.id}
                      className="finding-card p-3.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg)] space-y-1.5"
                      style={{ borderInlineStartColor: sevStyle.fg }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-[16px] font-bold text-[var(--ink)]">
                          {f.titleAr || f.title}
                        </h3>
                        <span
                          className="px-2 py-0.5 rounded-[var(--r-sm)] text-[12px] font-bold shrink-0 inline-flex items-center gap-1"
                          style={{ backgroundColor: sevStyle.bg, color: sevStyle.fg }}
                        >
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                          <span>{sevStyle.label}</span>
                        </span>
                      </div>
                      {whyLine && (
                        <p className="text-[14px] text-[var(--ink-muted)] line-clamp-2">
                          <span className="font-bold text-[var(--ink)]">ليه ده يهمك؟ </span>
                          {whyLine}
                        </p>
                      )}
                      <div className="text-[12px] text-[var(--ink-muted)]">
                        المكان:{' '}
                        {/[\u0600-\u06FF]/.test(locText) ? (
                          <span className="font-bold text-[var(--primary)]">{locText}</span>
                        ) : (
                          <bdi dir="ltr" className="font-mono text-[var(--primary)]">
                            {locText}
                          </bdi>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* (4) ONE primary button "انسخ البرومبت للـ {tool or الـ AI}" and a secondary "تقرير للمطور" + B3.5 optional tool chip row */}
          <div className="space-y-2.5" data-testid="b2-primary-actions">
            {showToolChipSelector && (
              <div
                data-testid="b3-tool-chip-row"
                className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-md)] p-3 space-y-2"
              >
                <span className="block text-[13px] font-bold text-[var(--ink-muted)]">
                  اتبنى بإيه؟
                </span>
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="اتبنى بإيه؟">
                  {[
                    'Lovable',
                    'Replit',
                    'Base44',
                    'Bolt',
                    'v0',
                    'Emergent',
                    'AI Studio',
                    'مطور أو شركة',
                    'مش عارف'
                  ].map((toolLabel) => {
                    const isSelected = selectedToolOverride === toolLabel;
                    return (
                      <button
                        key={toolLabel}
                        type="button"
                        aria-pressed={isSelected}
                        data-testid={`b3-tool-chip-${toolLabel}`}
                        onClick={() =>
                          setSelectedToolOverride(isSelected ? '' : toolLabel)
                        }
                        className={`min-h-[36px] px-3 py-1 rounded-[var(--r-sm)] border text-[12px] font-bold cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[var(--primary)] border-[var(--primary)] text-[var(--on-primary)]'
                            : 'bg-[var(--bg)] border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-alt)]'
                        }`}
                      >
                        <bdi dir="auto">{toolLabel}</bdi>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-stretch gap-2.5">
              <button
                type="button"
                onClick={handleCopyActiveAiPrompt}
                data-testid="b2-copy-prompt-btn"
                className="flex-1 min-h-[48px] px-5 py-3 rounded-[var(--r-md)] bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-[var(--on-primary)] text-[16px] font-bold shadow-[var(--sh-1)] inline-flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                {copiedMaster ? <Check className="w-5 h-5 shrink-0" /> : <Copy className="w-5 h-5 shrink-0" />}
                <span>
                  {copiedMaster
                    ? 'اتنسخ البرومبت ✓'
                    : `انسخ البرومبت للـ ${promptToolTargetLabel}`}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMasterSheetTab('dev');
                  setShowMasterPromptSheet(true);
                }}
                data-testid="b2-developer-report-btn"
                className="min-h-[48px] px-5 py-3 rounded-[var(--r-md)] border border-[var(--border-strong)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] text-[var(--ink)] text-[16px] font-bold inline-flex items-center justify-center gap-2 cursor-pointer transition-colors"
              >
                <FileCode2 className="w-5 h-5 text-[var(--primary)] shrink-0" />
                <span>تقرير للمطور</span>
              </button>
            </div>
          </div>

          {/* (5) "بعد ما تصلّح" card with re-scan mode, publish checkbox, early-stop notice, and "أعد الفحص" */}
          <section
            aria-label="بعد ما تصلّح"
            data-testid="b2-after-fix-card"
            className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] p-5 shadow-[var(--sh-1)] space-y-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[16px] font-bold text-[var(--ink)]">بعد ما تصلّح</h2>
              {/* B3.1: Segmented choice for re-scan mode */}
              <div
                role="radiogroup"
                aria-label="نطاق إعادة الفحص"
                data-testid="b3-rescan-mode-group"
                className="inline-flex flex-wrap items-center gap-1.5 bg-[var(--bg)] p-1 rounded-[var(--r-md)] border border-[var(--border)]"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={rescanMode === 'same_pages'}
                  data-testid="b3-mode-same-pages"
                  onClick={() => setRescanMode('same_pages')}
                  className={`min-h-[36px] px-3 py-1 rounded-[var(--r-sm)] text-[12px] font-bold cursor-pointer transition-colors ${
                    rescanMode === 'same_pages'
                      ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                      : 'text-[var(--ink)] hover:bg-[var(--surface-alt)]'
                  }`}
                >
                  نفس الصفحات تاني (للتأكد من الإصلاح)
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={rescanMode === 'remaining_pages'}
                  data-testid="b3-mode-remaining-pages"
                  onClick={() => setRescanMode('remaining_pages')}
                  className={`min-h-[36px] px-3 py-1 rounded-[var(--r-sm)] text-[12px] font-bold cursor-pointer transition-colors ${
                    rescanMode === 'remaining_pages'
                      ? 'bg-[var(--primary)] text-[var(--on-primary)]'
                      : 'text-[var(--ink)] hover:bg-[var(--surface-alt)]'
                  }`}
                >
                  باقي الصفحات
                  {remainingDiscoveredCount > 0 ? (
                    <span className="ms-1 font-mono">
                      (<bdi dir="ltr">{formatNumber(remainingDiscoveredCount)}</bdi>)
                    </span>
                  ) : null}
                </button>
              </div>
            </div>

            {activeUnchangedNotice && (
              <div
                role="status"
                data-testid="b3-unchanged-deployment-notice"
                className="p-3.5 rounded-[var(--r-md)] bg-[var(--sev-medium-bg)] border border-[var(--sev-medium-fg)] text-[var(--sev-medium-fg)] text-[13px] font-bold flex flex-wrap items-center justify-between gap-2.5"
              >
                <span>{activeUnchangedNotice}</span>
                <button
                  type="button"
                  data-testid="b3-force-rescan-btn"
                  onClick={() =>
                    onRescanDomain
                      ? onRescanDomain(result.finalUrl || result.requestedUrl, {
                          rescanMode,
                          forceRescan: true
                        })
                      : onNewScan()
                  }
                  className="min-h-[38px] px-3.5 py-1.5 rounded-[var(--r-sm)] bg-[var(--surface)] border border-[var(--sev-medium-fg)] text-[var(--sev-medium-fg)] text-[12px] font-bold cursor-pointer shrink-0"
                >
                  افحص على أي حال
                </button>
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <label className="min-h-[44px] inline-flex items-center gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={publishChecked}
                  onChange={(e) => setPublishChecked(e.target.checked)}
                  data-testid="b2-publish-checkbox"
                  className="w-4 h-4 accent-[var(--primary)] shrink-0"
                />
                <div className="text-[14px]">
                  <span className="font-bold text-[var(--ink)] block">
                    نشرت التعديلات من الأداة؟
                  </span>
                  <span className="text-[12px] text-[var(--ink-muted)] block">
                    {verifiedBuilder?.publishHintAr ||
                      'اتأكد إنك ضغطت Publish/Deploy في الأداة اللي بنيت بيها'}
                  </span>
                </div>
              </label>

              <button
                type="button"
                onClick={() =>
                  onRescanDomain
                    ? onRescanDomain(result.finalUrl || result.requestedUrl, {
                        rescanMode,
                        forceRescan: false
                      })
                    : onNewScan()
                }
                data-testid="b2-rescan-btn"
                className="min-h-[44px] px-5 py-2.5 rounded-[var(--r-md)] border border-[var(--primary)] bg-[var(--surface-alt)] hover:bg-[var(--primary)] hover:text-[var(--on-primary)] text-[var(--primary)] text-[14px] font-bold inline-flex items-center justify-center gap-2 cursor-pointer transition-colors shrink-0"
              >
                <RotateCcw className="w-4 h-4 shrink-0" />
                <span>أعد الفحص</span>
              </button>
            </div>
          </section>

          {/* B4.2 Simple Rating Card */}
          {ratingCardVisible && !ratingCardDismissed && (
            <section
              data-testid="report-rating-card"
              className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] p-5 shadow-[var(--sh-1)] space-y-3 relative transition-all"
            >
              <button
                type="button"
                onClick={() => {
                  setRatingCardDismissed(true);
                  try {
                    localStorage.setItem(`madam_rated_${result.scanId}`, 'dismissed');
                  } catch {}
                }}
                className="absolute top-4 start-4 text-[var(--ink-muted)] hover:text-[var(--ink)] text-sm p-1 cursor-pointer"
                aria-label="إغلاق التقييم"
              >
                ✕
              </button>

              <div className="flex items-center gap-2">
                <span className="text-xl">⭐</span>
                <h3 className="text-[16px] font-bold text-[var(--ink)]">
                  إيه رأيك في تقرير مدام عفاف للموقع؟
                </h3>
              </div>

              {ratingSubmitted ? (
                <div
                  data-testid="rating-thank-you-message"
                  className="p-3 rounded-[var(--r-md)] bg-[var(--pass-bg)] text-[var(--pass-fg)] font-bold text-sm text-center"
                >
                  شكراً! رأيك بيساعد مدام عفاف تدقق أحسن. ✓
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Stars 1-5 */}
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        data-testid={`rating-star-${star}`}
                        onClick={() => {
                          setRatingStars(star);
                          setSelectedRatingReasons([]);
                        }}
                        className={`text-2xl transition-transform hover:scale-110 cursor-pointer ${
                          star <= ratingStars ? 'text-amber-500' : 'text-gray-300'
                        }`}
                        aria-label={`${star} من 5 نجوم`}
                      >
                        ★
                      </button>
                    ))}
                    {ratingStars > 0 && (
                      <span className="text-xs font-bold text-[var(--ink-muted)] mr-2">
                        {ratingStars} من 5
                      </span>
                    )}
                  </div>

                  {/* Chips by rating */}
                  {ratingStars > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-[var(--ink-muted)]">
                        {ratingStars <= 3 ? 'إيه اللي كان ناقص؟' : 'إيه أكتر حاجة عجبتك؟'}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {(ratingStars <= 3
                          ? ['فيه نتايج غلط', 'ناقص حاجة مهمة', 'مش مفهوم', 'الحل مش مناسب', 'بطيء']
                          : ['دقيق', 'واضح', 'وفّر وقتي', 'الحل جاهز']
                        ).map((reason) => {
                          const isSelected = selectedRatingReasons.includes(reason);
                          return (
                            <button
                              key={reason}
                              type="button"
                              onClick={() => {
                                setSelectedRatingReasons((prev) =>
                                  isSelected ? prev.filter((r) => r !== reason) : [...prev, reason]
                                );
                              }}
                              className={`px-3 py-1 rounded-[var(--r-sm)] border text-xs font-medium transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-[var(--primary)] border-[var(--primary)] text-[var(--on-primary)] font-bold'
                                  : 'bg-[var(--surface-alt)] border-[var(--border)] text-[var(--ink)] hover:border-[var(--border-strong)]'
                              }`}
                            >
                              {reason}
                            </button>
                          );
                        })}
                      </div>

                      {/* Optional comment */}
                      <div className="pt-1">
                        <textarea
                          value={ratingComment}
                          onChange={(e) => setRatingComment(e.target.value.slice(0, 300))}
                          placeholder="كلمة إضافية لمدام عفاف (اختياري، لحد 300 حرف)..."
                          className="w-full text-xs p-2.5 rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] focus:outline-none focus:border-[var(--primary)]"
                          rows={2}
                        />
                        <div className="flex items-center justify-between text-[12px] text-[var(--ink-muted)] mt-1">
                          <span>
                            ملاحظتك للمطور لتحسين الأداة. للمزيد راجع{' '}
                            <a href="/privacy" className="underline hover:text-[var(--primary)]">
                              الخصوصية
                            </a>.
                          </span>
                          <span>{ratingComment.length}/300</span>
                        </div>
                      </div>

                      <div className="pt-2">
                        <button
                          type="button"
                          disabled={ratingSubmitting}
                          onClick={async () => {
                            setRatingSubmitting(true);
                            try {
                              await apiFetch('/api/feedback/report', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  scanId: result.scanId,
                                  stars: ratingStars,
                                  reasons: selectedRatingReasons,
                                  comment: ratingComment
                                })
                              });
                              setRatingSubmitted(true);
                              try {
                                localStorage.setItem(`madam_rated_${result.scanId}`, '1');
                              } catch {}
                              setTimeout(() => setRatingCardVisible(false), 3000);
                            } catch {
                              setRatingSubmitted(true);
                            } finally {
                              setRatingSubmitting(false);
                            }
                          }}
                          className="px-4 py-2 bg-[var(--primary)] text-[var(--on-primary)] font-bold text-xs rounded-[var(--r-md)] hover:bg-[var(--primary-hover)] transition-colors cursor-pointer"
                        >
                          إرسال التقييم
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* (6) "كل التفاصيل" as TABS (مؤكدة / محتاجة تحقق / عدّت / ما اتقاستش), single-item expansion */}
          <section
            aria-label="كل التفاصيل"
            data-testid="b2-all-details-tabs"
            className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--r-lg)] p-5 shadow-[var(--sh-1)] space-y-4"
          >
            <h2 className="text-[18px] font-bold text-[var(--ink)]">كل التفاصيل</h2>

            <div
              role="tablist"
              aria-label="أقسام التفاصيل"
              className="grid grid-cols-2 sm:grid-cols-4 gap-2"
            >
              {[
                {
                  id: 'confirmed' as const,
                  label: 'مؤكدة',
                  count: confirmedFindingsList.length,
                },
                {
                  id: 'needs_verification' as const,
                  label: 'محتاجة تحقق',
                  count: needsVerificationFindingsList.length,
                },
                {
                  id: 'passed' as const,
                  label: 'عدّت',
                  count: passes.length,
                },
                {
                  id: 'not_measured' as const,
                  label: 'ما اتقاستش',
                  count: notMeasured.length,
                },
              ].map((tab) => {
                const active = detailsTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`b2-tab-${tab.id}`}
                    onClick={() => {
                      setDetailsTab(tab.id);
                      setExpandedDetailItemId(null);
                    }}
                    className={`min-h-[44px] px-3 py-2 rounded-[var(--r-md)] border text-[14px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                      active
                        ? 'bg-[var(--primary)] border-[var(--primary)] text-[var(--on-primary)]'
                        : 'bg-[var(--bg)] border-[var(--border)] text-[var(--ink)] hover:bg-[var(--surface-alt)]'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <bdi dir="ltr" className="text-[12px] font-mono opacity-85">
                      ({formatNumber(tab.count)})
                    </bdi>
                  </button>
                );
              })}
            </div>

            {/* Tab Panel Content: Plain list where only ONE item expands at a time */}
            <div role="tabpanel" className="space-y-2">
              {(detailsTab === 'confirmed' || detailsTab === 'needs_verification') && (() => {
                const list =
                  detailsTab === 'confirmed'
                    ? confirmedFindingsList
                    : needsVerificationFindingsList;
                if (list.length === 0) {
                  return (
                    <p className="p-4 text-[14px] text-[var(--ink-muted)] text-center bg-[var(--bg)] rounded-[var(--r-md)] border border-[var(--border)]">
                      مفيش عناصر في القسم ده.
                    </p>
                  );
                }
                return list.map((f) => {
                  const isOpen = expandedDetailItemId === f.id;
                  const sevStyle = getSeverityBadgeStyle(f.severity);
                  const firstEv = f.evidence?.[0];
                  const snippetVal = firstEv?.value || firstEv?.ref || f.where?.snippet || '';
                  return (
                    <div
                      key={f.id}
                      className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg)] overflow-hidden"
                    >
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpandedDetailItemId(isOpen ? null : f.id)
                        }
                        className="w-full min-h-[48px] px-4 py-3 text-start flex items-center justify-between gap-2 hover:bg-[var(--surface-alt)] transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="px-2 py-0.5 rounded-[var(--r-sm)] text-[12px] font-bold shrink-0 inline-flex items-center gap-1"
                            style={{ backgroundColor: sevStyle.bg, color: sevStyle.fg }}
                          >
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                            <span>{sevStyle.label}</span>
                          </span>
                          <span className="text-[15px] font-bold text-[var(--ink)] truncate">
                            {f.titleAr || f.title}
                          </span>
                        </div>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                        )}
                      </button>

                      {isOpen && (
                        <div className="px-4 pb-4 pt-2 border-t border-[var(--border)] bg-[var(--surface)] space-y-3 text-[14px]">
                          <p className="text-[var(--ink)]">{f.observed}</p>
                          {f.recommendedFix && (
                            <p className="text-[var(--ink)]">
                              <span className="font-bold text-[var(--primary)]">الحل: </span>
                              {f.recommendedFix}
                            </p>
                          )}

                          {/* Technical Evidence inside "تفاصيل للمبرمج" */}
                          <details className="rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                            <summary className="font-bold text-[13px] text-[var(--ink)] cursor-pointer select-none">
                              تفاصيل للمبرمج (<bdi dir="ltr">{f.ruleId}</bdi>)
                            </summary>
                            <div className="mt-2 space-y-2 text-[12px]">
                              <div>
                                المكان:{' '}
                                <bdi dir="ltr" className="font-mono text-[var(--primary)]">
                                  {f.url || result.finalUrl || result.requestedUrl}
                                </bdi>
                              </div>
                              {snippetVal && (
                                <pre
                                  dir="ltr"
                                  className="p-2.5 rounded-[var(--r-sm)] bg-[var(--surface)] border border-[var(--border)] font-mono text-[12px] overflow-x-auto whitespace-pre-wrap"
                                >
                                  {snippetVal}
                                </pre>
                              )}
                            </div>
                          </details>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => copyIndividualFix(f)}
                              className="min-h-[40px] px-3 py-1.5 rounded-[var(--r-sm)] border border-[var(--primary)] text-[var(--primary)] text-[12px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
                            >
                              {copiedFindingId === f.id ? (
                                <Check className="w-3.5 h-3.5" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                              <span>{copiedFindingId === f.id ? 'اتنسخ ✓' : 'نسخ الحل'}</span>
                            </button>

                            <div className="inline-flex items-center gap-1.5 text-[12px]">
                              <span className="text-[var(--ink-muted)]">الملاحظة دي صح؟</span>
                              <button
                                type="button"
                                onClick={() => handleVoteFeedback(f, 'up')}
                                className={`min-h-[36px] px-2.5 py-1 rounded-[var(--r-sm)] border font-bold ${
                                  feedbackState[f.id] === 'up'
                                    ? 'bg-[var(--pass-bg)] border-[var(--pass-fg)] text-[var(--pass-fg)]'
                                    : 'bg-[var(--surface)] border-[var(--border)] text-[var(--ink)]'
                                }`}
                              >
                                👍 صح
                              </button>
                              <button
                                type="button"
                                onClick={() => handleVoteFeedback(f, 'down')}
                                className={`min-h-[36px] px-2.5 py-1 rounded-[var(--r-sm)] border font-bold cursor-pointer ${
                                  feedbackState[f.id] === 'down'
                                    ? 'bg-[var(--sev-critical-bg)] border-[var(--sev-critical-fg)] text-[var(--sev-critical-fg)]'
                                    : 'bg-[var(--surface)] border-[var(--border)] text-[var(--ink)]'
                                }`}
                              >
                                👎 لأ
                              </button>
                            </div>
                          </div>

                          {feedbackState[f.id] === 'down' && (
                            <div className="w-full pt-2 flex flex-wrap items-center gap-1.5 text-[12px] border-t border-[var(--border)] mt-1">
                              <span className="text-[var(--ink-muted)]">إيه المشكلة؟</span>
                              {['مش موجود في الصفحة', 'مقصود عندي', 'الحل مش مناسب', 'مش واضح'].map((reason) => {
                                const isChosen = findingDownReasons[f.id] === reason;
                                return (
                                  <button
                                    key={reason}
                                    type="button"
                                    onClick={() => handleVoteFeedback(f, 'down', reason)}
                                    className={`px-2 py-0.5 rounded-[var(--r-sm)] border text-[12px] font-medium transition-colors cursor-pointer ${
                                      isChosen
                                        ? 'bg-[var(--sev-critical-bg)] border-[var(--sev-critical-fg)] text-[var(--sev-critical-fg)] font-bold'
                                        : 'bg-[var(--surface-alt)] border-[var(--border)] text-[var(--ink)] hover:border-[var(--border-strong)]'
                                    }`}
                                  >
                                    {reason}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}

              {detailsTab === 'passed' && (() => {
                if (passes.length === 0) {
                  return (
                    <p className="p-4 text-[14px] text-[var(--ink-muted)] text-center bg-[var(--bg)] rounded-[var(--r-md)] border border-[var(--border)]">
                      مفيش عناصر في القسم ده.
                    </p>
                  );
                }
                return passes.map((p) => {
                  const isOpen = expandedDetailItemId === p.id;
                  return (
                    <div
                      key={p.id}
                      className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg)] overflow-hidden"
                    >
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpandedDetailItemId(isOpen ? null : p.id)
                        }
                        className="w-full min-h-[48px] px-4 py-3 text-start flex items-center justify-between gap-2 hover:bg-[var(--surface-alt)] transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <CheckCircle2 className="w-4 h-4 text-[var(--pass-fg)] shrink-0" />
                          <span className="text-[15px] font-bold text-[var(--ink)] truncate">
                            {p.titleAr}
                          </span>
                        </div>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                        )}
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 pt-2 border-t border-[var(--border)] bg-[var(--surface)] space-y-2 text-[14px]">
                          <p className="text-[var(--ink)]">{p.detailAr}</p>
                          {p.evidence && (
                            <details className="rounded-[var(--r-sm)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
                              <summary className="font-bold text-[13px] text-[var(--ink)] cursor-pointer select-none">
                                تفاصيل للمبرمج
                              </summary>
                              <pre
                                dir="ltr"
                                className="mt-2 p-2 rounded-[var(--r-sm)] bg-[var(--surface)] border border-[var(--border)] font-mono text-[12px] overflow-x-auto whitespace-pre-wrap"
                              >
                                {p.evidence}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}

              {detailsTab === 'not_measured' && (() => {
                if (notMeasured.length === 0) {
                  return (
                    <p className="p-4 text-[14px] text-[var(--ink-muted)] text-center bg-[var(--bg)] rounded-[var(--r-md)] border border-[var(--border)]">
                      كل فحوصات العينة اتقاست.
                    </p>
                  );
                }
                return notMeasured.map((nm) => {
                  const isOpen = expandedDetailItemId === nm.id;
                  return (
                    <div
                      key={nm.id}
                      className="rounded-[var(--r-md)] border border-[var(--border)] bg-[var(--bg)] overflow-hidden"
                    >
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpandedDetailItemId(isOpen ? null : nm.id)
                        }
                        className="w-full min-h-[48px] px-4 py-3 text-start flex items-center justify-between gap-2 hover:bg-[var(--surface-alt)] transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <EyeOff className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                          <span className="text-[15px] font-bold text-[var(--ink)] truncate">
                            {nm.titleAr}
                          </span>
                        </div>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-[var(--ink-muted)] shrink-0" />
                        )}
                      </button>
                      {isOpen && (
                        <div className="px-4 pb-4 pt-2 border-t border-[var(--border)] bg-[var(--surface)] space-y-1.5 text-[14px] text-[var(--ink-muted)]">
                          <p>{nm.reasonAr}</p>
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </section>

          {/* (7) "حدود الفحص" text as a small link that opens a sheet */}
          <div className="flex items-center justify-center gap-4 pt-2 text-[13px] text-[var(--ink-muted)]">
            <button
              type="button"
              onClick={() => setShowLimitationsSheet(true)}
              data-testid="b2-limitations-link"
              className="min-h-[44px] px-3 py-1.5 underline font-bold text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
            >
              حدود الفحص
            </button>
            {!result.isSharedView && !result.isMockFallback && (
              <button
                type="button"
                onClick={handleDeleteReport}
                disabled={deleting}
                className="min-h-[44px] px-3 py-1.5 text-[var(--sev-critical-fg)] hover:underline font-bold cursor-pointer"
              >
                {deleting ? 'جاري المسح...' : 'مسح التقرير'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Limitations Sheet (B2.6 item 7) */}
      {showLimitationsSheet && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="حدود الفحص"
          data-testid="b2-limitations-sheet"
          className="no-print fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--ink)]/30 p-0 sm:p-4"
          onClick={() => setShowLimitationsSheet(false)}
        >
          <div
            className="w-full sm:max-w-md bg-[var(--surface)] border-t sm:border border-[var(--border)] rounded-t-[var(--r-lg)] sm:rounded-[var(--r-lg)] shadow-[var(--sh-3)] p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] pb-3">
              <h2 className="text-[18px] font-bold text-[var(--ink)]">حدود الفحص</h2>
              <button
                type="button"
                onClick={() => setShowLimitationsSheet(false)}
                aria-label="إغلاق حدود الفحص"
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[var(--r-sm)] text-[var(--ink-muted)] hover:bg-[var(--surface-alt)]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-[14px] text-[var(--ink)] leading-[1.7]">
              عينة لحد 10 صفحات عامة؛ مفيش فحص لمناطق تسجيل الدخول؛ مفيش اختبار دفع أو طلبات أو إرسال نماذج؛ مفيش مراجعة للسيرفر أو قاعدة البيانات؛ الفحص من كود الصفحة وقياسات جوجل المعملية؛ النتيجة مش ضمان.
            </p>
            <button
              type="button"
              onClick={() => setShowLimitationsSheet(false)}
              className="w-full min-h-[44px] py-2.5 rounded-[var(--r-md)] bg-[var(--primary)] text-[var(--on-primary)] text-[14px] font-bold"
            >
              فهمت
            </button>
          </div>
        </div>
      )}

      {/* Full Print / Ledger View (expanded in print mode, hidden on calm screen) */}
      <div className={isPrintMode ? 'block' : 'print-only'}>
      {/* K1.2 & J2.1 & J2.2 Sticky Top Bar: single 48px line (domain + technical-details switch) */}
      <div
        data-testid="sticky-report-topbar"
        className="no-print sticky top-0 z-20 h-12 mb-4 px-3.5 border flex items-center justify-between gap-2"
        style={{
          backgroundColor: 'var(--surface)',
          borderColor: 'var(--border-strong)',
          borderRadius: 'var(--r-md)',
          boxShadow: 'var(--sh-2)'
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <VerdictIcon className="w-4 h-4 shrink-0" style={{ color: verdictTheme.fg }} />
          <bdi
            dir="ltr"
            title={result.finalUrl || result.requestedUrl}
            className="text-xs sm:text-sm font-mono font-bold truncate max-w-[160px] sm:max-w-[260px]"
            style={{ color: 'var(--ink)' }}
          >
            {result.registrableDomain || formatDomainPathDisplay(result.finalUrl || result.requestedUrl)}
          </bdi>
          <span
            className="hidden sm:inline-block px-2 py-0.5 border text-xs font-bold shrink-0"
            style={{
              backgroundColor: verdictTheme.bg,
              borderColor: verdictTheme.fg,
              color: verdictTheme.fg,
              borderRadius: 'var(--r-sm)'
            }}
          >
            {verdictTheme.label}
          </span>
        </div>

        <button
          type="button"
          data-testid="minibar-tech-details-toggle"
          onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
          aria-pressed={showTechnicalDetails}
          className="min-h-[36px] px-3 py-1 border text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer transition-colors shrink-0"
          style={{
            backgroundColor: showTechnicalDetails ? 'var(--primary)' : 'var(--surface-alt)',
            borderColor: showTechnicalDetails ? 'var(--primary)' : 'var(--border-strong)',
            color: showTechnicalDetails ? 'var(--on-primary)' : 'var(--ink)',
            borderRadius: 'var(--r-sm)'
          }}
        >
          <Code2 className="w-3.5 h-3.5 shrink-0" />
          <span>{showTechnicalDetails ? 'إخفاء الكود التقني' : 'التفاصيل التقنية'}</span>
        </button>
      </div>

      {/* =====================================================================
          (1) HEADER: Site URL (ltr with tooltip & copy), Scan Date/Time, Scan ID, Pages N/10, Ruleset Version
      ===================================================================== */}
      <section
        aria-label="رأس التقرير"
        className="p-4 sm:p-6 border mb-5 avoid-break"
        style={{
          backgroundColor: 'var(--surface)',
          borderColor: 'var(--border)',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--sh-1)'
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="print-only text-lg font-bold" style={{ color: 'var(--ink)' }}>
                مدام <span className="afaf-pen-underline">عفاف</span>
              </span>
              {result.isMockFallback && (
                <span
                  className="px-2.5 py-0.5 border text-xs font-bold"
                  style={{
                    backgroundColor: 'var(--sev-medium-bg)',
                    borderColor: 'var(--sev-medium-fg)',
                    color: 'var(--sev-medium-fg)',
                    borderRadius: 'var(--r-sm)'
                  }}
                >
                  بيانات تجريبية MOCK
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <bdi
                dir="ltr"
                title={result.finalUrl || result.requestedUrl}
                className="block text-sm sm:text-base font-mono font-bold truncate max-w-[220px] sm:max-w-[380px]"
                style={{ color: 'var(--primary)' }}
              >
                {formatDomainPathDisplay(result.finalUrl || result.requestedUrl)}
              </bdi>
              <button
                type="button"
                onClick={() => handleCopyUrl(result.finalUrl || result.requestedUrl, 'header-url')}
                title="نسخ الرابط الكامل"
                aria-label="نسخ الرابط الكامل"
                className="no-print p-1 border cursor-pointer shrink-0"
                style={{
                  backgroundColor: 'var(--surface-alt)',
                  borderColor: 'var(--border)',
                  color: 'var(--ink)',
                  borderRadius: 'var(--r-sm)'
                }}
              >
                {copiedUrlKey === 'header-url' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* J2.2 First-Screen Toolbar: ONE primary button "برومبت الإصلاح الشامل" + ONE "المزيد" menu */}
          <div className="no-print relative flex items-center gap-2">
            <button
              type="button"
              data-testid="primary-master-prompt-btn"
              onClick={() => setShowMasterPromptSheet(true)}
              className="min-h-[44px] px-4 py-2 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
              style={{
                backgroundColor: 'var(--primary)',
                color: 'var(--on-primary)',
                borderRadius: 'var(--r-sm)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <ListChecks className="w-4 h-4 shrink-0" />
              <span>برومبت الإصلاح الشامل</span>
            </button>

            <button
              type="button"
              disabled
              aria-disabled="true"
              className="hidden sm:inline-flex min-h-[44px] px-3.5 py-2 border text-xs sm:text-sm font-bold items-center gap-1.5 opacity-60 cursor-not-allowed"
              style={{
                backgroundColor: 'var(--surface-alt)',
                borderColor: 'var(--border)',
                color: 'var(--ink-muted)',
                borderRadius: 'var(--r-sm)'
              }}
              title="فحص عميق بالمتصفح الحقيقي للمواقع الموثقة (قريبًا)"
            >
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>فحص عميق</span>
              <span
                className="px-1.5 py-0.5 border text-xs font-bold"
                style={{
                  backgroundColor: 'var(--sev-medium-bg)',
                  borderColor: 'var(--sev-medium-fg)',
                  color: 'var(--sev-medium-fg)',
                  borderRadius: 'var(--r-sm)'
                }}
              >
                قريبًا
              </span>
            </button>

            <button
              type="button"
              data-testid="more-actions-menu-btn"
              aria-expanded={showMoreActionsMenu}
              aria-haspopup="menu"
              onClick={() => setShowMoreActionsMenu(prev => !prev)}
              className="min-h-[44px] px-3.5 py-2 border text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
              style={{
                backgroundColor: 'var(--surface-alt)',
                borderColor: 'var(--border-strong)',
                color: 'var(--ink)',
                borderRadius: 'var(--r-sm)'
              }}
            >
              <MoreHorizontal className="w-4 h-4 shrink-0" />
              <span>المزيد</span>
            </button>

            {showMoreActionsMenu && (
              <>
                <div
                  className="fixed inset-0 z-40 bg-black/25 sm:bg-transparent"
                  onClick={() => setShowMoreActionsMenu(false)}
                />
                <div
                  role="menu"
                  aria-label="قائمة إجراءات التقرير"
                  className="fixed inset-x-0 bottom-0 z-50 p-4 border-t sm:absolute sm:inset-auto sm:end-0 sm:top-full sm:mt-2 sm:w-64 sm:p-2 sm:border space-y-1"
                  style={{
                    backgroundColor: 'var(--surface)',
                    borderColor: 'var(--border-strong)',
                    borderRadius: 'var(--r-md)',
                    boxShadow: 'var(--sh-3)'
                  }}
                >
                  <div className="flex items-center justify-between pb-2 mb-1 border-b sm:hidden" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-sm font-bold" style={{ color: 'var(--ink)' }}>إجراءات التقرير</span>
                    <button
                      type="button"
                      onClick={() => setShowMoreActionsMenu(false)}
                      className="p-1.5 cursor-pointer"
                      aria-label="إغلاق القائمة"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowMoreActionsMenu(false);
                      setShowTechnicalDetails(true);
                      setIsPrintMode(true);
                    }}
                    className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center gap-2.5 cursor-pointer hover:bg-[var(--surface-alt)]"
                    style={{ color: 'var(--ink)', borderRadius: 'var(--r-sm)' }}
                  >
                    <Printer className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
                    <span>PDF / طباعة</span>
                  </button>

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowMoreActionsMenu(false);
                      handleExportJson();
                    }}
                    className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center gap-2.5 cursor-pointer hover:bg-[var(--surface-alt)]"
                    style={{ color: 'var(--ink)', borderRadius: 'var(--r-sm)' }}
                  >
                    <Download className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
                    <span>تصدير JSON</span>
                  </button>

                  {!result.isSharedView && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="share-report-btn"
                      disabled={sharing || isHighProfile}
                      onClick={() => {
                        if (isHighProfile) return;
                        setShowMoreActionsMenu(false);
                        handleShareReport();
                      }}
                      className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--surface-alt)] disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ color: 'var(--ink)', borderRadius: 'var(--r-sm)' }}
                      title={
                        isHighProfile
                          ? highProfileNotice
                          : 'إنشاء رابط مشاركة للتقرير صالح لمدة 7 أيام'
                      }
                    >
                      <span className="flex items-center gap-2.5">
                        <Share2 className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
                        <span>{sharing ? 'جاري التجهيز...' : 'مشاركة'}</span>
                      </span>
                      {isHighProfile && (
                        <span className="text-xs font-medium" style={{ color: 'var(--sev-medium-fg)' }}>
                          موقوف للمواقع المحمية
                        </span>
                      )}
                    </button>
                  )}

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowMoreActionsMenu(false);
                      handleToggleSpeech();
                    }}
                    className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center gap-2.5 cursor-pointer hover:bg-[var(--surface-alt)]"
                    style={{ color: 'var(--ink)', borderRadius: 'var(--r-sm)' }}
                  >
                    {isSpeakingReport ? (
                      <>
                        <VolumeX className="w-4 h-4 shrink-0" style={{ color: 'var(--pen)' }} />
                        <span>إيقاف الصوت</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
                        <span>اسمع الملخص</span>
                      </>
                    )}
                  </button>

                  {onRescanDomain && !result.isSharedView && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setShowMoreActionsMenu(false);
                        onRescanDomain(result.requestedUrl);
                      }}
                      className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center gap-2.5 cursor-pointer hover:bg-[var(--surface-alt)]"
                      style={{ color: 'var(--ink)', borderRadius: 'var(--r-sm)' }}
                    >
                      <RotateCcw className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
                      <span>إعادة فحص</span>
                    </button>
                  )}

                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowMoreActionsMenu(false);
                      onNewScan();
                    }}
                    className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center gap-2.5 cursor-pointer hover:bg-[var(--surface-alt)]"
                    style={{ color: 'var(--primary)', borderRadius: 'var(--r-sm)' }}
                  >
                    <Sparkles className="w-4 h-4 shrink-0" />
                    <span>فحص جديد</span>
                  </button>

                  <a
                    href="https://www.linkedin.com/in/mo7amadsultan/"
                    target="_blank"
                    rel="noopener noreferrer"
                    role="menuitem"
                    data-testid="menu-linkedin-link"
                    onClick={() => setShowMoreActionsMenu(false)}
                    className="w-full min-h-[44px] px-3 py-2 text-start text-sm font-bold flex items-center justify-between gap-2 cursor-pointer hover:bg-[var(--surface-alt)]"
                    style={{ color: 'var(--primary)', borderRadius: 'var(--r-sm)' }}
                  >
                    <span>تواصل مع المطور</span>
                    <span className="text-xs font-medium text-[var(--ink-muted)]">LinkedIn</span>
                  </a>
                </div>
              </>
            )}
          </div>
        </div>

        {shareToast && (
          <div
            role="status"
            className="no-print mt-3 p-3 text-xs font-bold border flex items-center gap-2"
            style={{
              backgroundColor: 'var(--pass-bg)',
              borderColor: 'var(--pass-fg)',
              color: 'var(--pass-fg)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            <Check className="w-4 h-4 shrink-0" />
            <span>{shareToast}</span>
          </div>
        )}

        {activeShareUrl && !result.isSharedView && !result.isMockFallback && (
          <div
            role="region"
            aria-label="إدارة رابط المشاركة"
            className="no-print mt-3 p-3 border text-xs flex flex-wrap items-center justify-between gap-2.5"
            style={{
              backgroundColor: 'var(--surface-alt)',
              borderColor: 'var(--primary)',
              color: 'var(--ink)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Share2 className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
              <span className="font-bold">رابط المشاركة (صالح 7 أيام للقراءة فقط):</span>
              <bdi dir="ltr" className="font-mono truncate max-w-[200px] sm:max-w-[320px]" style={{ color: 'var(--primary)' }}>
                {activeShareUrl}
              </bdi>
              <button
                type="button"
                onClick={() => handleCopyUrl(activeShareUrl, 'active-share-url')}
                className="px-2 py-0.5 border font-bold cursor-pointer"
                style={{
                  backgroundColor: 'var(--surface)',
                  borderColor: 'var(--border)',
                  color: 'var(--ink)',
                  borderRadius: 'var(--r-sm)'
                }}
              >
                {copiedUrlKey === 'active-share-url' ? 'تم النسخ ✓' : 'نسخ'}
              </button>
            </div>

            <button
              type="button"
              data-testid="revoke-share-btn"
              disabled={revokingShare}
              onClick={handleRevokeShareReport}
              className="px-2.5 py-1 border font-bold cursor-pointer"
              style={{
                backgroundColor: 'var(--sev-critical-bg)',
                borderColor: 'var(--sev-critical-fg)',
                color: 'var(--sev-critical-fg)',
                borderRadius: 'var(--r-sm)'
              }}
            >
              {revokingShare ? 'جاري الإلغاء...' : 'إلغاء رابط المشاركة'}
            </button>
          </div>
        )}

        {/* Report Metadata Strip */}
        <div
          className="pt-3 flex flex-wrap items-center justify-between gap-2 text-xs font-medium"
          style={{ color: 'var(--ink-muted)' }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span>
              تاريخ الفحص:{' '}
              <span className="font-bold" style={{ color: 'var(--ink)' }}>
                {formatDate(result.finishedAt || result.startedAt || Date.now())}
              </span>
            </span>
            {!isStatusReportOnly && (
              <span>
                الصفحات المفحوصة:{' '}
                <bdi dir="ltr" className="font-mono font-bold" style={{ color: 'var(--ink)' }}>
                  {formatNumber(result.uniquePagesInspected)}/{formatNumber(result.limits?.maxPages || 10)}
                </bdi>{' '}
                (عينة)
              </span>
            )}
            <span>
              إصدار القواعد:{' '}
              <bdi dir="ltr" className="font-mono">
                v{result.rulesetVersion || '2.0.0'}
              </bdi>
            </span>
            {showTechnicalDetails && (
              <span>
                رقم التقرير:{' '}
                <bdi dir="ltr" className="font-mono">
                  {result.scanId}
                </bdi>
              </span>
            )}
          </div>

          {!result.isSharedView && !result.isMockFallback && (
            <button
              type="button"
              onClick={handleDeleteReport}
              disabled={deleting}
              className="no-print inline-flex items-center gap-1 text-xs font-bold cursor-pointer hover:underline"
              style={{ color: 'var(--pen)' }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{deleting ? 'جاري الحذف...' : 'حذف التقرير'}</span>
            </button>
          )}
        </div>
      </section>

      {/* =====================================================================
          DESKTOP 2-COLUMN LAYOUT FROM 1024px (lg:grid-cols-12)
      ===================================================================== */}
      <div className="lg:grid lg:grid-cols-12 lg:gap-6 lg:items-start space-y-5 lg:space-y-0">
        {/* STICKY SIDE COLUMN ON DESKTOP (Verdict Stamp + Counts + Table of Contents) */}
        <aside className="lg:col-span-4 lg:sticky lg:top-20 space-y-4">
          {/* (2) VERDICT STAMP + 2-LINE PLAIN SUMMARY */}
          <section
            aria-label="الحكم النهائي"
            className="p-5 afaf-verdict-stamp avoid-break"
            style={{
              backgroundColor: verdictTheme.bg,
              borderColor: verdictTheme.fg,
              color: verdictTheme.fg
            }}
          >
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <VerdictIcon className="w-6 h-6 shrink-0" />
                <h1 className="text-lg sm:text-xl font-bold">{verdictTheme.label}</h1>
              </div>
              {result.verdict?.isPartial && (
                <span
                  className="px-2 py-0.5 border text-xs font-bold shrink-0"
                  style={{
                    backgroundColor: 'var(--surface)',
                    borderColor: verdictTheme.fg,
                    color: verdictTheme.fg,
                    borderRadius: 'var(--r-sm)'
                  }}
                >
                  مراجعة جزئية
                </span>
              )}
            </div>

            <div className="space-y-1 text-sm sm:text-base font-medium" style={{ color: 'var(--ink)' }}>
              {result.verdict?.summaryLinesAr ? (
                <>
                  <p>{result.verdict.summaryLinesAr[0]}</p>
                  <p>{result.verdict.summaryLinesAr[1]}</p>
                </>
              ) : (
                <p>{result.summaryAr}</p>
              )}
            </div>

            {/* J2.8 Verdict Drivers: Top 1-3 confirmed findings that decided the verdict, each linking to its card */}
            {!isStatusReportOnly && verdictDrivers.length > 0 && (
              <div
                className="mt-3 pt-2.5 border-t space-y-1.5 text-xs sm:text-sm"
                style={{ borderColor: 'var(--border-strong)', color: 'var(--ink)' }}
              >
                <span className="font-bold block">الأسباب المؤكدة للحكم:</span>
                <ul className="space-y-1">
                  {verdictDrivers.map(d => (
                    <li key={d.findingId}>
                      <a
                        href={`#finding-${d.findingId}`}
                        onClick={e => {
                          e.preventDefault();
                          jumpToFindingCard(d.findingId);
                        }}
                        className="inline-flex items-center gap-1 font-bold underline hover:opacity-80"
                        style={{ color: 'var(--ink)' }}
                      >
                        <span>• {d.summaryAr}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.verdict?.isPartial &&
              result.verdict.partialReasonsAr &&
              result.verdict.partialReasonsAr.length > 0 && (
                <div
                  className="mt-3 pt-2.5 border-t text-xs font-medium space-y-1"
                  style={{ borderColor: 'var(--border-strong)', color: 'var(--ink)' }}
                >
                  <span className="font-bold block">ليه المراجعة جزئية؟</span>
                  {result.verdict.partialReasonsAr.map((r, idx) => (
                    <p key={idx}>• {r}</p>
                  ))}
                </div>
              )}

            {/* Honest Counts (Never a fake percentage score) — P2b.8 */}
            {!isStatusReportOnly && (() => {
              const confirmedFindingsCount = findings.filter(
                f => f.confidence === 'confirmed' || f.kind === 'confirmed_defect'
              ).length;
              const needsVerificationFindingsCount = findings.filter(
                f => f.confidence !== 'confirmed' && f.kind !== 'confirmed_defect'
              ).length;
              const pagesSampleCount = result.uniquePagesInspected || result.pages?.length || 1;

              return (
                <div className="mt-4 pt-3 border-t space-y-2" style={{ borderColor: 'var(--border-strong)' }}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 text-center">
                    <div
                      className="p-1.5 sm:p-2 border"
                      style={{
                        backgroundColor: 'var(--surface)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      <span className="text-xs font-bold block" style={{ color: 'var(--sev-critical-fg)' }}>
                        مؤكدة (<bdi dir="ltr">{formatNumber(confirmedFindingsCount)}</bdi>)
                      </span>
                    </div>
                    <div
                      className="p-1.5 sm:p-2 border"
                      style={{
                        backgroundColor: 'var(--surface)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      <span className="text-xs font-bold block" style={{ color: 'var(--sev-medium-fg)' }}>
                        محتاجة تحقق (<bdi dir="ltr">{formatNumber(needsVerificationFindingsCount)}</bdi>)
                      </span>
                    </div>
                    <div
                      className="p-1.5 sm:p-2 border"
                      style={{
                        backgroundColor: 'var(--surface)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      <span className="text-xs font-bold block" style={{ color: 'var(--pass-fg)' }}>
                        فحوصات عدّت (<bdi dir="ltr">{formatNumber(passes.length)}</bdi>)
                      </span>
                    </div>
                    <div
                      className="p-1.5 sm:p-2 border"
                      style={{
                        backgroundColor: 'var(--surface)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      <span className="text-xs font-bold block" style={{ color: 'var(--ink)' }}>
                        ما اتقاستش (<bdi dir="ltr">{formatNumber(notMeasured.length)}</bdi>)
                      </span>
                    </div>
                  </div>
                  <div className="text-center text-xs font-bold" style={{ color: 'var(--ink-muted)' }}>
                    <span>من عينة {formatNumber(pagesSampleCount)} صفحات — </span>
                    <a
                      href="#sec-scan-limits"
                      className="underline hover:opacity-80"
                      style={{ color: 'var(--primary)' }}
                    >
                      راجع حدود الفحص
                    </a>
                  </div>
                </div>
              );
            })()}
          </section>

          {/* Sticky Table of Contents on Desktop */}
          {!isStatusReportOnly && (
            <nav
              aria-label="فهرس التقرير"
              className="no-print hidden lg:block p-4 border space-y-2"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-md)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <span className="block text-xs font-bold pb-1.5 border-b" style={{ color: 'var(--ink-muted)', borderColor: 'var(--border)' }}>
                أقسام دفتر المراجعة
              </span>
              <ul className="space-y-1.5 text-sm font-bold">
                <li>
                  <a
                    href="#sec-profile"
                    onClick={e => {
                      e.preventDefault();
                      openAndScrollToSection('profile', 'sec-profile');
                    }}
                    className="block py-1 hover:underline"
                    style={{ color: 'var(--ink)' }}
                  >
                    1. بطاقة توصيف الموقع والصفحات
                  </a>
                </li>
                <li>
                  <a
                    href="#sec-ai-claims"
                    onClick={e => {
                      e.preventDefault();
                      openAndScrollToSection('ai-claims', 'sec-ai-claims');
                    }}
                    className="block py-1 hover:underline"
                    style={{ color: 'var(--ink)' }}
                  >
                    2. قالك إيه الـ AI؟
                  </a>
                </li>
                {topPriorities.length > 0 && (
                  <li>
                    <a
                      href="#sec-priorities"
                      onClick={e => {
                        e.preventDefault();
                        openAndScrollToSection('priorities', 'sec-priorities');
                      }}
                      className="block py-1 hover:underline"
                      style={{ color: 'var(--pen)' }}
                    >
                      3. ابدأ من هنا ({topPriorities.length})
                    </a>
                  </li>
                )}
                <li>
                  <a
                    href="#sec-findings"
                    onClick={e => {
                      e.preventDefault();
                      openAndScrollToSection('findings', 'sec-findings');
                    }}
                    className="block py-1 hover:underline"
                    style={{ color: 'var(--ink)' }}
                  >
                    4. الملاحظات حسب الفئة ({findings.length})
                  </a>
                </li>
                <li>
                  <a
                    href="#sec-passes"
                    onClick={e => {
                      e.preventDefault();
                      openAndScrollToSection('passes', 'sec-passes');
                    }}
                    className="block py-1 hover:underline"
                    style={{ color: 'var(--pass-fg)' }}
                  >
                    5. اللي تمام ({passes.length})
                  </a>
                </li>
                {humanDecisionItems.length > 0 && (
                  <li>
                    <a
                      href="#sec-decisions"
                      onClick={e => {
                        e.preventDefault();
                        openAndScrollToSection('decisions', 'sec-decisions');
                      }}
                      className="block py-1 hover:underline"
                      style={{ color: 'var(--sev-medium-fg)' }}
                    >
                      6. محتاج قرار منك ({humanDecisionItems.length})
                    </a>
                  </li>
                )}
                <li>
                  <a
                    href="#sec-not-measured"
                    onClick={e => {
                      e.preventDefault();
                      openAndScrollToSection('not-measured', 'sec-not-measured');
                    }}
                    className="block py-1 hover:underline"
                    style={{ color: 'var(--ink-muted)' }}
                  >
                    7. ما اتقاسش ({notMeasured.length})
                  </a>
                </li>
                <li>
                  <a
                    href="#sec-fix-pack"
                    onClick={e => {
                      e.preventDefault();
                      openAndScrollToSection('fix-pack', 'sec-fix-pack');
                    }}
                    className="block py-1 hover:underline"
                    style={{ color: 'var(--primary)' }}
                  >
                    8. خطة الإصلاح وبرومبت الكود
                  </a>
                </li>
              </ul>
            </nav>
          )}
        </aside>

        {/* MAIN REPORT COLUMN */}
        <div className="lg:col-span-8 space-y-4">
          {/* =================================================================
              STATUS REPORT VIEW (When siteStatus.state !== 'ok', Section 6.1)
          ================================================================= */}
          {isStatusReportOnly && siteStatus && (
            <section
              className="p-4 sm:p-6 border space-y-4"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border-strong)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <h2 className="text-lg sm:text-xl font-bold" style={{ color: 'var(--ink)' }}>
                تقرير حالة الموقع (توقف الفحص المعتاد)
              </h2>

              <div className="space-y-3 text-base">
                <div
                  className="p-3.5 border"
                  style={{
                    backgroundColor: 'var(--bg)',
                    borderColor: 'var(--border)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <span className="block text-xs font-bold mb-1" style={{ color: 'var(--ink-muted)' }}>
                    اللي شفته:
                  </span>
                  <p className="font-bold break-words" style={{ color: 'var(--ink)' }}>
                    {siteStatus.whatISawAr}
                  </p>
                </div>

                <div
                  className="p-3.5 border"
                  style={{
                    backgroundColor: 'var(--bg)',
                    borderColor: 'var(--border)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <span className="block text-xs font-bold mb-1" style={{ color: 'var(--ink-muted)' }}>
                    معناه إيه:
                  </span>
                  <p className="font-medium break-words" style={{ color: 'var(--ink)' }}>
                    {siteStatus.whatItMeansAr}
                  </p>
                </div>

                <div
                  className="p-3.5 border"
                  style={{
                    backgroundColor: 'var(--pass-bg)',
                    borderColor: 'var(--pass-fg)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <span className="block text-xs font-bold mb-1" style={{ color: 'var(--pass-fg)' }}>
                    المطلوب تعمله دلوقتي:
                  </span>
                  <p className="font-bold break-words" style={{ color: 'var(--ink)' }}>
                    {siteStatus.whatToDoAr}
                  </p>
                </div>

                {siteStatus.evidence && siteStatus.evidence.length > 0 && (
                  <div
                    className="p-3 border font-mono text-xs evidence-block"
                    style={{
                      backgroundColor: 'var(--surface-alt)',
                      borderColor: 'var(--border)',
                      color: 'var(--ink)',
                      borderRadius: 'var(--r-sm)'
                    }}
                    dir="ltr"
                  >
                    {siteStatus.evidence.map((ev, idx) => (
                      <div key={idx}>{ev.value || ev.ref}</div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* =================================================================
              (3) SITE PROFILE CARD + SAMPLED PAGES LIST (Accordion)
          ================================================================= */}
          {!isStatusReportOnly && profile && (
            <section
              id="sec-profile"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <button
                type="button"
                onClick={() => toggleSection('profile')}
                aria-expanded={isSectionOpen('profile')}
                className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-2 text-start cursor-pointer select-none py-1"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Layers className="w-5 h-5 shrink-0" style={{ color: 'var(--primary)' }} />
                  <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                    بطاقة توصيف الموقع والصفحات (<bdi dir="ltr">{formatNumber(result.pages?.length || 1)}</bdi>)
                  </h2>
                </div>
                <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                  <span>{isSectionOpen('profile') ? 'طي' : 'عرض'}</span>
                  {isSectionOpen('profile') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </button>

              {isSectionOpen('profile') && (
                <div className="space-y-4 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-sm">
                    <div
                      className="p-3 border"
                      style={{
                        backgroundColor: 'var(--bg)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-md)'
                      }}
                    >
                      <span className="block text-xs font-medium mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                        المنصة وأداة البناء:
                      </span>
                      <span className="font-bold" style={{ color: 'var(--ink)' }}>
                        {getPlatformLabelAr(profile)}
                        {profile.version ? <bdi dir="ltr"> (v{profile.version})</bdi> : ''}
                      </span>
                    </div>

                    <div
                      className="p-3 border"
                      style={{
                        backgroundColor: 'var(--bg)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-md)'
                      }}
                    >
                      <span className="block text-xs font-medium mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                        تصنيف النشاط:
                      </span>
                      <span className="font-bold" style={{ color: 'var(--ink)' }}>
                        {SITE_TYPE_LABELS[profile.siteType || 'unknown'] || 'موقع ويب'}
                      </span>
                    </div>

                    <div
                      className="p-3 border"
                      style={{
                        backgroundColor: 'var(--bg)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-md)'
                      }}
                    >
                      <span className="block text-xs font-medium mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                        وسيلة التحويل الأساسية:
                      </span>
                      <span className="font-bold" style={{ color: 'var(--ink)' }}>
                        {CONVERSION_LABELS[profile.primaryConversion?.type || 'none']}{' '}
                        {profile.primaryConversion?.type && profile.primaryConversion.type !== 'none'
                          ? profile.primaryConversion.inTopOfPage
                            ? '— ظاهرة بأول الصفحة'
                            : '— آخر الصفحة'
                          : ''}
                      </span>
                    </div>

                    <div
                      className="p-3 border"
                      style={{
                        backgroundColor: 'var(--bg)',
                        borderColor: 'var(--border)',
                        borderRadius: 'var(--r-md)'
                      }}
                    >
                      <span className="block text-xs font-medium mb-0.5" style={{ color: 'var(--ink-muted)' }}>
                        اللغة والنسخة البديلة:
                      </span>
                      <span className="font-bold" style={{ color: 'var(--ink)' }}>
                        <bdi dir="ltr">{(profile.language || 'ar').toUpperCase()}</bdi> ·{' '}
                        {profile.markets?.hasAlternateLanguage
                          ? 'توجد لغة ثانية'
                          : 'لغة واحدة فقط'}
                      </span>
                    </div>
                  </div>

                  {result.pages && result.pages.length > 0 && (
                    <div>
                      <span className="block text-xs font-bold mb-2" style={{ color: 'var(--ink-muted)' }}>
                        الصفحات اللي اتفحصت (<bdi dir="ltr">{result.pages.length}/{result.limits?.maxPages || 10}</bdi>):
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {result.pages.map((p, idx) => (
                          <a
                            key={idx}
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={decodeUrlForDisplay(p.url)}
                            className="px-2.5 py-1 border text-xs font-medium inline-flex items-center gap-1.5 hover:underline"
                            style={{
                              backgroundColor: 'var(--bg)',
                              borderColor: 'var(--border)',
                              color: 'var(--ink)',
                              borderRadius: 'var(--r-sm)'
                            }}
                          >
                            <span>{p.title || decodeUrlForDisplay(p.url) || 'صفحة'}</span>
                            <ExternalLink className="w-3 h-3 shrink-0" style={{ color: 'var(--primary)' }} />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* =================================================================
              (4) "قالك إيه الـ AI؟": Claims vs. Reality (Accordion)
          ================================================================= */}
          {!isStatusReportOnly && (
            <section
              id="sec-ai-claims"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <button
                type="button"
                onClick={() => toggleSection('ai-claims')}
                aria-expanded={isSectionOpen('ai-claims')}
                className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-2 text-start cursor-pointer select-none py-1"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Sparkles className="w-5 h-5 shrink-0" style={{ color: 'var(--primary)' }} />
                  <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                    قالك إيه الـ AI أو المطور؟ (المزاعم مقابل الواقع)
                  </h2>
                </div>
                <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                  <span>{isSectionOpen('ai-claims') ? 'طي' : 'عرض'}</span>
                  {isSectionOpen('ai-claims') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </button>

              {isSectionOpen('ai-claims') && (
                <div className="space-y-3 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  <div className="no-print flex flex-wrap gap-2">
                    <input
                      type="text"
                      value={customAiClaims}
                      onChange={e => setCustomAiClaims(e.target.value)}
                      placeholder="اكتب اللي قالهولك الـ AI أو المطور (مثال: الموقع متجاوب والسيو متظبط)..."
                      className="flex-1 min-w-[220px] px-3 py-2 text-sm border font-medium"
                      style={{
                        backgroundColor: 'var(--bg)',
                        borderColor: 'var(--border)',
                        color: 'var(--ink)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    />
                    {!customAiClaims && (
                      <button
                        type="button"
                        onClick={() =>
                          setCustomAiClaims('الموقع متجاوب على الموبايل والسيو متظبط ومؤمن وجاهز للإطلاق')
                        }
                        className="px-3 py-2 border text-xs font-bold cursor-pointer"
                        style={{
                          backgroundColor: 'var(--surface-alt)',
                          borderColor: 'var(--border-strong)',
                          color: 'var(--ink)',
                          borderRadius: 'var(--r-sm)'
                        }}
                      >
                        جرّب مقارنة المزاعم الشائعة
                      </button>
                    )}
                  </div>

                  {activeClaimsComparison.length > 0 ? (
                    <div className="space-y-2.5 pt-1">
                      {activeClaimsComparison.map((item, idx) => {
                        const statusStyle =
                          item.status === 'verified_true'
                            ? { bg: 'var(--pass-bg)', fg: 'var(--pass-fg)', label: 'صحيح بالدليل' }
                            : item.status === 'contradicted'
                            ? { bg: 'var(--sev-critical-bg)', fg: 'var(--sev-critical-fg)', label: 'مخالف للدليل' }
                            : { bg: 'var(--sev-medium-bg)', fg: 'var(--sev-medium-fg)', label: 'ما اتقاسش كامل' };

                        return (
                          <div
                            key={idx}
                            className="p-3 border space-y-1.5"
                            style={{
                              backgroundColor: 'var(--bg)',
                              borderColor: 'var(--border)',
                              borderRadius: 'var(--r-md)'
                            }}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-sm font-bold" style={{ color: 'var(--ink)' }}>
                                المزعوم: {item.claimAr}
                              </span>
                              <span
                                className="px-2.5 py-0.5 border text-xs font-bold"
                                style={{
                                  backgroundColor: statusStyle.bg,
                                  borderColor: statusStyle.fg,
                                  color: statusStyle.fg,
                                  borderRadius: 'var(--r-sm)'
                                }}
                              >
                                {statusStyle.label}
                              </span>
                            </div>
                            <p className="text-xs sm:text-sm font-medium" style={{ color: 'var(--ink-muted)' }}>
                              <strong style={{ color: 'var(--ink)' }}>الواقع بالدليل: </strong>
                              {item.realityAr}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs sm:text-sm" style={{ color: 'var(--ink-muted)' }}>
                      اكتب فوق أي جملة قالهالك المطور أو أداة الـ AI وهقارنهالك فوراً بالأدلة.
                    </p>
                  )}
                </div>
              )}
            </section>
          )}

          {/* =================================================================
              (5) "ابدأ من هنا": Top 5 Priorities (Collapsible Accordion + Mobile Fixed)
          ================================================================= */}
          {!isStatusReportOnly && topPriorities.length > 0 && (
            <section
              id="sec-priorities"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border-strong)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <button
                type="button"
                onClick={() => toggleSection('priorities')}
                aria-expanded={isSectionOpen('priorities')}
                className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-2 text-start cursor-pointer select-none py-1"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle className="w-5 h-5 shrink-0" style={{ color: 'var(--pen)' }} />
                  <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                    ابدأ من هنا — أهم أولويات للإصلاح
                  </h2>
                  <span
                    className="px-2 py-0.5 border text-xs font-bold shrink-0"
                    style={{
                      backgroundColor: 'var(--sev-critical-bg)',
                      borderColor: 'var(--pen)',
                      color: 'var(--pen)',
                      borderRadius: 'var(--r-sm)'
                    }}
                  >
                    <bdi dir="ltr">{formatArabicNoteCount(topPriorities.length)}</bdi>
                  </span>
                </div>
                <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                  <span className="hidden sm:inline">{isSectionOpen('priorities') ? 'طي القسم' : 'فتح التفاصيل'}</span>
                  {isSectionOpen('priorities') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </button>

              {isSectionOpen('priorities') && (
                <ol className="space-y-3 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  {topPriorities.map((f, idx) => {
                    const sevStyle = getSeverityBadgeStyle(f.severity);
                    const targetPageUrl = f.url || result.finalUrl || result.requestedUrl;
                    return (
                      <li
                        key={f.id}
                        className="p-3.5 border flex flex-col gap-2"
                        style={{
                          backgroundColor: 'var(--bg)',
                          borderColor: 'var(--border)',
                          borderRadius: 'var(--r-md)'
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                            style={{
                              backgroundColor: 'var(--primary)',
                              color: 'var(--on-primary)'
                            }}
                          >
                            <bdi dir="ltr">{formatNumber(idx + 1)}</bdi>
                          </span>
                          <span
                            className="px-2.5 py-0.5 border text-xs font-bold shrink-0 whitespace-nowrap"
                            style={{
                              backgroundColor: sevStyle.bg,
                              borderColor: sevStyle.fg,
                              color: sevStyle.fg,
                              borderRadius: 'var(--r-sm)'
                            }}
                          >
                            {sevStyle.icon} {sevStyle.label}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          <span className="block text-base font-bold leading-snug" style={{ color: 'var(--ink)' }}>
                            {f.titleAr || f.title}
                          </span>
                          <p className="text-sm font-medium leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                            الحل: {f.recommendedFix}
                          </p>
                          {targetPageUrl && (
                            <a
                              href={targetPageUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="afaf-url-wrap inline-flex items-center gap-1 text-xs font-bold hover:underline"
                              style={{ color: 'var(--primary)' }}
                            >
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              <bdi dir="ltr">{decodeUrlForDisplay(targetPageUrl)}</bdi>
                            </a>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}

          {/* =================================================================
              (6) FINDINGS BY CATEGORY (Accordions Collapsed by Default)
          ================================================================= */}
          {!isStatusReportOnly && (
            <section
              id="sec-findings"
              className="p-4 sm:p-5 border space-y-3 avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                  الملاحظات حسب الفئة (<bdi dir="ltr">{formatNumber(filteredFindings.length)}</bdi>)
                </h2>
                <div className="no-print flex flex-wrap items-center gap-2">
                  {findings.length > 0 && (
                    <button
                      type="button"
                      data-testid="expand-all-findings-btn"
                      onClick={handleToggleExpandAllFindings}
                      className="px-2.5 py-1 border text-xs font-bold cursor-pointer"
                      style={{
                        backgroundColor: allCategoriesExpanded ? 'var(--primary)' : 'var(--surface-alt)',
                        borderColor: allCategoriesExpanded ? 'var(--primary)' : 'var(--border-strong)',
                        color: allCategoriesExpanded ? 'var(--on-primary)' : 'var(--ink)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      {allCategoriesExpanded ? 'طي كل الفئات' : 'فتح كل الفئات والأدلة'}
                    </button>
                  )}
                  <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                    اضغط على أي فئة لفتح الملاحظات والأدلة
                  </span>
                </div>
              </div>

              {/* P3.2 Evidence-First Findings Filter Bar */}
              {findings.length > 0 && (
                <div
                  data-testid="findings-filter-bar"
                  role="group"
                  aria-label="فلترة الملاحظات حسب درجة التأكيد"
                  className="no-print flex flex-wrap items-center gap-1.5 pt-1"
                >
                  {[
                    {
                      id: 'all' as const,
                      label: `الكل (${formatNumber(findings.length)})`
                    },
                    {
                      id: 'confirmed' as const,
                      label: `المؤكد بالدليل (${formatNumber(confirmedFindingsList.length)})`
                    },
                    {
                      id: 'needs_verification' as const,
                      label: `محتاج تحقق (${formatNumber(needsVerificationFindingsList.length)})`
                    }
                  ].map(tab => {
                    const active = findingsFilter === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setFindingsFilter(tab.id)}
                        className="min-h-[36px] px-3 py-1 border text-xs font-bold cursor-pointer transition-colors"
                        style={{
                          backgroundColor: active ? 'var(--primary)' : 'var(--bg)',
                          borderColor: active ? 'var(--primary)' : 'var(--border)',
                          color: active ? 'var(--on-primary)' : 'var(--ink)',
                          borderRadius: 'var(--r-sm)'
                        }}
                      >
                        <bdi dir="ltr">{tab.label}</bdi>
                      </button>
                    );
                  })}
                </div>
              )}

              {filteredFindings.length === 0 ? (
                <div
                  className="p-5 border text-center space-y-2"
                  style={{
                    backgroundColor: 'var(--pass-bg)',
                    borderColor: 'var(--pass-fg)',
                    color: 'var(--pass-fg)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <CheckCircle2 className="w-7 h-7 mx-auto" />
                  <h3 className="text-sm sm:text-base font-bold">
                    {findings.length === 0
                      ? 'ملقتش مشاكل مؤكدة في الصفحات اللي اتفحصت'
                      : 'مفيش ملاحظات مطابقة للفلتر المختار حالياً'}
                  </h3>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {Array.from(findingsByCategory.entries()).map(([cat, catFindings]) => {
                    const overflowCount = result.overflowCountsByCategory?.[cat] || 0;
                    const catKey = `cat-${cat}`;
                    const isCatOpen = isSectionOpen(catKey);

                    return (
                      <div
                        key={cat}
                        className="border overflow-clip"
                        style={{
                          backgroundColor: 'var(--bg)',
                          borderColor: isCatOpen ? 'var(--border-strong)' : 'var(--border)',
                          borderRadius: 'var(--r-md)'
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleSection(catKey)}
                          aria-expanded={isCatOpen}
                          className="afaf-sticky-accordion-header w-full p-3.5 flex items-center justify-between gap-2 text-start cursor-pointer select-none"
                          style={{ backgroundColor: 'var(--surface)' }}
                        >
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <h3 className="text-sm sm:text-base font-bold" style={{ color: 'var(--ink)' }}>
                              {CATEGORY_LABELS[cat] || cat}
                            </h3>
                            <span
                              className="px-2 py-0.5 border text-xs font-bold"
                              style={{
                                backgroundColor: 'var(--surface-alt)',
                                borderColor: 'var(--border)',
                                color: 'var(--ink)',
                                borderRadius: 'var(--r-sm)'
                              }}
                            >
                              <bdi dir="ltr">{formatArabicNoteCount(catFindings.length)}</bdi>
                            </span>
                            {overflowCount > 0 && (
                              <span className="text-xs font-medium" style={{ color: 'var(--ink-muted)' }}>
                                (+<bdi dir="ltr">{formatNumber(overflowCount)}</bdi> إضافية)
                              </span>
                            )}
                          </div>

                          <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                            <span>{isCatOpen ? 'إغلاق' : 'عرض'}</span>
                            {isCatOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                          </div>
                        </button>

                        {isCatOpen && (
                          <div className="p-3 sm:p-4 space-y-3 border-t" style={{ borderColor: 'var(--border)' }}>
                            {catFindings.map(f => {
                              const sevStyle = getSeverityBadgeStyle(f.severity);
                              const isEvidenceOpen =
                                showTechnicalDetails || isPrintMode || Boolean(expandedEvidenceIds[f.id]);
                              const firstEvidence =
                                f.evidence?.[0]?.value || f.evidence?.[0]?.ref || '';
                              const vote = feedbackState[f.id];
                              const targetUrl = f.where?.pageUrl || f.url || result.finalUrl || result.requestedUrl;
                              const textFragmentUrl = buildTextFragmentUrl(targetUrl, f.where?.visibleText);
                              const locationHint = f.location || f.evidence?.[0]?.ref || firstEvidence.slice(0, 120);

                              if (vote === 'down' && !isPrintMode) {
                                return (
                                  <div
                                    key={f.id}
                                    className="p-3 border flex flex-wrap items-center justify-between gap-2 text-xs font-bold"
                                    style={{
                                      backgroundColor: 'var(--surface)',
                                      borderColor: 'var(--border)',
                                      color: 'var(--ink-muted)',
                                      borderRadius: 'var(--r-sm)'
                                    }}
                                  >
                                    <span>✓ شكراً لك، تم تسجيل ملاحظتك لتدريب مدام عفاف</span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setFeedbackState(prev => {
                                          const next = { ...prev };
                                          delete next[f.id];
                                          return next;
                                        })
                                      }
                                      className="underline cursor-pointer"
                                      style={{ color: 'var(--primary)' }}
                                    >
                                      إظهار الملاحظة مرة أخرى
                                    </button>
                                  </div>
                                );
                              }

                              return (
                                <article
                                  key={f.id}
                                  id={`finding-${f.id}`}
                                  className="p-3.5 sm:p-4 afaf-finding-card space-y-2.5 avoid-break"
                                  style={{
                                    borderInlineStartColor: sevStyle.fg
                                  }}
                                >
                                  {/* J2.1 Nested Sticky Finding Header */}
                                  <div
                                    className="afaf-sticky-nested-header py-1.5 border-b space-y-1.5"
                                    style={{
                                      backgroundColor: 'var(--surface)',
                                      borderColor: 'var(--border)'
                                    }}
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span
                                          className="px-2.5 py-0.5 border text-xs font-bold"
                                          style={{
                                            backgroundColor: sevStyle.bg,
                                            borderColor: sevStyle.fg,
                                            color: sevStyle.fg,
                                            borderRadius: 'var(--r-sm)'
                                          }}
                                        >
                                          {sevStyle.icon} {sevStyle.label}
                                        </span>

                                        <span
                                          className="px-2 py-0.5 border text-xs font-medium"
                                          style={{
                                            backgroundColor: 'var(--bg)',
                                            borderColor: 'var(--border)',
                                            color: 'var(--ink)',
                                            borderRadius: 'var(--r-sm)'
                                          }}
                                        >
                                          {CONFIDENCE_LABELS[f.confidence] || f.confidence}
                                        </span>

                                        <span
                                          className="px-2 py-0.5 border text-xs font-medium"
                                          style={{
                                            backgroundColor: 'var(--bg)',
                                            borderColor: 'var(--border)',
                                            color: 'var(--ink-muted)',
                                            borderRadius: 'var(--r-sm)'
                                          }}
                                        >
                                          {CATEGORY_LABELS[f.category] || f.category}
                                        </span>

                                        <span
                                          className="px-2 py-0.5 border text-xs font-medium"
                                          style={{
                                            backgroundColor: 'var(--surface-alt)',
                                            borderColor: 'var(--border)',
                                            color: 'var(--ink)',
                                            borderRadius: 'var(--r-sm)'
                                          }}
                                        >
                                          {METHOD_LABELS[f.method || 'static_html']}
                                        </span>

                                        <bdi
                                          dir="ltr"
                                          className="px-1.5 py-0.5 text-xs font-mono"
                                          style={{ color: 'var(--ink-muted)' }}
                                        >
                                          [{f.ruleId}]{f.occurrences > 1 ? ` (x${formatNumber(f.occurrences)})` : ''}
                                        </bdi>
                                      </div>
                                    </div>

                                    {/* Finding Title */}
                                    <h4 className="text-sm sm:text-base font-bold" style={{ color: 'var(--ink)' }}>
                                      {f.titleAr || f.title}
                                    </h4>
                                  </div>

                                  {/* A1 & J2.9: Human-readable `where` + "افتح الصفحة عند النص" text-fragment link */}
                                  <div
                                    className="p-2.5 border text-xs space-y-1.5"
                                    style={{
                                      backgroundColor: 'var(--surface-alt)',
                                      borderColor: 'var(--border)',
                                      borderRadius: 'var(--r-sm)'
                                    }}
                                  >
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 leading-relaxed">
                                      {targetUrl && (
                                        <span className="inline-flex items-center gap-1 min-w-0">
                                          <strong style={{ color: 'var(--ink)' }}>الصفحة:</strong>
                                          <a
                                            href={targetUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={targetUrl}
                                            className="afaf-url-wrap inline-flex items-center gap-1 font-bold hover:underline min-w-0"
                                            style={{ color: 'var(--primary)' }}
                                          >
                                            <bdi dir="ltr" className="truncate max-w-[160px] sm:max-w-[260px]">
                                              {formatDomainPathDisplay(targetUrl)}
                                            </bdi>
                                            <ExternalLink className="w-3 h-3 shrink-0" />
                                          </a>
                                          <button
                                            type="button"
                                            onClick={() => handleCopyUrl(targetUrl, `url-${f.id}`)}
                                            title="نسخ الرابط الكامل"
                                            aria-label="نسخ الرابط الكامل"
                                            className="no-print p-0.5 border cursor-pointer shrink-0"
                                            style={{
                                              backgroundColor: 'var(--surface)',
                                              borderColor: 'var(--border)',
                                              color: 'var(--ink)',
                                              borderRadius: 'var(--r-sm)'
                                            }}
                                          >
                                            {copiedUrlKey === `url-${f.id}` ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                                          </button>
                                        </span>
                                      )}
                                      <span style={{ color: 'var(--border-strong)' }}>|</span>
                                      <span>
                                        <strong style={{ color: 'var(--ink)' }}>المكان: </strong>
                                        <span className="font-bold" style={{ color: 'var(--ink)' }}>
                                          {f.where?.sectionAr || 'المحتوى الرئيسي'}
                                        </span>
                                      </span>
                                      <span style={{ color: 'var(--border-strong)' }}>|</span>
                                      {f.method === 'psi' || f.source === 'lighthouse' ? (
                                        <span>
                                          <strong style={{ color: 'var(--ink)' }}>العنصر: </strong>
                                          <bdi dir="ltr" className="font-mono font-medium" style={{ color: 'var(--ink-muted)' }}>
                                            {f.where?.selector || f.where?.visibleText || 'العنصر الرئيسي'}
                                          </bdi>
                                        </span>
                                      ) : (
                                        <span>
                                          <strong style={{ color: 'var(--ink)' }}>النص الظاهر: </strong>
                                          <span className="font-medium" style={{ color: 'var(--ink-muted)' }}>
                                            «{f.where?.visibleText || 'بدون نص ظاهر'}»
                                          </span>
                                        </span>
                                      )}
                                      {f.method !== 'psi' && f.source !== 'lighthouse' && textFragmentUrl && hasRealVisibleText(f.where?.visibleText) && (
                                        <>
                                          <span style={{ color: 'var(--border-strong)' }}>|</span>
                                          <a
                                            href={textFragmentUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title="قد لا يدعم كل متصفح تحديد النص تلقائياً"
                                            className="no-print inline-flex items-center gap-1 font-bold underline"
                                            style={{ color: 'var(--primary)' }}
                                          >
                                            <span>افتح الصفحة عند النص</span>
                                            <ExternalLink className="w-3 h-3 shrink-0" />
                                          </a>
                                        </>
                                      )}
                                    </div>
                                    {f.scope === 'site-wide' && f.pages && f.pages.length > 1 && (
                                      <div className="text-xs font-bold" style={{ color: 'var(--primary)' }}>
                                        عنصر مشترك في القالب (متكرر في <bdi dir="ltr">{formatNumber(f.pages.length)}</bdi> صفحات — محسوب مرة واحدة)
                                      </div>
                                    )}
                                  </div>

                                  {/* Anatomy Fields: اللي شفته / المفروض / إزاي تتأكد بنفسك / الحل */}
                                  <div className="space-y-1.5 text-sm sm:text-base">
                                    <p style={{ color: 'var(--ink)' }}>
                                      <strong className="font-bold">اللي شفته: </strong>
                                      <span>{f.observed}</span>
                                    </p>

                                    {f.whyItMattersAr && (
                                      <p style={{ color: 'var(--ink)' }}>
                                        <strong className="font-bold">ليه ده يهمك؟ </strong>
                                        <span style={{ color: 'var(--ink-muted)' }}>{f.whyItMattersAr}</span>
                                      </p>
                                    )}

                                    {f.expected && (
                                      <p style={{ color: 'var(--ink-muted)' }}>
                                        <strong className="font-bold" style={{ color: 'var(--ink)' }}>المفروض: </strong>
                                        <span>{f.expected}</span>
                                      </p>
                                    )}

                                    {f.steps && f.steps.length > 0 && (
                                      <p style={{ color: 'var(--ink-muted)' }}>
                                        <strong className="font-bold" style={{ color: 'var(--ink)' }}>إزاي تتأكد بنفسك: </strong>
                                        <span>{f.steps.join(' ← ')}</span>
                                      </p>
                                    )}

                                    <div
                                      className="p-2.5 border"
                                      style={{
                                        backgroundColor: 'var(--bg)',
                                        borderColor: 'var(--border)',
                                        borderRadius: 'var(--r-sm)'
                                      }}
                                    >
                                      <strong className="font-bold block mb-0.5" style={{ color: 'var(--primary)' }}>
                                        الحل ({getPlatformLabelAr(profile)}):
                                      </strong>
                                      <span style={{ color: 'var(--ink)' }}>{f.recommendedFix}</span>
                                    </div>
                                  </div>

                                  {/* EvidenceBlock: Raw code only inside "تفاصيل تقنية للمبرمج" */}
                                  {firstEvidence && (
                                    <div>
                                      <button
                                        type="button"
                                        onClick={() => toggleEvidenceExpanded(f.id)}
                                        aria-expanded={isEvidenceOpen}
                                        className="no-print inline-flex items-center gap-1 text-xs font-bold cursor-pointer mb-1"
                                        style={{ color: 'var(--ink-muted)' }}
                                      >
                                        {isEvidenceOpen ? (
                                          <ChevronUp className="w-3.5 h-3.5" />
                                        ) : (
                                          <ChevronDown className="w-3.5 h-3.5" />
                                        )}
                                        <span>
                                          {isEvidenceOpen
                                            ? 'إخفاء تفاصيل تقنية للمبرمج — الدليل (الكود المرصود)'
                                            : 'تفاصيل تقنية للمبرمج — الدليل (الكود المرصود)'}
                                        </span>
                                      </button>

                                      <div
                                        className={`evidence-collapse evidence-block p-2.5 border font-mono text-xs ${
                                          isEvidenceOpen ? 'block' : 'hidden'
                                        }`}
                                        style={{
                                          backgroundColor: 'var(--surface-alt)',
                                          borderColor: 'var(--border-strong)',
                                          color: 'var(--ink)',
                                          borderRadius: 'var(--r-sm)'
                                        }}
                                        dir="ltr"
                                      >
                                        <div className="flex items-center justify-between gap-2 pb-1 mb-1 border-b" style={{ borderColor: 'var(--border)' }}>
                                          <span className="font-bold">
                                            EVIDENCE ({f.ruleId})
                                            {f.where?.selector ? ` · ${f.where.selector}` : locationHint ? ` · ${locationHint}` : ''}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => copyEvidenceSnippet(f.id, firstEvidence)}
                                            className="no-print px-2 py-0.5 border text-xs font-sans font-bold cursor-pointer"
                                            style={{
                                              backgroundColor: 'var(--surface)',
                                              borderColor: 'var(--border)',
                                              color: 'var(--primary)',
                                              borderRadius: 'var(--r-sm)'
                                            }}
                                          >
                                            {copiedEvidenceId === f.id ? 'اتنسخ ✓' : 'نسخ الدليل'}
                                          </button>
                                        </div>
                                        {f.where?.snippet && (
                                          <pre className="afaf-url-wrap whitespace-pre-wrap leading-relaxed pb-1 mb-1 border-b" style={{ borderColor: 'var(--border)' }}>
                                            {f.where.snippet}
                                          </pre>
                                        )}
                                        {f.evidence.map((ev, eIdx) => (
                                          <pre key={eIdx} className="afaf-url-wrap whitespace-pre-wrap leading-relaxed">
                                            {ev.id ? `[${ev.id}] ` : ''}
                                            {ev.value || ev.ref}
                                          </pre>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* Card Footer Buttons: Copy Fix + "الملاحظة دي صح؟" 👍/👎 */}
                                  <div
                                    className="no-print pt-2 border-t flex flex-wrap items-center justify-between gap-2"
                                    style={{ borderColor: 'var(--border)' }}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => copyIndividualFix(f)}
                                      className="min-h-[36px] px-3 py-1 border text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
                                      style={{
                                        backgroundColor: 'var(--surface-alt)',
                                        borderColor: 'var(--border-strong)',
                                        color: 'var(--ink)',
                                        borderRadius: 'var(--r-sm)'
                                      }}
                                    >
                                      {copiedFindingId === f.id ? (
                                        <>
                                          <Check className="w-3.5 h-3.5" style={{ color: 'var(--pass-fg)' }} />
                                          <span>تم نسخ الحل</span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3.5 h-3.5" />
                                          <span>نسخ الحل</span>
                                        </>
                                      )}
                                    </button>

                                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                      <span className="font-bold" style={{ color: 'var(--ink-muted)' }}>
                                        الملاحظة دي صح؟
                                      </span>
                                      <button
                                        type="button"
                                        onClick={() => handleVoteFeedback(f, 'up')}
                                        aria-label="الملاحظة دي صح - نعم"
                                        className="min-h-[36px] px-2.5 py-1 border font-bold inline-flex items-center gap-1 cursor-pointer"
                                        style={{
                                          backgroundColor: vote === 'up' ? 'var(--pass-bg)' : 'var(--surface)',
                                          borderColor: vote === 'up' ? 'var(--pass-fg)' : 'var(--border)',
                                          color: vote === 'up' ? 'var(--pass-fg)' : 'var(--ink)',
                                          borderRadius: 'var(--r-sm)'
                                        }}
                                      >
                                        <span>👍 صح</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleVoteFeedback(f, 'down')}
                                        aria-label="الملاحظة دي صح - لا غير دقيقة"
                                        className="min-h-[36px] px-2.5 py-1 border font-bold inline-flex items-center gap-1 cursor-pointer"
                                        style={{
                                          backgroundColor: 'var(--surface)',
                                          borderColor: 'var(--border)',
                                          color: 'var(--sev-critical-fg)',
                                          borderRadius: 'var(--r-sm)'
                                        }}
                                      >
                                        <span>👎 لأ</span>
                                      </button>
                                    </div>
                                  </div>
                                  {vote === 'up' && (
                                    <p className="text-xs font-bold" style={{ color: 'var(--pass-fg)' }}>
                                      ✓ تم حفظ تقييمك لتعزيز دقة الفحص.
                                    </p>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}


          {/* =================================================================
              (7) "اللي تمام": Passed Checks (Accordion)
          ================================================================= */}
          {!isStatusReportOnly && passes.length > 0 && (
            <section
              id="sec-passes"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <button
                type="button"
                onClick={() => toggleSection('passes')}
                aria-expanded={isSectionOpen('passes')}
                className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-2 text-start cursor-pointer select-none py-1"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <CheckCircle2 className="w-5 h-5 shrink-0" style={{ color: 'var(--pass-fg)' }} />
                  <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                    فحوصات عدّت (<bdi dir="ltr">{formatNumber(passes.length)}</bdi>)
                  </h2>
                </div>
                <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                  <span>{isSectionOpen('passes') ? 'طي' : 'عرض'}</span>
                  {isSectionOpen('passes') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </button>

              {isSectionOpen('passes') && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  {passes.map(p => (
                    <div
                      key={p.id}
                      className="p-3 border flex items-start gap-2.5"
                      style={{
                        backgroundColor: 'var(--pass-bg)',
                        borderColor: 'var(--pass-fg)',
                        borderRadius: 'var(--r-md)'
                      }}
                    >
                      <CheckCircle2 className="w-4 h-4 shrink-0 mt-1" style={{ color: 'var(--pass-fg)' }} />
                      <div className="min-w-0 text-sm">
                        <span className="font-bold block" style={{ color: 'var(--ink)' }}>
                          {p.titleAr}
                        </span>
                        {p.detailAr && (
                          <span className="text-xs block" style={{ color: 'var(--ink-muted)' }}>
                            {p.detailAr}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* =================================================================
              (8) "محتاج قرار منك": Needs Human Decision (Accordion)
          ================================================================= */}
          {!isStatusReportOnly && humanDecisionItems.length > 0 && (
            <section
              id="sec-decisions"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <button
                type="button"
                onClick={() => toggleSection('decisions')}
                aria-expanded={isSectionOpen('decisions')}
                className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-2 text-start cursor-pointer select-none py-1"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <HelpCircle className="w-5 h-5 shrink-0" style={{ color: 'var(--sev-medium-fg)' }} />
                  <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                    محتاج قرار منك (<bdi dir="ltr">{formatNumber(humanDecisionItems.length)}</bdi>)
                  </h2>
                </div>
                <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                  <span>{isSectionOpen('decisions') ? 'طي' : 'عرض'}</span>
                  {isSectionOpen('decisions') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </button>

              {isSectionOpen('decisions') && (
                <div className="space-y-2.5 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  {humanDecisionItems.map(item => (
                    <div
                      key={`dec_${item.id}`}
                      className="p-3 border text-sm space-y-1"
                      style={{
                        backgroundColor: 'var(--sev-medium-bg)',
                        borderColor: 'var(--sev-medium-fg)',
                        borderRadius: 'var(--r-md)'
                      }}
                    >
                      <span className="font-bold block" style={{ color: 'var(--ink)' }}>
                        • {item.titleAr || item.title}
                      </span>
                      <p className="text-xs sm:text-sm" style={{ color: 'var(--ink-muted)' }}>{item.recommendedFix}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* =================================================================
              (9) "ما اتقاسش": Honest NOT_MEASURED Section (J2.6 3-Line Format + "قريبًا" Chips)
          ================================================================= */}
          {!isStatusReportOnly && (
            <section
              id="sec-not-measured"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <button
                type="button"
                onClick={() => toggleSection('not-measured')}
                aria-expanded={isSectionOpen('not-measured')}
                className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-2 text-start cursor-pointer select-none py-1"
                style={{ backgroundColor: 'var(--surface)' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <EyeOff className="w-5 h-5 shrink-0" style={{ color: 'var(--ink-muted)' }} />
                  <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                    ما اتقاسش (<bdi dir="ltr">{formatNumber(notMeasured.length)}</bdi>)
                  </h2>
                </div>
                <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                  <span>{isSectionOpen('not-measured') ? 'طي' : 'عرض'}</span>
                  {isSectionOpen('not-measured') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </div>
              </button>

              {isSectionOpen('not-measured') && (
                <div className="space-y-3 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  {notMeasured.map(nm => {
                    const threeLines = getNotMeasuredThreeLines(nm);
                    return (
                      <div
                        key={nm.id}
                        className="p-3.5 border text-sm space-y-2"
                        style={{
                          backgroundColor: 'var(--bg)',
                          borderColor: 'var(--border)',
                          borderRadius: 'var(--r-md)'
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-bold block" style={{ color: 'var(--ink)' }}>
                            {nm.titleAr}
                          </span>
                          <span
                            className="px-2 py-0.5 border text-xs font-bold shrink-0"
                            style={{
                              backgroundColor: 'var(--sev-low-bg)',
                              borderColor: 'var(--sev-low-fg)',
                              color: 'var(--sev-low-fg)',
                              borderRadius: 'var(--r-sm)'
                            }}
                          >
                            {nm.chipAr || 'قريبًا'}
                          </span>
                        </div>

                        <div className="space-y-1 text-xs sm:text-sm" style={{ color: 'var(--ink-muted)' }}>
                          <p>
                            <strong style={{ color: 'var(--ink)' }}>ليه ما اتقاسش؟ </strong>
                            <span>{threeLines.whyNotMeasuredAr}</span>
                          </p>
                          <p>
                            <strong style={{ color: 'var(--ink)' }}>إزاي هتشتغل؟ </strong>
                            <span>{threeLines.howItWillWorkAr}</span>
                          </p>
                          <p>
                            <strong style={{ color: 'var(--ink)' }}>إمتى؟ </strong>
                            <span>{threeLines.whenAr}</span>
                          </p>
                        </div>
                      </div>
                    );
                  })}

                  {/* J2.6 Upcoming Capabilities with disabled "قريبًا" chips + one plain line each */}
                  <div
                    className="p-3.5 border space-y-2"
                    style={{
                      backgroundColor: 'var(--surface-alt)',
                      borderColor: 'var(--border)',
                      borderRadius: 'var(--r-md)'
                    }}
                  >
                    <span className="text-xs font-bold block" style={{ color: 'var(--ink)' }}>
                      قدرات جاية في الطريق:
                    </span>
                    <ul className="space-y-2 text-xs sm:text-sm">
                      {[
                        'فحص التجاوب الفعلي في متصفح حي للتأكد إن مفيش عنصر بيخرج بره شاشة الموبايل.',
                        'تجربة الضغط الفعلي على أزرار اللغات والقوائم والفورم للتأكد إنها شغالة.',
                        'توليد ملف PDF مباشر من السيرفر بضغطة واحدة من غير نافذة الطباعة.',
                        'فحص عميق يغطي كل صفحات الموقع بالكامل بعد عينة الـ 10 صفحات الأولى.'
                      ].map((capLine, idx) => (
                        <li key={idx} className="flex items-start justify-between gap-2">
                          <span style={{ color: 'var(--ink)' }}>• {capLine}</span>
                          <span
                            aria-disabled="true"
                            className="px-2 py-0.5 border text-xs font-bold shrink-0 opacity-75 select-none"
                            style={{
                              backgroundColor: 'var(--surface)',
                              borderColor: 'var(--border-strong)',
                              color: 'var(--ink-muted)',
                              borderRadius: 'var(--r-sm)'
                            }}
                          >
                            قريبًا
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* =================================================================
              (9.5) COLLAPSIBLE TECHNICAL DETAILS SECTION ("تفاصيل تقنية للمبرمج")
          ================================================================= */}
          <section
            id="sec-technical-details"
            className="p-4 sm:p-5 border avoid-break"
            style={{
              backgroundColor: 'var(--surface)',
              borderColor: showTechnicalDetails ? 'var(--primary)' : 'var(--border)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--sh-1)'
            }}
          >
            <button
              type="button"
              onClick={() => setShowTechnicalDetails(!showTechnicalDetails)}
              className="afaf-sticky-accordion-header w-full flex items-center justify-between gap-3 text-start cursor-pointer select-none py-1"
              style={{ backgroundColor: 'var(--surface)' }}
              aria-expanded={showTechnicalDetails}
              aria-controls="technical-details-content"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Code2 className="w-5 h-5 shrink-0" style={{ color: 'var(--primary)' }} />
                <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                  تفاصيل تقنية للمبرمج
                </h2>
              </div>

              <div className="flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                <span>{showTechnicalDetails ? 'طي' : 'عرض'}</span>
                {showTechnicalDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </div>
            </button>

            {showTechnicalDetails && (
              <div id="technical-details-content" className="space-y-4 pt-4 mt-3 border-t text-sm" style={{ borderColor: 'var(--border)' }}>
                <div
                  className="p-3 border space-y-2"
                  style={{
                    backgroundColor: 'var(--surface-alt)',
                    borderColor: 'var(--border)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono" dir="ltr">
                    <div className="p-2 border bg-[var(--surface)] rounded-[var(--r-sm)]">
                      <span className="block text-xs text-[var(--ink-muted)]">Target URL</span>
                      <span className="font-bold truncate block">{result.finalUrl || result.requestedUrl}</span>
                    </div>
                    <div className="p-2 border bg-[var(--surface)] rounded-[var(--r-sm)]">
                      <span className="block text-xs text-[var(--ink-muted)]">Pages Budget</span>
                      <span className="font-bold text-[var(--primary)]">
                        {formatNumber(result.uniquePagesInspected)} / {formatNumber(result.limits?.maxPages || 10)}
                      </span>
                    </div>
                    <div className="p-2 border bg-[var(--surface)] rounded-[var(--r-sm)]">
                      <span className="block text-xs text-[var(--ink-muted)]">Platform</span>
                      <span className="font-bold">{result.siteProfile?.platform || 'Standard'}</span>
                    </div>
                    <div className="p-2 border bg-[var(--surface)] rounded-[var(--r-sm)]">
                      <span className="block text-xs text-[var(--ink-muted)]">Ruleset</span>
                      <span className="font-bold text-[var(--pass-fg)]">v{result.rulesetVersion || '2.0.0'}</span>
                    </div>
                  </div>
                </div>

                {result.capabilities && (
                  <div
                    className="p-3 border font-mono text-xs space-y-1"
                    style={{
                      backgroundColor: 'var(--bg)',
                      borderColor: 'var(--border)',
                      borderRadius: 'var(--r-sm)'
                    }}
                    dir="ltr"
                  >
                    <div className="font-bold text-[var(--ink)]">Engine Capabilities:</div>
                    <div className="text-xs text-[var(--ink-muted)] leading-relaxed">
                      serverFetch: {String(result.capabilities.serverFetch)} |
                      htmlParser: {String(result.capabilities.htmlParser)} |
                      headRequests: {String(result.capabilities.headRequests)} |
                      psi: {String(result.capabilities.psi)} |
                      browserRendering: {String(result.capabilities.browserRendering)}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* =================================================================
              (10) FIX PACK: Platform-Aware Human Checklist + AI Coding Tool Prompt (Accordion)
          ================================================================= */}
          {!isStatusReportOnly && (
            <section
              id="sec-fix-pack"
              className="p-4 sm:p-5 border avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--primary)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggleSection('fix-pack')}
                  aria-expanded={isSectionOpen('fix-pack')}
                  className="flex-1 flex items-center justify-between gap-2 text-start cursor-pointer select-none min-w-[200px]"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <ListChecks className="w-5 h-5 shrink-0" style={{ color: 'var(--primary)' }} />
                    <h2 className="text-base sm:text-lg font-bold break-words" style={{ color: 'var(--ink)' }}>
                      خطة الإصلاح وبرومبت المطور ({getPlatformLabelAr(profile)})
                    </h2>
                  </div>
                  <div className="no-print flex items-center gap-1 text-xs font-bold shrink-0" style={{ color: 'var(--primary)' }}>
                    <span>{isSectionOpen('fix-pack') ? 'طي' : 'عرض'}</span>
                    {isSectionOpen('fix-pack') ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </div>
                </button>

                {result.masterRepairPrompt && (
                  <button
                    type="button"
                    onClick={copyMasterPrompt}
                    className="no-print min-h-[40px] px-3.5 py-1.5 text-xs font-bold flex items-center gap-1.5 cursor-pointer"
                    style={{
                      backgroundColor: 'var(--primary)',
                      color: 'var(--on-primary)',
                      borderRadius: 'var(--r-sm)'
                    }}
                  >
                    {copiedMaster ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedMaster ? 'تم النسخ ✓' : 'انسخ خطة الإصلاح'}</span>
                  </button>
                )}
              </div>

              {isSectionOpen('fix-pack') && (
                <div className="space-y-4 pt-4 mt-3 border-t" style={{ borderColor: 'var(--border)' }}>
                  {result.cmsChecklistItems && result.cmsChecklistItems.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-bold" style={{ color: 'var(--ink)' }}>
                        أولاً: خطوات سريعة ({getPlatformLabelAr(profile)}):
                      </h3>
                      <ul className="space-y-1.5 text-xs sm:text-sm">
                        {result.cmsChecklistItems.map((item, idx) => (
                          <li
                            key={idx}
                            className="p-2.5 border font-medium break-words"
                            style={{
                              backgroundColor: 'var(--bg)',
                              borderColor: 'var(--border)',
                              color: 'var(--ink)',
                              borderRadius: 'var(--r-sm)'
                            }}
                          >
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {result.masterRepairPrompt && (
                    <div className="space-y-1.5">
                      <h3 className="text-sm font-bold" style={{ color: 'var(--ink)' }}>
                        ثانياً: برومبت الإصلاح للمبرمج أو أداة الـ AI (~<bdi dir="ltr">{masterTokens}</bdi> توكن):
                      </h3>
                      <pre
                        className="p-3 border font-mono text-xs whitespace-pre-wrap overflow-x-auto max-h-64"
                        style={{
                          backgroundColor: 'var(--surface-alt)',
                          borderColor: 'var(--border-strong)',
                          color: 'var(--ink)',
                          borderRadius: 'var(--r-md)'
                        }}
                        dir="auto"
                      >
                        {result.masterRepairPrompt}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* =================================================================
              (11) RESCAN COMPARISON (Resolved / Still Open / New)
          ================================================================= */}
          {result.rescanComparison && (
            <section
              id="sec-rescan"
              className="p-4 sm:p-5 border space-y-3 avoid-break"
              style={{
                backgroundColor: 'var(--surface)',
                borderColor: 'var(--border)',
                borderRadius: 'var(--r-lg)',
                boxShadow: 'var(--sh-1)'
              }}
            >
              <div className="flex items-center gap-2 border-b pb-2.5" style={{ borderColor: 'var(--border)' }}>
                <History className="w-5 h-5 shrink-0" style={{ color: 'var(--primary)' }} />
                <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                  مقارنة بالفحص السابق لنفس الموقع
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                <div
                  className="p-3 border"
                  style={{
                    backgroundColor: 'var(--pass-bg)',
                    borderColor: 'var(--pass-fg)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <span className="font-bold block mb-1" style={{ color: 'var(--pass-fg)' }}>
                    اتحلت (<bdi dir="ltr">{formatNumber(result.rescanComparison.resolvedRuleIds.length)}</bdi>) ✓
                  </span>
                  {result.rescanComparison.resolvedRuleIds.length === 0 ? (
                    <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>لا يوجد</span>
                  ) : (
                    result.rescanComparison.resolvedRuleIds.map((r, i) => (
                      <div key={i} className="text-xs font-medium break-words" style={{ color: 'var(--ink)' }}>
                        • {r.titleAr}
                      </div>
                    ))
                  )}
                </div>

                <div
                  className="p-3 border"
                  style={{
                    backgroundColor: 'var(--sev-medium-bg)',
                    borderColor: 'var(--sev-medium-fg)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <span className="font-bold block mb-1" style={{ color: 'var(--sev-medium-fg)' }}>
                    لسه مفتوحة (<bdi dir="ltr">{formatNumber(result.rescanComparison.stillOpenRuleIds.length)}</bdi>)
                  </span>
                  {result.rescanComparison.stillOpenRuleIds.length === 0 ? (
                    <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>لا يوجد</span>
                  ) : (
                    result.rescanComparison.stillOpenRuleIds.map((r, i) => (
                      <div key={i} className="text-xs font-medium break-words" style={{ color: 'var(--ink)' }}>
                        • {r.titleAr}
                      </div>
                    ))
                  )}
                </div>

                <div
                  className="p-3 border"
                  style={{
                    backgroundColor: 'var(--sev-critical-bg)',
                    borderColor: 'var(--sev-critical-fg)',
                    borderRadius: 'var(--r-md)'
                  }}
                >
                  <span className="font-bold block mb-1" style={{ color: 'var(--sev-critical-fg)' }}>
                    ظهرت جديد (<bdi dir="ltr">{formatNumber(result.rescanComparison.newRuleIds.length)}</bdi>)
                  </span>
                  {result.rescanComparison.newRuleIds.length === 0 ? (
                    <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>لا يوجد</span>
                  ) : (
                    result.rescanComparison.newRuleIds.map((r, i) => (
                      <div key={i} className="text-xs font-medium break-words" style={{ color: 'var(--ink)' }}>
                        • {r.titleAr}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          )}

          {/* =================================================================
              (12) FOOTER: Methods, Capabilities, Limitations, Disclaimer (P2b.8)
          ================================================================= */}
          <footer
            id="sec-scan-limits"
            className="p-4 sm:p-5 border text-xs sm:text-sm space-y-2.5 avoid-break"
            style={{
              backgroundColor: 'var(--surface-alt)',
              borderColor: 'var(--border-strong)',
              color: 'var(--ink)',
              borderRadius: 'var(--r-md)'
            }}
          >
            <div className="font-bold flex items-center gap-2 text-sm sm:text-base" style={{ color: 'var(--primary)' }}>
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>حدود الفحص</span>
            </div>
            <p className="leading-relaxed font-medium" style={{ color: 'var(--ink)' }}>
              عينة لحد 10 صفحات عامة؛ مفيش فحص لمناطق تسجيل الدخول؛ مفيش اختبار دفع أو طلبات أو إرسال نماذج؛ مفيش اختبار تحمل؛ مفيش مراجعة للسيرفر أو قاعدة البيانات أو الصلاحيات؛ الفحص من كود الصفحة وقياسات جوجل المعملية؛ النتيجة مش ضمان.
            </p>
            <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
              • الفحص بيعكس حالة الصفحات العامة أثناء لحظة الزيارة فقط، والقياسات المعملية مش بالضرورة اللي بيشوفه كل زائر حقيقي.
            </p>
            <div className="pt-2.5 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-2 text-xs">
              <span
                data-testid="footer-alpha-badge"
                className="font-bold text-[var(--primary)] bg-[var(--surface)] px-2.5 py-1 rounded-[var(--r-sm)] border border-[var(--border)]"
              >
                {RELEASE_CONFIG.badgeTextAr}
              </span>
              <div className="flex items-center gap-3 font-medium">
                <a href="/privacy" className="underline hover:text-[var(--primary)] text-[var(--ink)]">
                  الخصوصية
                </a>
                <span className="text-[var(--border-strong)]">•</span>
                <a href="/terms" className="underline hover:text-[var(--primary)] text-[var(--ink)]">
                  الشروط
                </a>
              </div>
            </div>
          </footer>
        </div>
      </div>
      </div>

      {/* K1.1 & J2.3 Icon-only "برومبت الإصلاح الشامل" button replaced by B2.2 Dock */}
      {!isStatusReportOnly && toolbarScrolledOut && (
        <div
          className="hidden"
          style={{ bottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <button
            type="button"
            data-testid="floating-master-prompt-btn"
            aria-label="برومبت الإصلاح الشامل"
            title="برومبت الإصلاح الشامل"
            onClick={() => setShowMasterPromptSheet(true)}
            className="w-11 h-11 border flex items-center justify-center cursor-pointer transition-transform active:scale-95"
            style={{
              backgroundColor: 'var(--primary)',
              borderColor: 'var(--on-primary)',
              color: 'var(--on-primary)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--sh-3)'
            }}
          >
            <ListChecks className="w-5 h-5 shrink-0" />
          </button>
        </div>
      )}

      {/* J2.3 Two-Tab Sheet ("للـ AI" & "تقرير لمبرمج") + "المؤكد فقط" toggle */}
      {showMasterPromptSheet && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="برومبت الإصلاح الشامل وتقرير المبرمج"
          className="no-print fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
        >
          <div
            className="w-full sm:max-w-2xl max-h-[88vh] flex flex-col border overflow-hidden"
            style={{
              backgroundColor: 'var(--surface)',
              borderColor: 'var(--border-strong)',
              borderRadius: 'var(--r-lg)',
              boxShadow: 'var(--sh-3)'
            }}
          >
            <div
              className="p-4 border-b flex items-center justify-between gap-2"
              style={{
                backgroundColor: 'var(--surface-alt)',
                borderColor: 'var(--border)'
              }}
            >
              <div className="flex items-center gap-2">
                <FileCode2 className="w-5 h-5 shrink-0" style={{ color: 'var(--primary)' }} />
                <h2 className="text-base sm:text-lg font-bold" style={{ color: 'var(--ink)' }}>
                  برومبت الإصلاح الشامل وتقرير المبرمج
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowMasterPromptSheet(false)}
                aria-label="إغلاق نافذة برومبت الإصلاح"
                className="p-2 cursor-pointer"
                style={{ color: 'var(--ink-muted)' }}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tabs + "المؤكد فقط" Toggle */}
            <div
              className="px-4 py-2.5 border-b flex flex-wrap items-center justify-between gap-2"
              style={{ borderColor: 'var(--border)' }}
            >
              <div className="flex items-center gap-2" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={masterSheetTab === 'ai'}
                  onClick={() => setMasterSheetTab('ai')}
                  className="min-h-[40px] px-3.5 py-1.5 border text-xs sm:text-sm font-bold cursor-pointer"
                  style={{
                    backgroundColor: masterSheetTab === 'ai' ? 'var(--primary)' : 'var(--bg)',
                    borderColor: masterSheetTab === 'ai' ? 'var(--primary)' : 'var(--border)',
                    color: masterSheetTab === 'ai' ? 'var(--on-primary)' : 'var(--ink)',
                    borderRadius: 'var(--r-sm)'
                  }}
                >
                  للـ AI
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={masterSheetTab === 'dev'}
                  onClick={() => setMasterSheetTab('dev')}
                  className="min-h-[40px] px-3.5 py-1.5 border text-xs sm:text-sm font-bold cursor-pointer"
                  style={{
                    backgroundColor: masterSheetTab === 'dev' ? 'var(--primary)' : 'var(--bg)',
                    borderColor: masterSheetTab === 'dev' ? 'var(--primary)' : 'var(--border)',
                    color: masterSheetTab === 'dev' ? 'var(--on-primary)' : 'var(--ink)',
                    borderRadius: 'var(--r-sm)'
                  }}
                >
                  تقرير لمبرمج
                </button>
              </div>

              <label className="inline-flex items-center gap-2 text-xs sm:text-sm font-bold cursor-pointer select-none" style={{ color: 'var(--ink)' }}>
                <input
                  type="checkbox"
                  checked={confirmedOnlyPrompt}
                  onChange={e => setConfirmedOnlyPrompt(e.target.checked)}
                  className="w-4 h-4 accent-[var(--primary)] cursor-pointer"
                />
                <span>المؤكد فقط</span>
              </label>
            </div>

            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              {masterSheetTab === 'ai' ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs sm:text-sm font-bold" style={{ color: 'var(--ink-muted)' }}>
                      انسخ البرومبت ده وحطه في أداة الـ AI بتاعتك (~<bdi dir="ltr">{formatNumber(masterTokens)}</bdi> توكن):
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyActiveAiPrompt}
                      className="min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
                      style={{
                        backgroundColor: 'var(--primary)',
                        color: 'var(--on-primary)',
                        borderRadius: 'var(--r-sm)'
                      }}
                    >
                      {copiedMaster ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      <span>{copiedMaster ? 'تم نسخ البرومبت ✓' : 'نسخ البرومبت'}</span>
                    </button>
                  </div>
                  <pre
                    className="p-3.5 border font-mono text-xs whitespace-pre-wrap overflow-x-auto max-h-[52vh]"
                    style={{
                      backgroundColor: 'var(--surface-alt)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--ink)',
                      borderRadius: 'var(--r-md)'
                    }}
                    dir="auto"
                  >
                    {activeAiMasterPrompt || 'لا توجد ملاحظات مطابقة للفلتر الحالي.'}
                  </pre>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs sm:text-sm font-bold" style={{ color: 'var(--ink-muted)' }}>
                      تقرير تسليم كامل بصيغة Markdown (الملخص + الملاحظات بالمكان والدليل + قائمة التحقق):
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleCopyDeveloperMarkdown}
                        className="min-h-[40px] px-3.5 py-1.5 text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
                        style={{
                          backgroundColor: 'var(--primary)',
                          color: 'var(--on-primary)',
                          borderRadius: 'var(--r-sm)'
                        }}
                      >
                        {copiedDevMarkdown ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        <span>{copiedDevMarkdown ? 'تم النسخ ✓' : 'نسخ Markdown'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadDeveloperMarkdown}
                        className="min-h-[40px] px-3.5 py-1.5 border text-xs sm:text-sm font-bold inline-flex items-center gap-1.5 cursor-pointer"
                        style={{
                          backgroundColor: 'var(--surface-alt)',
                          borderColor: 'var(--border-strong)',
                          color: 'var(--ink)',
                          borderRadius: 'var(--r-sm)'
                        }}
                      >
                        <Download className="w-4 h-4" />
                        <span>تحميل .md</span>
                      </button>
                    </div>
                  </div>
                  <pre
                    className="p-3.5 border font-mono text-xs whitespace-pre-wrap overflow-x-auto max-h-[52vh]"
                    style={{
                      backgroundColor: 'var(--surface-alt)',
                      borderColor: 'var(--border-strong)',
                      color: 'var(--ink)',
                      borderRadius: 'var(--r-md)'
                    }}
                    dir="auto"
                  >
                    {activeDeveloperMarkdown}
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
