import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEcommerceSignals, DEFAULT_THRESHOLDS } from './ecommerce-detector';

test('detectEcommerceSignals detects standard vs ecommerce signals', () => {
  const normalBlog = `
    <html>
      <head><title>My Personal Engineering Blog</title></head>
      <body>
        <h1>Articles on distributed systems</h1>
        <p>Today we talk about consensus protocols.</p>
        <a href="/about">About me</a>
      </body>
    </html>
  `;
  const blogResult = detectEcommerceSignals(normalBlog, ['/about', '/posts/raft']);
  assert.equal(blogResult.isEcommerce, false);
  assert.equal(blogResult.isLargeStore, false);

  const ecommerceHtml = `
    <html>
      <head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Product", "name": "Classic Oxford Shoes"}
        </script>
      </head>
      <body>
        <h1>Classic Oxford Shoes</h1>
        <div class="price">1250 EGP</div>
        <button class="add-to-cart">أضف للسلة</button>
        <a href="/cart">عربة التسوق</a>
      </body>
    </html>
  `;
  const storeResult = detectEcommerceSignals(ecommerceHtml, [
    '/category/shoes',
    '/products/oxford-black',
    '/cart'
  ]);
  assert.equal(storeResult.isEcommerce, true);
  assert.equal(storeResult.isLargeStore, false);
  assert.ok(storeResult.confidence >= 0.5);
});

test('detectEcommerceSignals identifies large store when thresholds are exceeded', () => {
  const storeHtml = `
    <html>
      <body>
        <div class="product">Product Page</div>
        <button>Add to Cart</button>
        <a href="/cart">Cart</a>
      </body>
    </html>
  `;

  // Generate 25 distinct category links (exceeding default category threshold 20)
  const categoryLinks = Array.from({ length: 25 }, (_, i) => `/category/dept-${i}`);
  const largeResult = detectEcommerceSignals(storeHtml, categoryLinks, DEFAULT_THRESHOLDS);

  assert.equal(largeResult.isEcommerce, true);
  assert.equal(largeResult.isLargeStore, true);
  assert.ok(largeResult.largeStoreReasonAr?.includes('متجر إلكتروني كبير'));
});
