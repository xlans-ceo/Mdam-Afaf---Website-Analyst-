import React, { useState, useEffect } from 'react';
import { X, Volume2, MessageCircle } from 'lucide-react';
import { MadamAfafAiConsultant } from './MadamAfafAiConsultant';
import { ScanResult } from '../types/contract';
import { ChatContext, buildContextFromScanResult } from '../lib/chat-context';
import { speakMadamText, MADAM_AFAF_VOICE_GREETING } from '../lib/voice-client';
import { MadamAfafAvatar } from './MadamAfafAvatar';

interface MadamAfafFloatingWidgetProps {
  scanResult?: ScanResult | null;
  isScanning?: boolean;
  onTriggerScan: (url: string) => void;
  onOpenChange?: (open: boolean) => void;
}

export const MadamAfafFloatingWidget: React.FC<MadamAfafFloatingWidgetProps> = ({
  scanResult,
  isScanning = false,
  onTriggerScan,
  onOpenChange
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showCallout, setShowCallout] = useState(false);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // K1.1: Chat teaser bubble shows once per session, auto-hides after 6 seconds, and NEVER on the landing form
  useEffect(() => {
    if (!scanResult) {
      setShowCallout(false);
      return;
    }
    let alreadyShown = false;
    try {
      alreadyShown = sessionStorage.getItem('madam_chat_teaser_shown') === '1';
      if (!alreadyShown) {
        sessionStorage.setItem('madam_chat_teaser_shown', '1');
      }
    } catch {
      // ignore storage errors
    }
    if (alreadyShown) return;

    setShowCallout(true);
    const timer = setTimeout(() => {
      setShowCallout(false);
    }, 6000);
    return () => clearTimeout(timer);
  }, [scanResult?.scanId]);

  useEffect(() => {
    const handleOpenEvent = (ev: Event) => {
      setIsOpen(true);
      setShowCallout(false);
      const customEv = ev as CustomEvent<{ speakGreeting?: boolean }>;
      if (customEv.detail?.speakGreeting) {
        speakMadamText(MADAM_AFAF_VOICE_GREETING);
      }
    };
    window.addEventListener('open-madam-afaf-chat', handleOpenEvent);
    return () => window.removeEventListener('open-madam-afaf-chat', handleOpenEvent);
  }, []);

  const context: ChatContext | undefined = scanResult
    ? buildContextFromScanResult(scanResult)
    : undefined;

  return (
    <div
      className="no-print fixed bottom-4 start-4 z-50 flex flex-col items-start"
      style={{ insetInlineStart: 'var(--sp-4)' }}
      dir="rtl"
    >
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="شات مدام عفاف"
          data-testid="madam-chat-sheet"
          className="mb-3 w-[calc(100vw-2rem)] sm:w-96 max-w-md border-2 overflow-hidden"
          style={{
            backgroundColor: 'var(--surface)',
            borderColor: 'var(--primary)',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--sh-3)'
          }}
        >
          {/* Top Bar */}
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{
              backgroundColor: 'var(--primary)',
              color: 'var(--on-primary)'
            }}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <MadamAfafAvatar size={36} bordered={false} />
              <div className="min-w-0">
                <span className="block text-sm font-bold whitespace-nowrap">
                  مدام عفاف — شات المراجعة
                </span>
                <p className="text-xs opacity-90 truncate">
                  {scanResult
                    ? `التقرير جاهز: ${scanResult.registrableDomain}`
                    : 'اسأل مدام عفاف أو ابعت رابط موقعك'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="p-2 rounded-full hover:opacity-80 transition-opacity cursor-pointer shrink-0"
              style={{ color: 'var(--on-primary)' }}
              aria-label="إغلاق نافذة مدام عفاف"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-2.5" style={{ backgroundColor: 'var(--bg)' }}>
            <MadamAfafAiConsultant
              context={context}
              scanResult={scanResult}
              isScanning={isScanning}
              onTriggerScan={url => {
                onTriggerScan(url);
              }}
              compact={true}
            />
          </div>
        </div>
      )}

      {/* Callout Bubble & Floating Action Button replaced by B2.2 Dock */}
      {!isOpen && showCallout && Boolean(scanResult) && (
        <div data-testid="chat-teaser-bubble" className="hidden">
          <button type="button" onClick={() => setIsOpen(true)}>
            {scanResult ? 'اسأليني عن تفاصيل التقرير' : 'كلم مدام عفاف بالصوت'}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label="افتح شات مدام عفاف"
        className="hidden"
      >
        <MadamAfafAvatar size={34} />
        <span>شات مدام عفاف</span>
        {isOpen ? <MessageCircle className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
      </button>
    </div>
  );
};

