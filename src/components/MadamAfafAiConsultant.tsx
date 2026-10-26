import React, { useState, useRef, useEffect } from 'react';
import {
  Send,
  User,
  Copy,
  Check,
  Terminal,
  RefreshCw,
  Mic,
  Volume2,
  VolumeX,
  Loader2,
  Square,
  X
} from 'lucide-react';
import { ChatContext, ChatMessage, buildContextFromScanResult, NO_SITE_SCANNED_PROMPT } from '../lib/chat-context';
import { ScanResult } from '../types/contract';
import {
  speakMadamText,
  stopMadamSpeech,
  startVoiceInput,
  VoiceRecognitionSession
} from '../lib/voice-client';
import { MadamAfafAvatar } from './MadamAfafAvatar';
import { FULL_SCANS_STORAGE_KEY } from '../lib/scan-lifecycle';
import { sendMadamChatMessage } from '../lib/chat-client';

interface MadamAfafAiConsultantProps {
  context?: ChatContext;
  scanResult?: ScanResult | null;
  isScanning?: boolean;
  onTriggerScan?: (url: string) => void;
  initialMessage?: string;
  compact?: boolean;
}

const POST_SCAN_QUICK_PROMPTS = [
  { label: 'أهم المشاكل إيه؟', text: 'إيه أهم المشاكل والأولويات في تقرير الموقع؟' },
  { label: 'هاتي خطة الإصلاح', text: 'اديني خطة الإصلاح والبرومبت الجاهز للموقع' },
  { label: 'إيه اللي ما اتقاسش؟', text: 'إيه الحاجات اللي ما اتقاسّتش في الفحص ده؟' }
];

const PRE_SCAN_SAMPLE_URLS = [
  { label: 'خدماتكم إيه؟', text: 'إيه الخدمات اللي بتقدموها في فحص وتطوير المواقع؟' },
  { label: 'إزاي أفحص موقعي؟', text: 'إزاي أضيف موقعي عشان تفحصيه بالدليل؟' },
  { label: 'افحصي elabyad-eg.com', text: 'https://elabyad-eg.com' }
];

const VOICE_STUDIO_QUICK_SPEECH = [
  { label: '«افحصي موقع example.com»', text: 'افحصي موقع example.com' },
  { label: '«إيه أهم مشكلة في موقعي؟»', text: 'إيه أهم مشكلة في موقعي وإزاي أصلحها؟' },
  { label: '«هاتي خطة الإصلاح»', text: 'اديني البرومبت الشامل اللي يصلح مشاكل موقعي' }
];

function getLatestStoredScan(): ScanResult | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(FULL_SCANS_STORAGE_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length > 0 && list[0]?.scanId) {
      return list[0] as ScanResult;
    }
  } catch {
    // ignore
  }
  return null;
}

export const MadamAfafAiConsultant: React.FC<MadamAfafAiConsultantProps> = ({
  context,
  scanResult,
  isScanning = false,
  onTriggerScan,
  initialMessage,
  compact = false
}) => {
  const effectiveScanResult = scanResult !== undefined ? scanResult : getLatestStoredScan();
  const effectiveContext = effectiveScanResult
    ? buildContextFromScanResult(effectiveScanResult)
    : context;
  const reviewedDomain =
    effectiveScanResult?.registrableDomain ||
    effectiveContext?.domain ||
    effectiveScanResult?.finalUrl ||
    effectiveScanResult?.requestedUrl ||
    effectiveContext?.url ||
    '';
  const hasScannedSite = Boolean(reviewedDomain);

  const defaultGreeting = hasScannedSite
    ? initialMessage ||
      `أهلًا بيك، أنا راجعت (${reviewedDomain}) بالدليل وفحصت ${
        effectiveScanResult?.uniquePagesInspected || effectiveContext?.pagesCount || 1
      } صفحات. اسألني عن أي مشكلة أو أولوية في التقرير.`
    : NO_SITE_SCANNED_PROMPT;

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: defaultGreeting
    }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [copiedMasterInChat, setCopiedMasterInChat] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [micMode, setMicMode] = useState<'idle' | 'toggle' | 'holding'>('idle');
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [showVoiceStudio, setShowVoiceStudio] = useState(false);
  const [interimVoiceText, setInterimVoiceText] = useState('');
  const [voiceErrorMsg, setVoiceErrorMsg] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const voiceSessionRef = useRef<VoiceRecognitionSession | null>(null);
  const lastAnnouncedScanIdRef = useRef<string | null>(null);
  const pressStartMsRef = useRef<number | null>(null);
  const holdTimerRef = useRef<NodeJS.Timeout | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, isScanning, showVoiceStudio, isListening, micMode]);

  useEffect(() => {
    return () => {
      stopMadamSpeech();
      voiceSessionRef.current?.stop();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  // Recording duration timer for clear user feedback
  useEffect(() => {
    if (!isListening) {
      setRecordingSeconds(0);
      setMicMode('idle');
      return;
    }
    const timer = setInterval(() => {
      setRecordingSeconds(s => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isListening]);

  // Announce completed scan in chat
  useEffect(() => {
    if (scanResult && scanResult.scanId !== lastAnnouncedScanIdRef.current) {
      lastAnnouncedScanIdRef.current = scanResult.scanId;

      const summaryLine =
        scanResult.summaryAr ||
        `خلصت مراجعة (${scanResult.registrableDomain}) بالدليل: فحصت ${scanResult.uniquePagesInspected} صفحات وطلعت ${scanResult.findings.length} ملاحظات.`;

      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: summaryLine
        }
      ]);

      if (autoSpeak) {
        speakMadamText(summaryLine, {
          onStart: () => setIsSpeaking(true),
          onEnd: () => setIsSpeaking(false)
        });
      }
    }
  }, [scanResult, autoSpeak]);

  const handleSpeakMessage = (text: string) => {
    if (isSpeaking) {
      stopMadamSpeech();
      setIsSpeaking(false);
      return;
    }
    speakMadamText(text, {
      onStart: () => setIsSpeaking(true),
      onEnd: () => setIsSpeaking(false)
    });
  };

  const startRecordingSession = (initialMode: 'toggle' | 'holding' = 'toggle') => {
    setVoiceErrorMsg(null);
    setInterimVoiceText('');
    setShowVoiceStudio(true);
    setIsListening(true);
    setMicMode(initialMode);

    voiceSessionRef.current = startVoiceInput({
      onInterim: interim => {
        setInterimVoiceText(interim);
        setInput(interim);
      },
      onResult: transcript => {
        setInterimVoiceText('');
        setShowVoiceStudio(false);
        setIsListening(false);
        setMicMode('idle');
        setInput(transcript);
        handleSend(transcript);
      },
      onError: msg => {
        setVoiceErrorMsg(msg);
        setIsListening(false);
        setMicMode('idle');
      },
      onEnd: () => {
        setIsListening(false);
        setMicMode('idle');
      },
      onFallbackStudio: () => {
        setIsListening(false);
        setMicMode('idle');
        setShowVoiceStudio(true);
      }
    });
  };

  const finishAndSendRecording = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (voiceSessionRef.current) {
      voiceSessionRef.current.finishAndSend();
    }
    setIsListening(false);
    setMicMode('idle');
    // If interim text was already typed into input and SpeechRecognition didn't fire onResult yet:
    if (interimVoiceText.trim()) {
      const textToSend = interimVoiceText.trim();
      setInterimVoiceText('');
      setShowVoiceStudio(false);
      handleSend(textToSend);
    }
  };

  const cancelRecording = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    voiceSessionRef.current?.stop();
    setIsListening(false);
    setMicMode('idle');
    setInterimVoiceText('');
    setShowVoiceStudio(false);
  };

  /**
   * Dual-Mode Microphone:
   * Mode A: Click once to record hands-free, click again to stop & submit.
   * Mode B: Press and hold to record, release to stop & submit immediately.
   */
  const handleMicPointerDown = () => {
    if (loading || isScanning) return;

    if (isListening) {
      // User tapped the mic button while already recording in toggle mode -> stop & submit!
      finishAndSendRecording();
      return;
    }

    pressStartMsRef.current = Date.now();
    startRecordingSession('toggle');

    // If the pointer stays held for >380ms, seamlessly promote to "holding" mode
    holdTimerRef.current = setTimeout(() => {
      setMicMode('holding');
    }, 380);
  };

  const handleMicPointerUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    if (!isListening) return;

    // Check if the user was holding
    if (micMode === 'holding' || (pressStartMsRef.current && Date.now() - pressStartMsRef.current >= 380)) {
      // User held the button continuously and just released it -> submit immediately!
      pressStartMsRef.current = null;
      finishAndSendRecording();
    } else {
      // User performed a single quick click (<380ms) -> keep recording open in toggle mode!
      pressStartMsRef.current = null;
      setMicMode('toggle');
    }
  };

  const handleSend = async (messageToSend?: string) => {
    const text = (messageToSend ?? input).trim();
    if (!text || loading || isScanning) return;

    setShowVoiceStudio(false);
    setInterimVoiceText('');
    setVoiceErrorMsg(null);
    const userMsg: ChatMessage = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    const activeScanResult = scanResult !== undefined ? scanResult : getLatestStoredScan();
    const activeContext: ChatContext | undefined = activeScanResult
      ? buildContextFromScanResult(activeScanResult)
      : context;

    try {
      let streamingMsgAdded = false;
      const data = await sendMadamChatMessage({
        message: text,
        scanId: activeScanResult?.scanId || activeContext?.scanId,
        context: activeContext,
        history: newMessages.slice(-6),
        onChunk: partialReply => {
          if (!streamingMsgAdded) {
            streamingMsgAdded = true;
            setMessages([...newMessages, { role: 'assistant', content: partialReply }]);
          } else {
            setMessages([...newMessages, { role: 'assistant', content: partialReply }]);
          }
        }
      });

      if (data.ok && data.reply) {
        setMessages([...newMessages, { role: 'assistant', content: data.reply }]);

        if (autoSpeak) {
          speakMadamText(data.reply, {
            onStart: () => setIsSpeaking(true),
            onEnd: () => setIsSpeaking(false)
          });
        }

        if (data.action === 'trigger_scan' && data.targetUrl && onTriggerScan) {
          onTriggerScan(data.targetUrl);
        }
      } else {
        setMessages([
          ...newMessages,
          { role: 'assistant', content: data.error || 'حصل خطأ بسيط، جرب تبعتلي تاني.' }
        ]);
      }
    } catch {
      setMessages([
        ...newMessages,
        { role: 'assistant', content: 'الشبكة فصلت ثانية، جرب تبعت تاني.' }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const copyText = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2500);
  };

  const copyMasterPromptFromChat = () => {
    const promptToCopy = scanResult?.masterRepairPrompt || context?.masterRepairPrompt;
    if (!promptToCopy) return;
    navigator.clipboard.writeText(promptToCopy);
    setCopiedMasterInChat(true);
    setTimeout(() => setCopiedMasterInChat(false), 2500);
  };

  const renderMessageContent = (content: string, index: number) => {
    const hasCodeBlock = content.includes('```');
    if (!hasCodeBlock) {
      return <p className="whitespace-pre-wrap leading-relaxed">{content}</p>;
    }

    const parts = content.split('```');
    return (
      <div className="space-y-2">
        {parts.map((part, pIdx) => {
          if (pIdx % 2 === 1) {
            const lines = part.trim().split('\n');
            const lang = lines[0].match(/^[a-z0-9_-]+$/i) ? lines[0] : '';
            const code = lang ? lines.slice(1).join('\n') : lines.join('\n');

            return (
              <div
                key={pIdx}
                className="my-2 p-3 text-xs font-mono border relative overflow-x-auto"
                style={{
                  backgroundColor: 'var(--surface-alt)',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--ink)',
                  borderRadius: 'var(--r-md)'
                }}
                dir="ltr"
              >
                <div
                  className="flex items-center justify-between pb-1.5 mb-1.5 border-b text-xs"
                  style={{ borderColor: 'var(--border)', color: 'var(--ink-muted)' }}
                >
                  <div className="flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5" style={{ color: 'var(--primary)' }} />
                    <span>{lang || 'prompt'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText(code, index * 100 + pIdx)}
                    className="flex items-center gap-1 px-2.5 py-1 border font-bold cursor-pointer whitespace-nowrap"
                    style={{
                      backgroundColor: 'var(--surface)',
                      borderColor: 'var(--border)',
                      color: 'var(--primary)',
                      borderRadius: 'var(--r-sm)'
                    }}
                  >
                    {copiedIndex === index * 100 + pIdx ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                    <span>{copiedIndex === index * 100 + pIdx ? 'اتنسخ' : 'نسخ'}</span>
                  </button>
                </div>
                <pre className="whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">{code}</pre>
              </div>
            );
          }
          return (
            <p key={pIdx} className="whitespace-pre-wrap leading-relaxed">
              {part}
            </p>
          );
        })}
      </div>
    );
  };

  return (
    <div
      className={`border flex flex-col ${compact ? 'p-3.5' : 'p-4 sm:p-5'}`}
      style={{
        backgroundColor: 'var(--surface)',
        borderColor: 'var(--border)',
        borderRadius: 'var(--r-md)',
        boxShadow: 'var(--sh-1)'
      }}
    >
      {/* Top Bar */}
      <div
        className="flex items-center justify-between gap-2 pb-2.5 mb-2.5 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-xs font-bold truncate" style={{ color: 'var(--ink)' }}>
          {reviewedDomain
            ? `مراجعة: ${reviewedDomain}`
            : 'اسأل بصوتك أو اكتب الرابط'}
        </span>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              const next = !autoSpeak;
              setAutoSpeak(next);
              if (!next) {
                stopMadamSpeech();
                setIsSpeaking(false);
              }
            }}
            title={autoSpeak ? 'كتم صوت مدام عفاف' : 'تشغيل صوت مدام عفاف'}
            className="px-2.5 py-1 border text-xs font-bold flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
            style={{
              backgroundColor: autoSpeak ? 'var(--pass-bg)' : 'var(--bg)',
              borderColor: autoSpeak ? 'var(--pass-fg)' : 'var(--border)',
              color: autoSpeak ? 'var(--pass-fg)' : 'var(--ink-muted)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            {autoSpeak ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            <span>{autoSpeak ? 'الصوت شغال' : 'صامت'}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              stopMadamSpeech();
              setIsSpeaking(false);
              setMessages([{ role: 'assistant', content: defaultGreeting }]);
            }}
            title="بدء محادثة جديدة"
            className="p-1.5 border cursor-pointer shrink-0"
            style={{
              backgroundColor: 'var(--bg)',
              borderColor: 'var(--border)',
              color: 'var(--ink-muted)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Quick Action Prompts */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2 mb-2 text-xs">
        {(hasScannedSite ? POST_SCAN_QUICK_PROMPTS : PRE_SCAN_SAMPLE_URLS).map((q, idx) => (
          <button
            key={idx}
            type="button"
            disabled={loading || isScanning}
            onClick={() => handleSend(q.text)}
            className="shrink-0 px-3 py-1.5 border text-xs font-bold cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: 'var(--bg)',
              borderColor: 'var(--border)',
              color: 'var(--ink)',
              borderRadius: 'var(--r-sm)'
            }}
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Messages List (aria-live for streaming/new replies) */}
      <div
        aria-live="polite"
        className={`overflow-y-auto space-y-2.5 mb-2.5 pe-1 ${compact ? 'max-h-56' : 'max-h-72'}`}
      >
        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex items-start gap-2 text-sm ${
              msg.role === 'user' ? 'flex-row-reverse' : ''
            }`}
          >
            {msg.role === 'user' ? (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 font-bold"
                style={{
                  backgroundColor: 'var(--ink)',
                  color: 'var(--surface)'
                }}
              >
                <User className="w-4 h-4" />
              </div>
            ) : (
              <MadamAfafAvatar size={32} />
            )}

            <div
              className="p-3 max-w-[85%] border text-sm font-medium"
              style={{
                backgroundColor: msg.role === 'user' ? 'var(--primary)' : 'var(--bg)',
                borderColor: msg.role === 'user' ? 'var(--primary)' : 'var(--border)',
                color: msg.role === 'user' ? 'var(--on-primary)' : 'var(--ink)',
                borderRadius: 'var(--r-md)'
              }}
            >
              {renderMessageContent(msg.content, idx)}

              {msg.role === 'assistant' && (
                <div
                  className="mt-2 pt-1.5 border-t flex flex-wrap items-center justify-between gap-2"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <button
                    type="button"
                    onClick={() => handleSpeakMessage(msg.content)}
                    className="inline-flex items-center gap-1 text-xs font-bold cursor-pointer whitespace-nowrap"
                    style={{ color: 'var(--primary)' }}
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>{isSpeaking ? 'إيقاف الصوت' : 'اسمع بصوت مدام عفاف'}</span>
                  </button>

                  {hasScannedSite &&
                    idx === messages.length - 1 &&
                    (scanResult?.masterRepairPrompt || context?.masterRepairPrompt) && (
                      <button
                        type="button"
                        onClick={copyMasterPromptFromChat}
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-bold cursor-pointer whitespace-nowrap"
                        style={{
                          backgroundColor: 'var(--primary)',
                          color: 'var(--on-primary)',
                          borderRadius: 'var(--r-sm)'
                        }}
                      >
                        {copiedMasterInChat ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedMasterInChat ? 'اتنسخ' : 'نسخ خطة الإصلاح'}</span>
                      </button>
                    )}
                </div>
              )}
            </div>
          </div>
        ))}

        {(loading || isScanning) && (
          <div className="flex items-center gap-2 text-xs py-1">
            <MadamAfafAvatar size={28} />
            <div
              className="px-3.5 py-2 border font-bold flex items-center gap-2"
              style={{
                backgroundColor: 'var(--surface-alt)',
                borderColor: 'var(--border)',
                color: 'var(--ink)',
                borderRadius: 'var(--r-md)'
              }}
            >
              <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: 'var(--primary)' }} />
              <span>
                {isScanning ? 'جاري فحص الموقع بالدليل...' : 'مدام عفاف بترد عليك...'}
              </span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Active Recording / Voice Studio Banner */}
      {(isListening || showVoiceStudio) && (
        <div
          className="mb-2.5 p-3 border space-y-2"
          style={{
            backgroundColor: 'var(--surface-alt)',
            borderColor: isListening ? 'var(--pen)' : 'var(--border-strong)',
            borderRadius: 'var(--r-md)'
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {isListening && (
                <span
                  className="w-2.5 h-2.5 rounded-full animate-ping shrink-0"
                  style={{ backgroundColor: 'var(--pen)' }}
                />
              )}
              <span className="text-xs font-bold truncate" style={{ color: 'var(--ink)' }}>
                {isListening
                  ? micMode === 'holding'
                    ? `🎙️ وضع الضغط المستمر (${recordingSeconds} ث).. ارفع إيدك للإرسال الفوري`
                    : interimVoiceText ||
                      `🎙️ تسجيل مستمر (${recordingSeconds} ث).. اتكلم براحتك ودوس «إنهاء وإرسال»`
                  : voiceErrorMsg || 'اختار جملة صوتية سريعة أو دوس المايك للتسجيل:'}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {isListening && (
                <button
                  type="button"
                  onClick={finishAndSendRecording}
                  className="px-3 py-1 text-xs font-bold cursor-pointer whitespace-nowrap"
                  style={{
                    backgroundColor: 'var(--primary)',
                    color: 'var(--on-primary)',
                    borderRadius: 'var(--r-sm)'
                  }}
                >
                  إنهاء وإرسال ({recordingSeconds}ث)
                </button>
              )}
              <button
                type="button"
                onClick={cancelRecording}
                aria-label="إلغاء التسجيل"
                className="p-1 border text-xs font-bold cursor-pointer"
                style={{
                  backgroundColor: 'var(--surface)',
                  borderColor: 'var(--border)',
                  color: 'var(--ink-muted)',
                  borderRadius: 'var(--r-sm)'
                }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5 pt-1">
            {VOICE_STUDIO_QUICK_SPEECH.map((vp, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  if (isListening) {
                    voiceSessionRef.current?.stop();
                    setIsListening(false);
                    setMicMode('idle');
                  }
                  setShowVoiceStudio(false);
                  handleSend(vp.text);
                }}
                className="px-2.5 py-1 border text-xs font-bold cursor-pointer transition-colors"
                style={{
                  backgroundColor: 'var(--surface)',
                  borderColor: 'var(--border)',
                  color: 'var(--primary)',
                  borderRadius: 'var(--r-sm)'
                }}
              >
                {vp.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input Form with Dual-Mode Microphone (Single-Click or Hold) */}
      <form
        onSubmit={e => {
          e.preventDefault();
          if (isListening) {
            finishAndSendRecording();
          } else {
            handleSend();
          }
        }}
        className="flex items-center gap-2 pt-2 border-t"
        style={{ borderColor: 'var(--border)' }}
      >
        <button
          type="button"
          onPointerDown={handleMicPointerDown}
          onPointerUp={handleMicPointerUp}
          onPointerLeave={() => {
            // If user dragged pointer outside while in hold mode, send!
            if (micMode === 'holding' && isListening) {
              finishAndSendRecording();
            }
          }}
          disabled={loading || isScanning}
          aria-label={
            isListening
              ? micMode === 'holding'
                ? 'ارفع يدك لإرسال الصوت'
                : 'اضغط مرة ثانية لإنهاء التسجيل والإرسال'
              : 'اضغط تكة للتسجيل أو اضغط مطولاً'
          }
          title={
            isListening
              ? micMode === 'holding'
                ? 'مستمر بالضغط: ارفع يدك للإرسال الفوري'
                : 'وضع التكة الواحدة: اضغط تكة تانية لإنهاء التسجيل والإرسال'
              : 'دوس تكة واحدة للتسجيل بدون استمرار بالضغط (أو اضغط مطولاً)'
          }
          className="w-11 h-11 border transition-all cursor-pointer shrink-0 flex items-center justify-center select-none"
          style={{
            backgroundColor: isListening ? 'var(--pen)' : 'var(--surface-alt)',
            borderColor: isListening ? 'var(--pen)' : 'var(--border-strong)',
            color: isListening ? 'var(--on-primary)' : 'var(--ink)',
            borderRadius: 'var(--r-sm)'
          }}
        >
          {isListening ? (
            <Square className="w-4 h-4 fill-current shrink-0 animate-pulse" />
          ) : (
            <Mic className="w-4 h-4 shrink-0" style={{ color: 'var(--primary)' }} />
          )}
        </button>

        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={loading || isScanning}
          placeholder={
            hasScannedSite
              ? 'اسأل مدام عفاف عن التقرير...'
              : 'ابعت رابط موقعك هنا للفحص...'
          }
          className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2 text-base border font-medium"
          style={{
            backgroundColor: 'var(--bg)',
            borderColor: 'var(--border)',
            color: 'var(--ink)',
            borderRadius: 'var(--r-sm)'
          }}
        />

        <button
          type="submit"
          disabled={loading || isScanning || (!input.trim() && !isListening)}
          className="min-h-[44px] px-4 py-2 text-xs font-bold transition-colors flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
          style={{
            backgroundColor: 'var(--primary)',
            color: 'var(--on-primary)',
            borderRadius: 'var(--r-sm)'
          }}
        >
          <Send className="w-3.5 h-3.5 rotate-180" />
          <span>إرسال</span>
        </button>
      </form>
    </div>
  );
};
