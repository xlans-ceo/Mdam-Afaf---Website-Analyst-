import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { LiveProvider } from '../src/lib/providers/index';
import { ScanResult } from '../src/types/contract';

interface BenchScenarioResult {
  scenario: string;
  url: string;
  wallClockMs: number;
  status: string;
  pagesInspected: number;
  findingsCount: number;
  verdictLevel?: string;
  notes: string;
}

async function runBenchmark() {
  console.log('--- STARTING PHASE G0 BASELINE BENCHMARK ---');

  // Create local fixture server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 1. Fast site
    if (pathname === '/fixtures/fast') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>Fast Site</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>موقع سريع</h1><p>محتوى الموقع السريع</p></body></html>`);
      return;
    }

    // 2. Slow site (each page takes 3 seconds)
    if (pathname === '/fixtures/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>Slow Site</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><h1>موقع بطيء</h1><p>استجابة بعد 3 ثواني</p></body></html>`);
      }, 3000);
      return;
    }

    // 3. Server that never sends headers
    if (pathname === '/fixtures/no-headers') {
      // Just keep connection open without writing anything
      return;
    }

    // 4. Server that sends headers then stalls the body
    if (pathname === '/fixtures/stall-body') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write('<!DOCTYPE html><html><head><title>Stalled Body</title></head><body><h1>Stalled');
      // Intentionally do not call res.end() to stall
      return;
    }

    // 5. 50MB body
    if (pathname === '/fixtures/large-50mb') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const chunk = '<div>' + 'A'.repeat(1024 * 64) + '</div>\n'; // 64KB chunk
      const targetBytes = 50 * 1024 * 1024;
      let sentBytes = 0;
      res.write('<!DOCTYPE html><html><head><title>50MB Page</title></head><body>');
      function writeMore() {
        while (sentBytes < targetBytes) {
          sentBytes += chunk.length;
          const ok = res.write(chunk);
          if (!ok) {
            res.once('drain', writeMore);
            return;
          }
        }
        res.end('</body></html>');
      }
      writeMore();
      return;
    }

    // 6. Redirect chain longer than limit (e.g. 10 hops)
    if (pathname.startsWith('/fixtures/redirect-chain/')) {
      const hop = parseInt(pathname.split('/')[3] || '0', 10);
      const nextHop = hop + 1;
      res.writeHead(302, { Location: `/fixtures/redirect-chain/${nextHop}` });
      res.end();
      return;
    }

    // 7. Page with an <img> pointing to a private IP
    if (pathname === '/fixtures/private-img') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="ar"><head><title>Private Img</title></head><body>
        <h1>فحص صورة لعنوان داخلي</h1>
        <img src="http://127.0.0.1:9999/secret.png" alt="صورة داخلية" />
        <img src="http://169.254.169.254/latest/meta-data/" alt="بيانات سحابية" />
      </body></html>`);
      return;
    }

    // 8. 10-page site with a failing sitemap
    if (pathname === '/fixtures/ten-pages') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      let links = '';
      for (let i = 1; i <= 10; i++) {
        links += `<a href="/fixtures/ten-pages/p${i}">صفحة فرعية ${i}</a>\n`;
      }
      res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><title>Ten Pages Site</title></head><body>
        <nav>${links}</nav>
        <h1>الصفحة الرئيسية</h1>
      </body></html>`);
      return;
    }

    if (pathname.startsWith('/fixtures/ten-pages/p')) {
      const pageNum = pathname.split('/')[3] || '1';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="ar"><head><title>Page ${pageNum}</title></head><body><h1>صفحة رقم ${pageNum}</h1></body></html>`);
      return;
    }

    // Sitemaps for ten-pages (failing sitemap)
    if (pathname === '/sitemap.xml') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Sitemap Error 500');
      return;
    }

    // 9. PSI unavailable
    if (pathname === '/fixtures/psi-unavailable') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html lang="ar"><head><title>PSI Unavailable Site</title></head><body><h1>موقع بدون PSI</h1></body></html>`);
      return;
    }

    // Robots.txt
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as { port: number; address: string };
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Local fixture server listening on ${baseUrl}`);

  const scenarios = [
    { name: 'fast_site', url: `${baseUrl}/fixtures/fast` },
    { name: 'slow_site_3s', url: `${baseUrl}/fixtures/slow` },
    { name: 'no_headers', url: `${baseUrl}/fixtures/no-headers` },
    { name: 'stalled_body', url: `${baseUrl}/fixtures/stall-body` },
    { name: 'large_50mb', url: `${baseUrl}/fixtures/large-50mb` },
    { name: 'redirect_chain_exceeded', url: `${baseUrl}/fixtures/redirect-chain/1` },
    { name: 'img_pointing_private_ip', url: `${baseUrl}/fixtures/private-img` },
    { name: 'ten_pages_failing_sitemap', url: `${baseUrl}/fixtures/ten-pages` },
    { name: 'psi_unavailable', url: `${baseUrl}/fixtures/psi-unavailable` }
  ];

  const results: BenchScenarioResult[] = [];
  const provider = new LiveProvider();

  for (const sc of scenarios) {
    console.log(`\nExecuting benchmark: ${sc.name} (${sc.url})...`);
    const start = Date.now();
    let status = 'completed';
    let pagesInspected = 0;
    let findingsCount = 0;
    let verdictLevel: string | undefined;
    let notes = '';

    // Wrap runScan with a 25s safety deadline for stalled tests so the bench script doesn't hang forever
    try {
      const scanPromise = provider.runScan(
        `bench_${sc.name}`,
        { url: sc.url, locale: 'ar-EG' },
        (ev) => {
          if (ev.type === 'page') {
            pagesInspected = ev.index;
          }
        }
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('BENCH_TEST_TIMEOUT: exceeded 25s test harness safety timeout')), 25000);
      });

      const scanResult: ScanResult = await Promise.race([scanPromise, timeoutPromise]);
      pagesInspected = scanResult.uniquePagesInspected;
      findingsCount = scanResult.findings?.length || 0;
      verdictLevel = scanResult.verdict?.level;
      status = scanResult.status || 'completed';
      notes = scanResult.siteStatus ? `siteStatus: ${scanResult.siteStatus.state}` : 'scan completed';
    } catch (err: any) {
      status = 'failed_or_timeout';
      notes = String(err?.message || err);
    }

    const wallClockMs = Date.now() - start;
    console.log(`  -> Finished in ${wallClockMs}ms. Status: ${status}, Pages: ${pagesInspected}, Notes: ${notes}`);

    results.push({
      scenario: sc.name,
      url: sc.url,
      wallClockMs,
      status,
      pagesInspected,
      findingsCount,
      verdictLevel,
      notes
    });
  }

  // B4.7: Concurrency benchmarks (1, 3, 10, 30 concurrent)
  const concurrencyLevels = [1, 3, 10, 30];
  const concurrencyResults: Array<{
    concurrent: number;
    totalWallClockMs: number;
    avgPerScanMs: number;
    successCount: number;
  }> = [];

  for (const c of concurrencyLevels) {
    console.log(`\nExecuting concurrency test: ${c} simultaneous scans...`);
    const cStart = Date.now();
    const promises = Array.from({ length: c }, (_, i) =>
      provider.runScan(`bench_c${c}_${i}`, { url: `${baseUrl}/fixtures/fast`, locale: 'ar-EG' }, () => {})
    );
    const outcomes = await Promise.allSettled(promises);
    const cElapsed = Date.now() - cStart;
    const successCount = outcomes.filter(o => o.status === 'fulfilled').length;
    concurrencyResults.push({
      concurrent: c,
      totalWallClockMs: cElapsed,
      avgPerScanMs: Math.round(cElapsed / c),
      successCount
    });
    console.log(`  -> ${c} concurrent finished in ${cElapsed}ms (${successCount}/${c} passed)`);
  }

  server.close();

  // Ensure docs directory exists
  const docsDir = path.resolve(process.cwd(), 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  const outputPath = path.join(docsDir, 'bench-after.json');
  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        benchmarkDate: new Date().toISOString(),
        nodeVersion: process.version,
        phase: 'B4_RELEASE_ALPHA',
        scenarios: results,
        concurrency: concurrencyResults
      },
      null,
      2
    ),
    'utf-8'
  );

  console.log(`\nSaved benchmark results to ${outputPath}`);
}

runBenchmark().catch((err) => {
  console.error('Benchmark script failed:', err);
  process.exit(1);
});
