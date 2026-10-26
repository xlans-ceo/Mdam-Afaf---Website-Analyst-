/**
 * Release Preflight Script (B4.6)
 * Runs `npm run preflight`
 * Produces GO/NO-GO table and exits non-zero if any required check fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { validateVisitorIdSalt } from '../src/lib/storage';
import { RELEASE_CONFIG } from '../src/config/release';

interface PreflightCheck {
  id: string;
  name: string;
  required: boolean;
  status: 'GO' | 'NO-GO' | 'WARN';
  detail: string;
}

async function runPreflight() {
  console.log('================================================================');
  console.log(`        فحص الجاهزية للإطلاق — مدام عفاف (${RELEASE_CONFIG.badgeTextAr})        `);
  console.log('================================================================\n');

  const checks: PreflightCheck[] = [];

  // 1. VISITOR_ID_SALT
  try {
    const saltResult = validateVisitorIdSalt(process.env);
    const saltLen = (saltResult.salt || '').length;
    checks.push({
      id: 'salt',
      name: 'VISITOR_ID_SALT (HMAC Secret)',
      required: true,
      status: saltLen >= 32 ? 'GO' : 'NO-GO',
      detail: `Length: ${saltLen} characters`
    });
  } catch (err: any) {
    checks.push({
      id: 'salt',
      name: 'VISITOR_ID_SALT (HMAC Secret)',
      required: true,
      status: 'NO-GO',
      detail: err?.message || 'Salt validation failed'
    });
  }

  // 2. ADMIN_TOKEN
  const adminToken = (process.env.ADMIN_TOKEN || '').trim();
  if (adminToken.length === 0) {
    checks.push({
      id: 'admin_token',
      name: 'ADMIN_TOKEN (Read-Only Admin)',
      required: false,
      status: 'GO',
      detail: 'Admin endpoint is safely disabled (ADMIN_TOKEN not set)'
    });
  } else if (adminToken.length >= 32) {
    checks.push({
      id: 'admin_token',
      name: 'ADMIN_TOKEN (Read-Only Admin)',
      required: true,
      status: 'GO',
      detail: `Length: ${adminToken.length} characters (>=32)`
    });
  } else {
    checks.push({
      id: 'admin_token',
      name: 'ADMIN_TOKEN (Read-Only Admin)',
      required: true,
      status: 'NO-GO',
      detail: `Length: ${adminToken.length} is less than required 32 characters`
    });
  }

  // 3. External API Configurations (PSI & Gemini)
  const psiKey = (process.env.PSI_API_KEY || '').trim();
  const psiOk = Boolean(psiKey && psiKey !== 'YOUR_PSI_API_KEY');
  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const geminiOk = Boolean(geminiKey && geminiKey !== 'YOUR_GEMINI_API_KEY');

  checks.push({
    id: 'external_apis',
    name: 'External Providers (PSI & Gemini)',
    required: false,
    status: psiOk && geminiOk ? 'GO' : 'WARN',
    detail: `PSI: ${psiOk ? 'Configured' : 'Missing (Lab fallback)'} | Gemini: ${geminiOk ? 'Configured' : 'Missing'}`
  });

  // 4. Persistence Durability
  const emailSet = Boolean(process.env.FIREBASE_SERVER_EMAIL);
  const passwordSet = Boolean(process.env.FIREBASE_SERVER_PASSWORD);
  const emailLooksLikeEmail = Boolean(emailSet && process.env.FIREBASE_SERVER_EMAIL?.includes('@') && process.env.FIREBASE_SERVER_EMAIL?.split('@')[1]?.includes('.'));
  checks.push({
    id: 'persistence',
    name: 'Storage Durability (Firestore vs FileStore)',
    required: false,
    status: emailLooksLikeEmail && passwordSet ? 'GO' : 'WARN',
    detail: emailLooksLikeEmail && passwordSet ? 'Durable Firestore eligible' : 'FileStore active (non-durable notice served)'
  });

  // 5. .gitignore entries
  const gitignorePath = path.resolve(process.cwd(), '.gitignore');
  const gitignoreSrc = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const requiredIgnores = ['data/', '.tts-cache.json', '.aistudio/', '.playwright-cli/'];
  const missingIgnores = requiredIgnores.filter(entry => !gitignoreSrc.includes(entry));
  checks.push({
    id: 'gitignore',
    name: '.gitignore Security Entries',
    required: true,
    status: missingIgnores.length === 0 ? 'GO' : 'NO-GO',
    detail: missingIgnores.length === 0 ? 'All 4 required entries present' : `Missing: ${missingIgnores.join(', ')}`
  });

  // 6. No Product Phone or WhatsApp numbers in codebase
  const bannedContacts = ['wa.me/20', 'whatsapp.com/send?phone=20', 'tel:+201'];
  let foundBanned = false;
  let bannedLocation = '';
  const srcFiles = ['src/components/Header.tsx', 'src/components/MadamAfafHero.tsx', 'src/components/ReportView.tsx', 'src/components/PrivacyPage.tsx', 'src/components/TermsPage.tsx'];
  for (const f of srcFiles) {
    const full = path.resolve(process.cwd(), f);
    if (fs.existsSync(full)) {
      const c = fs.readFileSync(full, 'utf-8');
      for (const b of bannedContacts) {
        if (c.includes(b)) {
          foundBanned = true;
          bannedLocation = `${f} (${b})`;
          break;
        }
      }
    }
  }
  checks.push({
    id: 'contacts',
    name: 'Single Official Contact (LinkedIn Only)',
    required: true,
    status: foundBanned ? 'NO-GO' : 'GO',
    detail: foundBanned ? `Banned phone/wa found in ${bannedLocation}` : 'Verified: LinkedIn only'
  });

  // 7. Client Bundle Check (dist assets must not contain forbidden secrets)
  const distAssetsDir = path.resolve(process.cwd(), 'dist/assets');
  if (fs.existsSync(distAssetsDir)) {
    const jsFiles = fs.readdirSync(distAssetsDir).filter(f => f.endsWith('.js'));
    let leakFound: string | null = null;
    const forbidden = ['process.cwd', 'dotenv', 'node:fs', 'firestore.googleapis.com', 'identitytoolkit.googleapis.com'];
    for (const file of jsFiles) {
      const code = fs.readFileSync(path.join(distAssetsDir, file), 'utf-8');
      for (const bad of forbidden) {
        if (code.includes(bad)) {
          leakFound = `${file} contains ${bad}`;
          break;
        }
      }
      if (leakFound) break;
    }
    checks.push({
      id: 'bundle_leaks',
      name: 'Client Bundle Isolation (Zero Secret Leaks)',
      required: true,
      status: leakFound ? 'NO-GO' : 'GO',
      detail: leakFound ? `Forbidden token in bundle: ${leakFound}` : `${jsFiles.length} client assets verified clean`
    });
  } else {
    checks.push({
      id: 'bundle_leaks',
      name: 'Client Bundle Isolation (dist/assets)',
      required: false,
      status: 'WARN',
      detail: 'dist/assets not built yet (run npm run build first)'
    });
  }

  // 8. Package Name & Version
  const pkgPath = path.resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const pkgOk = pkg.name === 'madam-afaf' && pkg.version === '0.1.0-alpha.1';
  checks.push({
    id: 'package_metadata',
    name: 'Package Identity & Semantic Versioning',
    required: true,
    status: pkgOk ? 'GO' : 'NO-GO',
    detail: `Name: ${pkg.name} | Version: ${pkg.version}`
  });

  // Print Table
  console.log('| Check ID           | Result | Details');
  console.log('|--------------------|--------|----------------------------------------------------');
  for (const c of checks) {
    const icon = c.status === 'GO' ? '🟢 GO   ' : c.status === 'WARN' ? '🟡 WARN ' : '🔴 NO-GO';
    console.log(`| ${c.name.padEnd(18, ' ').slice(0, 18)} | ${icon} | ${c.detail}`);
  }
  console.log('|--------------------|--------|----------------------------------------------------\n');

  const hasFatal = checks.some(c => c.required && c.status === 'NO-GO');
  if (hasFatal) {
    console.error('❌ PREFLIGHT FAILED: One or more REQUIRED checks resulted in NO-GO.');
    process.exit(1);
  } else {
    console.log('✅ PREFLIGHT PASSED: All required readiness checks are GO for Alpha.');
    process.exit(0);
  }
}

runPreflight();
