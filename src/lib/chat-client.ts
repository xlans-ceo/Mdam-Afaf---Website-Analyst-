import { ChatContext, ChatMessage } from './chat-context';
import { apiFetch } from './api-client';

export interface MadamChatResponse {
  ok: boolean;
  reply?: string;
  action?: 'needs_url' | 'trigger_scan' | 'allow_chat';
  targetUrl?: string;
  error?: string;
}

export interface SendMadamChatOptions {
  message: string;
  scanId?: string;
  context?: ChatContext;
  history?: ChatMessage[];
  onChunk?: (accumulatedText: string) => void;
  fetchImpl?: typeof fetch;
}

async function parseSseResponse(
  res: Response,
  onChunk?: (accumulatedText: string) => void
): Promise<MadamChatResponse> {
  const reader = res.body?.getReader();
  let rawBuffer = '';
  let accumulated = '';
  let finalPayload: MadamChatResponse | null = null;

  const processLines = (lines: string[]) => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        if (parsed.type === 'chunk' && typeof parsed.delta === 'string') {
          accumulated += parsed.delta;
          onChunk?.(accumulated);
        } else if (parsed.type === 'done') {
          finalPayload = {
            ok: parsed.ok ?? true,
            reply: parsed.reply ?? accumulated,
            action: parsed.action,
            targetUrl: parsed.targetUrl,
            error: parsed.error
          };
          if (finalPayload.reply) {
            onChunk?.(finalPayload.reply);
          }
        }
      } catch {
        // ignore malformed frame
      }
    }
  };

  if (reader) {
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });
      const parts = rawBuffer.split('\n\n');
      rawBuffer = parts.pop() || '';
      for (const frame of parts) {
        processLines(frame.split('\n'));
      }
    }
    if (rawBuffer.trim()) {
      processLines(rawBuffer.split('\n'));
    }
  } else {
    const text = await res.text();
    processLines(text.split('\n'));
  }

  if (finalPayload) {
    return finalPayload;
  }

  if (accumulated.trim()) {
    return {
      ok: true,
      reply: accumulated
    };
  }

  throw new Error('Empty SSE stream');
}

/**
 * Sends a chat message to Madam Afaf via `/api/chat` using SSE streaming first,
 * and automatically falls back to standard JSON if SSE is blocked, unsupported, or fails mid-flight.
 */
export async function sendMadamChatMessage(
  options: SendMadamChatOptions
): Promise<MadamChatResponse> {
  const { message, scanId, context, history = [], onChunk, fetchImpl = apiFetch } = options;

  // 1. Attempt SSE streaming first
  try {
    const sseRes = await fetchImpl('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        message,
        scanId: scanId || context?.scanId,
        context,
        history: history.slice(-6),
        stream: true
      })
    });

    const contentType = (sseRes.headers.get('content-type') || '').toLowerCase();
    if (sseRes.ok && contentType.includes('text/event-stream')) {
      return await parseSseResponse(sseRes, onChunk);
    }

    if (contentType.includes('application/json')) {
      const jsonData = (await sseRes.json()) as MadamChatResponse;
      if (jsonData.ok && jsonData.reply) {
        onChunk?.(jsonData.reply);
      }
      return jsonData;
    }
  } catch {
    // Fall through to standard JSON fallback request
  }

  // 2. Fallback to standard JSON request
  const jsonRes = await fetchImpl('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      message,
      scanId: scanId || context?.scanId,
      context,
      history: history.slice(-6),
      stream: false
    })
  });

  const data = (await jsonRes.json()) as MadamChatResponse;
  if (data.ok && data.reply) {
    onChunk?.(data.reply);
  }
  return data;
}
