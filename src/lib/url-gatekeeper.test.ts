import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUrlFromMessage,
  evaluateChatGatekeeper,
  normalizeUserDomainOrUrl
} from './url-gatekeeper';
import {
  ensureWavBase64,
  prepareMadamSpeechText,
  MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT,
  NO_SITE_SCANNED_PROMPT
} from './ai-consultant';

describe('Madam Afaf URL Gatekeeper, Domain Normalizer & Voice Prep', () => {
  test('extracts explicit https and http URLs from Egyptian Arabic sentences', () => {
    assert.equal(
      extractUrlFromMessage('يا مدام عفاف بصي على موقعي https://example.com/shop لو سمحتي'),
      'https://example.com/shop'
    );
    assert.equal(
      extractUrlFromMessage('ده اللينك http://mysite.org، راجعيه'),
      'http://mysite.org/'
    );
  });

  test('extracts bare domain names and normalizes to https://', () => {
    assert.equal(
      extractUrlFromMessage('ممكن تفحصي google.com دلوقتي؟'),
      'https://google.com/'
    );
    assert.equal(
      extractUrlFromMessage('شوفي www.vodafone.com.eg/ar'),
      'https://www.vodafone.com.eg/ar'
    );
  });

  test('normalizeUserDomainOrUrl accepts both bare domain.com and https://domain.com', () => {
    assert.equal(normalizeUserDomainOrUrl('example.com'), 'https://example.com/');
    assert.equal(normalizeUserDomainOrUrl('https://example.com'), 'https://example.com/');
    assert.equal(normalizeUserDomainOrUrl('  www.google.com  '), 'https://www.google.com/');
    assert.equal(normalizeUserDomainOrUrl('http://github.com/repo'), 'http://github.com/repo');
    assert.equal(normalizeUserDomainOrUrl(''), null);
    assert.equal(normalizeUserDomainOrUrl('not a domain'), null);
  });

  test('prepareMadamSpeechText strips any meta-instructions and starts directly with greeting', () => {
    const cleaned = prepareMadamSpeechText(
      'بلهجة مصرية عامية دافئة وواضحة: مساء الخير يا حبيبي، معاك مدام عفاف من الدور التاني شباك 6!'
    );
    assert.ok(cleaned.startsWith('مساء الخير يا حبيبي'));
    assert.ok(!cleaned.includes('بلهجة مصرية'));
  });

  test('ensureWavBase64 wraps raw PCM bytes with a valid 44-byte RIFF WAVE header', () => {
    const rawPcm = Buffer.alloc(480, 0).toString('base64');
    const wavB64 = ensureWavBase64(rawPcm, 24000);
    const wavBuf = Buffer.from(wavB64, 'base64');
    assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wavBuf.length, 480 + 44);
  });

  test('rejects messages without URLs or with localhost/IPs', () => {
    assert.equal(extractUrlFromMessage('إزيك يا مدام عفاف عاملة إيه؟'), null);
    assert.equal(extractUrlFromMessage('http://localhost:3000'), null);
    assert.equal(extractUrlFromMessage('http://127.0.0.1/admin'), null);
  });

  test('gatekeeper shows guidance prompt ONCE on first general greeting when no site is scanned, and allows AI chat afterwards or on service/SEO/dev questions', () => {
    // 1. First general greeting with empty history -> needs_url once
    const firstGreeting = evaluateChatGatekeeper('إزيك يا مدام عفاف عاملة إيه؟');
    assert.equal(firstGreeting.action, 'needs_url');
    assert.ok(firstGreeting.replyAr && firstGreeting.replyAr.length > 10);

    // 2. Subsequent message after initial guidance was shown -> allow_chat (never repeat static prompt)
    const secondTurn = evaluateChatGatekeeper('طيب تمام قوليلي أكتر', undefined, [
      { role: 'assistant', content: NO_SITE_SCANNED_PROMPT },
      { role: 'user', content: 'طيب تمام قوليلي أكتر' }
    ]);
    assert.equal(secondTurn.action, 'allow_chat');

    // 3. Questions about services, SEO, web development, e-commerce, or how to add a site -> allow_chat immediately
    assert.equal(evaluateChatGatekeeper('عايزة أسألك عن السيو وتحسين محركات البحث').action, 'allow_chat');
    assert.equal(evaluateChatGatekeeper('إيه الخدمات اللي بتقدموها في تطوير المتاجر الإلكترونية؟').action, 'allow_chat');
    assert.equal(evaluateChatGatekeeper('إزاي أضيف الموقع عشان تفحصيه؟').action, 'allow_chat');
  });

  test('gatekeeper triggers scan when user sends a URL in chat', () => {
    const res = evaluateChatGatekeeper('افحصي الموقع ده example.com');
    assert.equal(res.action, 'trigger_scan');
    assert.equal(res.targetUrl, 'https://example.com/');
    assert.ok(res.replyAr?.includes('ثواني بس هراجع الموقع'));
  });

  test('gatekeeper allows chat when site is already scanned in context and system prompt includes services & contact info', () => {
    const res = evaluateChatGatekeeper('إزاي أصلح مشكلة الموبايل اللي طلعت؟', {
      domain: 'example.com',
      url: 'https://example.com/',
      findingsSummary: 'وجدنا 3 ملاحظات'
    });
    assert.equal(res.action, 'allow_chat');

    assert.ok(MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('https://www.linkedin.com/in/mo7amadsultan/'));
    assert.ok(!MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes(['0114', '0226', '705'].join('')));
    assert.ok(MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('محمد سلطان'));
    assert.ok(MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('B2B'));
    assert.ok(MADAM_AFAF_CONSULTANT_SYSTEM_PROMPT.includes('Core Web Vitals'));
  });
});
