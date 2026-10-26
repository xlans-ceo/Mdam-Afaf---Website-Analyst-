import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCAN_LIMITS } from '../config/limits.server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (typeof process !== 'undefined' && process.versions?.node) {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const rawEnv: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? process.env : {};

const LEGACY_MODELS = new Set([
  'gemini-2.5-flash',
  'models/gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-pro'
]);

function resolveGeminiModel(rawModel?: string): string {
  const trimmed = (rawModel || '').trim();
  if (!trimmed || LEGACY_MODELS.has(trimmed)) {
    return 'gemini-3.8-flash';
  }
  return trimmed;
}

const envSchema = z.object({
  SCAN_MODE: z.enum(['mock', 'live']).default('live'),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  AI_ENABLED: z.string().default('true').transform(v => v !== 'false'),
  PORT: z.coerce.number().default(3000)
});

const parsedEnv = envSchema.parse({
  SCAN_MODE: rawEnv.SCAN_MODE,
  GEMINI_MODEL: resolveGeminiModel(rawEnv.GEMINI_MODEL),
  AI_ENABLED: rawEnv.AI_ENABLED,
  PORT: rawEnv.PORT
});

export const AppConfig = {
  ...parsedEnv,
  get FREE_SCANS_HARD_DISABLED(): boolean {
    return SCAN_LIMITS.FREE_SCANS_HARD_DISABLED;
  },
  get ECOMMERCE_MAX_PAGES(): number {
    return SCAN_LIMITS.ECOMMERCE_MAX_PAGES;
  }
};
