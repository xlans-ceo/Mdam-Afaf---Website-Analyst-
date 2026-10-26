import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  getRegistrableDomain, 
  normalizeUrl, 
  isSameRegistrableDomain, 
  classifyUrlSlot 
} from './domain-parser';

test('getRegistrableDomain handles standard and multi-part TLDs correctly', () => {
  // Standard 1-part TLD
  assert.equal(getRegistrableDomain('example.com'), 'example.com');
  assert.equal(getRegistrableDomain('www.example.com'), 'example.com');
  assert.equal(getRegistrableDomain('sub.shop.example.com'), 'example.com');
  assert.equal(getRegistrableDomain('https://www.example.com/products/shoes?sort=asc'), 'example.com');

  // Multi-part country code TLD (.com.eg, .co.uk, .gov.uk)
  assert.equal(getRegistrableDomain('example.com.eg'), 'example.com.eg');
  assert.equal(getRegistrableDomain('www.store.example.com.eg'), 'example.com.eg');
  assert.equal(getRegistrableDomain('https://www.hmrc.gov.uk/dashboard'), 'hmrc.gov.uk');
  assert.equal(getRegistrableDomain('https://portal.service.gov.uk/dashboard'), 'portal.service.gov.uk');
  assert.equal(getRegistrableDomain('store.co.uk'), 'store.co.uk');

  // Private hosting suffixes (tenants isolated per subdomain)
  assert.equal(getRegistrableDomain('https://tenant1.vercel.app/home'), 'tenant1.vercel.app');
  assert.equal(getRegistrableDomain('https://preview.tenant1.vercel.app'), 'tenant1.vercel.app');
  assert.equal(getRegistrableDomain('https://user-a.github.io/project'), 'user-a.github.io');
  assert.equal(getRegistrableDomain('https://shop-b.netlify.app'), 'shop-b.netlify.app');
});

test('normalizeUrl strips tracking parameters but keeps routing parameters', () => {
  const dirtyUrl = 'https://Example.COM:443/products/shoes/?utm_source=facebook&utm_medium=cpc&fbclid=12345&color=blue&size=42#reviews';
  const clean = normalizeUrl(dirtyUrl);
  
  // Protocol & hostname lowercased, default port stripped, trailing slash stripped, hash removed
  assert.ok(clean.startsWith('https://example.com/products/shoes?'));
  assert.ok(!clean.includes('utm_source'));
  assert.ok(!clean.includes('fbclid'));
  assert.ok(!clean.includes('#reviews'));
  assert.ok(clean.includes('color=blue'));
  assert.ok(clean.includes('size=42'));
});

test('classifyUrlSlot separates meaningful pages from interaction states', () => {
  // Meaningful pages
  const home = classifyUrlSlot('https://example.com/');
  assert.equal(home.isMeaningfulPage, true);
  assert.equal(home.isInteractionState, false);

  const about = classifyUrlSlot('https://example.com/about');
  assert.equal(about.isMeaningfulPage, true);
  assert.equal(about.isInteractionState, false);

  const product = classifyUrlSlot('https://example.com/products/sneakers');
  assert.equal(product.isMeaningfulPage, true);
  assert.equal(product.isInteractionState, false);

  // Interaction states: filters, sorting, pagination, modals
  const filtered = classifyUrlSlot('https://example.com/products?color=red&sort=price_asc');
  assert.equal(filtered.isMeaningfulPage, false);
  assert.equal(filtered.isInteractionState, true);
  assert.equal(filtered.canonicalKey, 'https://example.com/products');

  const paginated = classifyUrlSlot('https://example.com/catalog?page=2');
  assert.equal(paginated.isMeaningfulPage, false);
  assert.equal(paginated.isInteractionState, true);
  assert.equal(paginated.canonicalKey, 'https://example.com/catalog');
});

test('isSameRegistrableDomain identifies cross-domain boundaries', () => {
  assert.equal(isSameRegistrableDomain('https://shop.example.com/item/1', 'https://example.com'), true);
  assert.equal(isSameRegistrableDomain('https://checkout.example.com', 'https://www.example.com'), true);
  assert.equal(isSameRegistrableDomain('https://phishing-example.com', 'https://example.com'), false);
  assert.equal(isSameRegistrableDomain('https://google.com', 'https://example.com'), false);
});
