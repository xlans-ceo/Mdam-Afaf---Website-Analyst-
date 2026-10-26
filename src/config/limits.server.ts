/**
 * Server-only scanner limits with environment variable overrides.
 * Client code must NEVER import this module.
 * C2: Single reader of numeric/boolean scanner environment overrides.
 */
import { SCAN_LIMITS as BASE_LIMITS } from './limits';

export const APP_URL = (process.env.APP_URL || '').trim() || 'https://madam-afaf.app';
export const BOT_USER_AGENT = `MadamAfafBot/2.0 (+${APP_URL})`;

export const SCAN_LIMITS = {
  ...BASE_LIMITS,
  ECOMMERCE_MAX_PAGES: Number(process.env.ECOMMERCE_MAX_PAGES) || BASE_LIMITS.ECOMMERCE_MAX_PAGES,
  PSI_TIMEOUT_S: Number(process.env.PSI_TIMEOUT_S) || BASE_LIMITS.PSI_TIMEOUT_S,
  MAX_CONCURRENT_SCANS_GLOBAL:
    Number(process.env.MAX_CONCURRENT_SCANS_GLOBAL) || BASE_LIMITS.MAX_CONCURRENT_SCANS_GLOBAL,
  MAX_CONCURRENT_SCANS_PER_IP:
    Number(process.env.MAX_CONCURRENT_SCANS_PER_IP) || BASE_LIMITS.MAX_CONCURRENT_SCANS_PER_IP,
  MAX_QUEUE_LENGTH:
    Number(process.env.MAX_QUEUE_LENGTH) || BASE_LIMITS.MAX_QUEUE_LENGTH || 10,
  get FREE_SCANS_HARD_DISABLED(): boolean {
    return (process.env.FREE_SCANS_HARD_DISABLED || '').trim() === 'true';
  },
  get RESCAN_SAME_PAGES_FREE(): boolean {
    return (process.env.RESCAN_SAME_PAGES_FREE || '').trim() === 'true';
  },
  get TRUST_PROXY_HOPS(): number {
    const rawHops = process.env.TRUST_PROXY_HOPS;
    if (rawHops !== undefined && rawHops.trim() !== '' && !isNaN(Number(rawHops))) {
      return Number(rawHops);
    }
    return process.env.K_SERVICE ? 1 : 0;
  },
  APP_URL,
  BOT_USER_AGENT
} as const;
