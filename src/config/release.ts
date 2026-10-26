/**
 * Madam Afaf - Release Configuration (B4.5)
 */
export const RELEASE_CONFIG = {
  stage: 'alpha' as const,
  stageNameAr: 'نسخة تجريبية (Alpha)',
  appVersion: '0.1.0-alpha.1',
  rulesetVersion: '2.1.0',
  schemaVersion: '2.0',
  releasedAt: '2026-10-26',
  badgeTextAr: 'نسخة تجريبية (Alpha) v0.1.0-alpha.1'
};

export interface ReleaseInfo {
  stage: 'alpha' | 'beta' | 'stable';
  appVersion: string;
  rulesetVersion: string;
  schemaVersion: string;
  badgeTextAr: string;
}

export function getReleaseInfo(): ReleaseInfo {
  return {
    stage: RELEASE_CONFIG.stage,
    appVersion: RELEASE_CONFIG.appVersion,
    rulesetVersion: RELEASE_CONFIG.rulesetVersion,
    schemaVersion: RELEASE_CONFIG.schemaVersion,
    badgeTextAr: RELEASE_CONFIG.badgeTextAr
  };
}
