/**
 * Client-side Voice Utility for Madam Afaf
 * Supports both Single-Tap Toggle Recording ("دوس تكة وسجل، ودوس إرسال")
 * and Press-and-Hold Recording ("أو اضغط مطولاً وسيب الزرار يبعت").
 */

import { apiFetch } from './api-client';

export const MADAM_AFAF_VOICE_GREETING =
  'مساء الخير يا حبيبي، معاك مدام عفاف. ابعتلي لينك الموقع وأنا أراجعه بالدليل، أو اسألني بصوتك في أي تفصيلة.';

let currentAudio: HTMLAudioElement | null = null;
let sharedAudioCtx: AudioContext | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
const clientTtsCache = new Map<string, { audioBase64: string; mimeType: string }>();

function getLocalStorageCachedTts(text: string): { audioBase64: string; mimeType: string } | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(`madam_tts_${text.slice(0, 80)}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.audioBase64 === 'string' && typeof parsed.mimeType === 'string') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function setLocalStorageCachedTts(text: string, value: { audioBase64: string; mimeType: string }): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(`madam_tts_${text.slice(0, 80)}`, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

function getUnlockedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function stopMadamSpeech(): void {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (currentBufferSource) {
    try {
      currentBufferSource.onended = null;
      currentBufferSource.stop();
      currentBufferSource.disconnect();
    } catch {
      // ignore
    }
    currentBufferSource = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export function sanitizeSpeechText(text: string): string {
  return text
    .replace(/^بلهجة مصرية[^:：]*[:：]\s*/i, '')
    .replace(/^تحدثي باللغة العامية[^:：]*[:：]\s*/i, '')
    .replace(/```[\s\S]*?```/g, ' خطة الإصلاح جاهزة قدامك تقدر تنسخها. ')
    .replace(/[*#_`~>«»]/g, '')
    .replace(/https?:\/\/[^\s]+/g, ' موقعك ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function speakMadamText(
  text: string,
  callbacks?: {
    onStart?: () => void;
    onEnd?: () => void;
  }
): Promise<void> {
  stopMadamSpeech();

  const cleanText = sanitizeSpeechText(text);
  if (!cleanText) {
    callbacks?.onEnd?.();
    return;
  }

  const audioCtx = getUnlockedAudioContext();
  callbacks?.onStart?.();

  try {
    let cachedEntry = clientTtsCache.get(cleanText) || getLocalStorageCachedTts(cleanText);

    if (!cachedEntry) {
      const res = await apiFetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText })
      });
      const data = await res.json();
      if (data.ok && data.audioBase64) {
        cachedEntry = {
          audioBase64: data.audioBase64,
          mimeType: data.mimeType || 'audio/wav'
        };
        if (clientTtsCache.size < 30) {
          clientTtsCache.set(cleanText, cachedEntry);
        }
        setLocalStorageCachedTts(cleanText, cachedEntry);
      }
    }

    if (cachedEntry?.audioBase64) {
      const { audioBase64, mimeType } = cachedEntry;
      if (audioCtx) {
        try {
          const binaryStr = window.atob(audioBase64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(audioCtx.destination);
          currentBufferSource = source;
          source.onended = () => {
            if (currentBufferSource === source) {
              currentBufferSource = null;
            }
            callbacks?.onEnd?.();
          };
          source.start(0);
          return;
        } catch {
          // Fall through to HTMLAudioElement
        }
      }

      const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
      currentAudio = audio;
      audio.onended = () => {
        currentAudio = null;
        callbacks?.onEnd?.();
      };
      audio.onerror = () => {
        currentAudio = null;
        speakWithBrowserFallback(cleanText, callbacks?.onEnd);
      };
      await audio.play();
      return;
    }
  } catch {
    // Fall back to browser speech synthesis seamlessly
  }

  speakWithBrowserFallback(cleanText, callbacks?.onEnd);
}

function speakWithBrowserFallback(text: string, onEnd?: () => void): void {
  const estimatedDurationMs = Math.min(7000, Math.max(3000, text.length * 45));

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      onEnd?.();
    }, estimatedDurationMs);
    return;
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.slice(0, 400));
    utterance.lang = 'ar-EG';
    utterance.rate = 1.0;
    utterance.pitch = 1.02;

    const voices = window.speechSynthesis.getVoices();
    const arabicVoice =
      voices.find(v => v.lang.toLowerCase().includes('ar-eg')) ||
      voices.find(v => v.lang.toLowerCase().startsWith('ar'));
    if (arabicVoice) {
      utterance.voice = arabicVoice;
    }

    let finished = false;
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      onEnd?.();
    };

    const startedAt = Date.now();
    utterance.onend = () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 800) {
        fallbackTimer = setTimeout(finishOnce, estimatedDurationMs);
      } else {
        finishOnce();
      }
    };
    utterance.onerror = () => {
      fallbackTimer = setTimeout(finishOnce, estimatedDurationMs);
    };
    fallbackTimer = setTimeout(finishOnce, estimatedDurationMs + 1500);

    window.speechSynthesis.speak(utterance);
  } catch {
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      onEnd?.();
    }, estimatedDurationMs);
  }
}

export interface VoiceRecognitionSession {
  stop: () => void;
  finishAndSend: () => void;
}

export function startVoiceInput(callbacks: {
  onInterim?: (interimTranscript: string) => void;
  onResult: (transcript: string) => void;
  onError: (errMsg: string) => void;
  onEnd: () => void;
  onFallbackStudio?: () => void;
}): VoiceRecognitionSession {
  stopMadamSpeech();

  let activeCleanup: (() => void) | null = null;
  let activeFinishAndSend: (() => void) | null = null;
  let hasResolved = false;

  const startMediaRecorderFallback = () => {
    let mediaRecorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const chunks: BlobPart[] = [];

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(s => {
          if (cancelled) {
            s.getTracks().forEach(t => t.stop());
            return;
          }
          stream = s;
          mediaRecorder = new MediaRecorder(s);
          mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) chunks.push(e.data);
          };
          mediaRecorder.onstop = async () => {
            if (maxDurationTimer) clearTimeout(maxDurationTimer);
            stream?.getTracks().forEach(t => t.stop());
            if (cancelled) {
              callbacks.onEnd();
              return;
            }
            if (chunks.length === 0) {
              callbacks.onFallbackStudio?.();
              callbacks.onEnd();
              return;
            }
            const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64Data = (reader.result as string)?.split(',')[1];
              if (!base64Data) {
                callbacks.onFallbackStudio?.();
                callbacks.onEnd();
                return;
              }
              try {
                callbacks.onInterim?.('جاري تحويل صوتك لنص...');
                const res = await apiFetch('/api/transcribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    audioBase64: base64Data,
                    mimeType: blob.type || 'audio/webm'
                  })
                });
                const data = await res.json();
                if (data.ok && data.text) {
                  hasResolved = true;
                  callbacks.onResult(data.text);
                } else {
                  callbacks.onError(data.error || 'مسمعتش الصوت بوضوح، جرب تاني أو اختار جملة جاهزة.');
                  callbacks.onFallbackStudio?.();
                }
              } catch {
                callbacks.onFallbackStudio?.();
              } finally {
                callbacks.onEnd();
              }
            };
            reader.readAsDataURL(blob);
          };
          mediaRecorder.start(250);
          callbacks.onInterim?.('المايك بيسجل.. اتكلم براحتك ودوس «إرسال الصوت» لما تخلص');

          // Safety cap: 30 seconds max recording
          maxDurationTimer = setTimeout(() => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
              mediaRecorder.stop();
            }
          }, 30000);
        })
        .catch(() => {
          callbacks.onError('المتصفح محتاج إذن المايك، أو اختار جملة جاهزة من تحت.');
          callbacks.onFallbackStudio?.();
        });
    } else {
      callbacks.onFallbackStudio?.();
    }

    activeFinishAndSend = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      } else {
        stream?.getTracks().forEach(t => t.stop());
        callbacks.onEnd();
      }
    };

    activeCleanup = () => {
      cancelled = true;
      if (maxDurationTimer) clearTimeout(maxDurationTimer);
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        try {
          mediaRecorder.stop();
        } catch {
          // ignore
        }
      }
      stream?.getTracks().forEach(t => t.stop());
      callbacks.onEnd();
    };
  };

  const SpeechRecognitionImpl =
    typeof window !== 'undefined'
      ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
      : null;

  if (SpeechRecognitionImpl) {
    try {
      const recognition = new SpeechRecognitionImpl();
      recognition.lang = 'ar-EG';
      // Keep continuous = true so a single click records until the user clicks Send
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      let accumulatedTranscript = '';
      let latestInterim = '';
      let switchedToFallback = false;
      let userRequestedFinish = false;
      const startedAt = Date.now();

      recognition.onresult = (event: any) => {
        let interim = '';
        let finalChunk = '';
        for (let i = event.resultIndex || 0; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalChunk += res[0].transcript + ' ';
          } else {
            interim += res[0].transcript;
          }
        }
        if (finalChunk.trim()) {
          accumulatedTranscript = `${accumulatedTranscript} ${finalChunk}`.trim();
        }
        latestInterim = interim.trim();
        const combined = `${accumulatedTranscript} ${latestInterim}`.trim();
        if (combined) {
          callbacks.onInterim?.(combined);
        }
      };

      recognition.onerror = () => {
        if (!hasResolved && !switchedToFallback) {
          switchedToFallback = true;
          startMediaRecorderFallback();
        }
      };

      recognition.onend = () => {
        if (switchedToFallback) return;
        const fullText = `${accumulatedTranscript} ${latestInterim}`.trim();
        const elapsed = Date.now() - startedAt;

        if (!hasResolved && fullText) {
          hasResolved = true;
          callbacks.onResult(fullText);
          callbacks.onEnd();
          return;
        }

        // If SpeechRecognition ended prematurely (< 1000ms) without user clicking stop, switch to MediaRecorder
        if (!userRequestedFinish && !hasResolved && elapsed < 1000) {
          switchedToFallback = true;
          startMediaRecorderFallback();
          return;
        }

        callbacks.onEnd();
      };

      recognition.start();

      activeFinishAndSend = () => {
        userRequestedFinish = true;
        const fullText = `${accumulatedTranscript} ${latestInterim}`.trim();
        if (fullText && !hasResolved) {
          hasResolved = true;
          try {
            recognition.onend = null;
            recognition.stop();
          } catch {
            // ignore
          }
          callbacks.onResult(fullText);
          callbacks.onEnd();
          return;
        }
        try {
          recognition.stop();
        } catch {
          callbacks.onEnd();
        }
      };

      activeCleanup = () => {
        userRequestedFinish = true;
        try {
          recognition.onend = null;
          recognition.onerror = null;
          recognition.abort();
        } catch {
          // ignore
        }
        callbacks.onEnd();
      };

      return {
        stop: () => activeCleanup?.(),
        finishAndSend: () => activeFinishAndSend?.()
      };
    } catch {
      // Fall through to MediaRecorder
    }
  }

  startMediaRecorderFallback();

  return {
    stop: () => activeCleanup?.(),
    finishAndSend: () => activeFinishAndSend?.()
  };
}
