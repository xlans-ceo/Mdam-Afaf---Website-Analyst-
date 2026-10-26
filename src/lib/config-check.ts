/**
 * Startup Configuration & Environment Audit (PHASE J1 - C4)
 * Prints a table (name | set/unset | used by) with NO secret values,
 * and warns about unused GLM_*, PSI_*, MAX_*, ECOMMERCE_*, LIGHTHOUSE_*, SCAN_*, DOMAIN_*, REPORT_* variables.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ConfigVarDefinition {
  name: string;
  usedBy: string;
}

export const RECOGNIZED_ENV_VARS: readonly ConfigVarDefinition[] = [
  {
    name: 'GEMINI_API_KEY',
    usedBy: 'src/lib/ai-consultant.ts, src/lib/explain-service.ts, src/lib/capabilities.ts'
  },
  {
    name: 'GEMINI_MODEL',
    usedBy: 'src/lib/config.ts'
  },
  {
    name: 'AI_ENABLED',
    usedBy: 'src/lib/config.ts'
  },
  {
    name: 'PSI_API_KEY',
    usedBy: 'src/lib/capabilities.ts, src/lib/providers/index.ts'
  },
  {
    name: 'PSI_TIMEOUT_S',
    usedBy: 'src/config/limits.server.ts'
  },
  {
    name: 'VISITOR_ID_SALT',
    usedBy: 'src/lib/storage.ts'
  },
  {
    name: 'FIREBASE_SERVER_EMAIL',
    usedBy: 'src/lib/firestore-probe.ts'
  },
  {
    name: 'FIREBASE_SERVER_PASSWORD',
    usedBy: 'src/lib/firestore-probe.ts'
  },
  {
    name: 'ADMIN_TOKEN',
    usedBy: 'src/lib/config-check.ts, server.ts'
  },
  {
    name: 'MAX_CONCURRENT_SCANS_GLOBAL',
    usedBy: 'src/config/limits.server.ts'
  },
  {
    name: 'MAX_CONCURRENT_SCANS_PER_IP',
    usedBy: 'src/config/limits.server.ts'
  },
  {
    name: 'ECOMMERCE_MAX_PAGES',
    usedBy: 'src/config/limits.server.ts'
  },
  {
    name: 'FREE_SCANS_HARD_DISABLED',
    usedBy: 'src/config/limits.server.ts'
  },
  {
    name: 'TRUST_PROXY_HOPS',
    usedBy: 'src/config/limits.server.ts, server.ts'
  },
  {
    name: 'APP_URL',
    usedBy: 'src/config/limits.server.ts'
  },
  {
    name: 'RESCAN_SAME_PAGES_FREE',
    usedBy: 'src/config/limits.server.ts, src/lib/storage.ts'
  },
  {
    name: 'SCAN_MODE',
    usedBy: 'src/lib/config.ts'
  },
  {
    name: 'PORT',
    usedBy: 'src/lib/config.ts, server.ts'
  },
  {
    name: 'NODE_ENV',
    usedBy: 'server.ts, src/lib/storage.ts'
  },
  {
    name: 'VOICE_LIVE_ENABLED',
    usedBy: 'src/lib/config.ts, server.ts'
  },
  {
    name: 'DEEP_SCAN_ENABLED',
    usedBy: 'src/lib/providers/deep-scan.ts'
  }
] as const;

const RECOGNIZED_SET = new Set(RECOGNIZED_ENV_VARS.map(v => v.name));

const PLACEHOLDER_VALUES = new Set([
  'MY_GEMINI_API_KEY',
  'YOUR_PSI_API_KEY',
  'YOUR_GLM_API_KEY_HERE',
  'change_me_in_production',
  'madam-afaf-default-visitor-salt-v2'
]);

const WATCHED_UNUSED_PREFIX =
  /^(GLM_|PSI_|MAX_|ECOMMERCE_|LIGHTHOUSE_|SCAN_|DOMAIN_|REPORT_|STANDARD_)/;

export interface ConfigCheckReport {
  rows: { name: string; status: 'set' | 'unset'; usedBy: string }[];
  warnings: string[];
  visitorIdSaltValid: boolean;
  text: string;
  formattedText: string;
}

export function buildConfigCheckReport(
  env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env
    ? process.env
    : {}
): ConfigCheckReport {
  const rows = RECOGNIZED_ENV_VARS.map(def => {
    const raw = (env[def.name] || '').trim();
    const isSet = Boolean(raw && !PLACEHOLDER_VALUES.has(raw));
    return {
      name: def.name,
      status: (isSet ? 'set' : 'unset') as 'set' | 'unset',
      usedBy: def.usedBy
    };
  });

  const warnings: string[] = [];
  const rawSalt = (env.VISITOR_ID_SALT || '').trim();
  const visitorIdSaltValid = Boolean(
    rawSalt && rawSalt.length >= 32 && !PLACEHOLDER_VALUES.has(rawSalt)
  );
  if (rawSalt && !visitorIdSaltValid) {
    warnings.push('⚠️ VISITOR_ID_SALT: القيمة قصيرة (أقل من 32 حرف) أو افتراضية غير صالحة للإنتاج');
  }

  for (const key of Object.keys(env).sort()) {
    const val = (env[key] || '').trim();
    if (!val) continue;
    if (!RECOGNIZED_SET.has(key) && WATCHED_UNUSED_PREFIX.test(key)) {
      warnings.push(`⚠️ ${key}: متغير موجود ومش مستخدم`);
    }
  }

  const nameWidth = Math.max(28, ...rows.map(r => r.name.length));
  const statusWidth = 8;
  const header = `${'name'.padEnd(nameWidth)} | ${'set/unset'.padEnd(statusWidth)} | used by`;
  const divider = `${'-'.repeat(nameWidth)}-+-${'-'.repeat(statusWidth)}-+-${'-'.repeat(48)}`;
  const bodyLines = rows.map(
    r => `${r.name.padEnd(nameWidth)} | ${r.status.padEnd(statusWidth)} | ${r.usedBy}`
  );

  const lines = [header, divider, ...bodyLines];
  if (warnings.length > 0) {
    lines.push('');
    lines.push(...warnings);
  }

  const text = lines.join('\n');
  return {
    rows,
    warnings,
    visitorIdSaltValid,
    text,
    formattedText: text
  };
}

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
  const report = buildConfigCheckReport(process.env);
  console.log(report.text);
}
