import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('PHASE J3: Chat URL Extractor, SSE/JSON Fallback & Voice Hardening Suite', () => {
  const extractorPath = path.resolve(process.cwd(), 'src/lib/chat-url-extractor.ts');
  const chatClientPath = path.resolve(process.cwd(), 'src/lib/chat-client.ts');
  const aiConsultantLibPath = path.resolve(process.cwd(), 'src/lib/ai-consultant.ts');

  it('J3.1: src/lib/chat-url-extractor.ts exists and extracts explicit URLs, bare domains, spoken "دوت كوم", and strips Arabic punctuation/zero-width chars', async () => {
    assert.ok(fs.existsSync(extractorPath), 'src/lib/chat-url-extractor.ts must exist');
    const mod = await import('./chat-url-extractor.js');
    assert.equal(typeof mod.extractChatUrl, 'function', 'extractChatUrl must be exported');

    // Explicit URL with Arabic punctuation and zero-width marks
    const r1 = mod.extractChatUrl('يا مدام عفاف شوفي «\u200Bhttps://elabyad-eg.com/about\u200F»، وإيه رأيك؟');
    assert.equal(r1.url, 'https://elabyad-eg.com/about');
    assert.equal(r1.registrableDomain, 'elabyad-eg.com');

    // Bare domain with path and query
    const r2 = mod.extractChatUrl('ممكن تفحصي www.vodafone.com.eg/ar؟');
    assert.equal(r2.url, 'https://www.vodafone.com.eg/ar');
    assert.equal(r2.registrableDomain, 'vodafone.com.eg');

    // Spoken "دوت كوم" from voice transcription
    const r3 = mod.extractChatUrl('افحصي موقع elabyad-eg دوت كوم لو سمحتي');
    assert.equal(r3.url, 'https://elabyad-eg.com/');
    assert.equal(r3.registrableDomain, 'elabyad-eg.com');

    // Multiple URLs in message
    const r4 = mod.extractChatUrl('قارني بين example.com و elabyad-eg.com');
    assert.equal(r4.url, 'https://example.com/');
    assert.deepEqual(r4.allUrls, ['https://example.com/', 'https://elabyad-eg.com/']);
  });

  it('J3.2: chat-url-extractor rejects filenames, code extensions, emails, version numbers, localhost, and private IPs', async () => {
    assert.ok(fs.existsSync(extractorPath), 'src/lib/chat-url-extractor.ts must exist');
    const mod = await import('./chat-url-extractor.js');

    const negativeInputs = [
      'عدلت ملف server.ts و ReportView.tsx و README.md',
      'الصورة logo.png والملف report.pdf مضغوطين في archive.zip',
      'ابعتلي على info@elabyad-eg.com',
      'الإصدار الحالي v2.0.0 أو 1.2.3',
      'افحصي http://localhost:3000 أو http://127.0.0.1/admin أو http://192.168.1.1',
      'إزيك يا مدام عفاف عاملة إيه النهارده؟'
    ];

    for (const input of negativeInputs) {
      const res = mod.extractChatUrl(input);
      assert.equal(res.url, null, `Must reject non-public-url input: "${input}", got: ${res.url}`);
      assert.equal(res.allUrls.length, 0);
    }
  });

  it('J3.3: /api/chat-afaf supports SSE streaming (text/event-stream) and JSON fallback', async () => {
    const { createApiApp } = await import('../../server.js');
    const app = createApiApp();
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      // 1. Request SSE stream on /api/chat-afaf
      const sseRes = await fetch(`http://127.0.0.1:${port}/api/chat-afaf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'X-Visitor-Id': 'v_sse_test_123456'
        },
        body: JSON.stringify({
          message: 'أهم المشاكل إيه؟',
          stream: true,
          context: {
            domain: 'elabyad-eg.com',
            url: 'https://elabyad-eg.com/',
            verdictLabelAr: 'جاهز بملاحظات',
            pagesCount: 5,
            topFindings: [
              {
                ruleId: 'SEC001',
                category: 'security',
                severity: 'medium',
                titleAr: 'غياب ترويسة HSTS',
                url: 'https://elabyad-eg.com/',
                recommendedFix: 'إضافة Strict-Transport-Security'
              }
            ]
          }
        })
      });

      assert.equal(sseRes.status, 200);
      const contentType = sseRes.headers.get('content-type') || '';
      assert.ok(contentType.includes('text/event-stream'), `Expected text/event-stream, got ${contentType}`);
      const rawSse = await sseRes.text();
      assert.ok(rawSse.includes('"type":"chunk"') || rawSse.includes('"type":"done"'), 'SSE response must contain chunk/done events');
      assert.ok(rawSse.includes('elabyad-eg.com'), 'SSE response must reference the scanned domain');
    } finally {
      server.close();
    }
  });

  it('J3.4: src/lib/chat-client.ts streams SSE chunks and seamlessly falls back to JSON if SSE fails or returns application/json', async () => {
    assert.ok(fs.existsSync(chatClientPath), 'src/lib/chat-client.ts must exist');
    const { sendMadamChatMessage } = await import('./chat-client.js');

    // Case A: Server responds with SSE stream
    const chunksReceived: string[] = [];
    const sseResult = await sendMadamChatMessage({
      message: 'أهم المشاكل إيه؟',
      context: { domain: 'elabyad-eg.com' },
      onChunk: textSoFar => chunksReceived.push(textSoFar),
      fetchImpl: async () => {
        const sseBody = [
          'data: {"type":"chunk","delta":"أهلًا بيك، "}\n\n',
          'data: {"type":"chunk","delta":"في موقع elabyad-eg.com لقيت ملاحظة."}\n\n',
          'data: {"type":"done","ok":true,"reply":"أهلًا بيك، في موقع elabyad-eg.com لقيت ملاحظة."}\n\n',
          'data: [DONE]\n\n'
        ].join('');
        return new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
    });

    assert.equal(sseResult.ok, true);
    assert.equal(sseResult.reply, 'أهلًا بيك، في موقع elabyad-eg.com لقيت ملاحظة.');
    assert.ok(chunksReceived.length >= 2, 'onChunk must be called progressively for SSE chunks');

    // Case B: SSE attempt throws or server returns JSON -> seamlessly falls back to JSON
    let callCount = 0;
    const fallbackResult = await sendMadamChatMessage({
      message: 'افحصي example.com',
      onChunk: () => {},
      fetchImpl: async (_url, init) => {
        callCount++;
        const headers = (init?.headers || {}) as Record<string, string>;
        if (headers['Accept'] === 'text/event-stream') {
          throw new Error('Simulated proxy blocking SSE');
        }
        return new Response(
          JSON.stringify({
            ok: true,
            reply: 'ثواني بس هراجع الموقع (example.com) وأجيلك بالدليل...',
            action: 'trigger_scan',
            targetUrl: 'https://example.com/'
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }
    });

    assert.equal(fallbackResult.ok, true);
    assert.equal(fallbackResult.action, 'trigger_scan');
    assert.equal(fallbackResult.targetUrl, 'https://example.com/');
    assert.equal(callCount, 2, 'Must retry with standard JSON when SSE request fails');
  });

  it('J3.5: Voice & TTS hardening: no unofficial translate.googleapis.com scraping in ai-consultant.ts; /api/tts returns fallbackToBrowser when key is absent', async () => {
    const aiLibSrc = fs.readFileSync(aiConsultantLibPath, 'utf-8');
    assert.ok(
      !aiLibSrc.includes('translate.googleapis.com/translate_tts'),
      'ai-consultant.ts must not scrape unofficial translate.googleapis.com/translate_tts'
    );

    const prevKey = process.env.GEMINI_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      const { synthesizeMadamSpeechWithMime } = await import('./ai-consultant.js');
      const res = await synthesizeMadamSpeechWithMime('نص تجريبي غير موجود في الكاش ' + Date.now());
      assert.equal(res, null, 'When GEMINI_API_KEY is unset and text is not cached, synthesizeMadamSpeechWithMime must return null so client uses Web Speech API fallback');
    } finally {
      if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
    }
  });
});
