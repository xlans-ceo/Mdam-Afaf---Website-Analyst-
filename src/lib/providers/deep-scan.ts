/**
 * Provider-agnostic interfaces and scaffolding for Deep Scan (K0.6).
 * Contains Disabled and Fake test implementations.
 */

export type DeepScanVerdict = 'confirmed' | 'needs_validation' | 'rejected';

export interface DeepScanEvidence {
  type: string;
  value: string;
  location?: string;
}

export interface DeepScanFinding {
  id: string;
  ruleId: string;
  category: 'security' | 'responsive' | 'performance' | 'rendering';
  titleAr: string;
  verdict: DeepScanVerdict;
  evidence: DeepScanEvidence[];
}

export interface SecurityDeepProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  runSecurityAudit(targetUrl: string, options?: { domainOwnershipVerified: boolean }): Promise<DeepScanFinding[]>;
}

export interface BrowserChecksProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  runRenderChecks(targetUrl: string): Promise<DeepScanFinding[]>;
}

export class DisabledSecurityDeepProvider implements SecurityDeepProvider {
  public readonly name = 'disabled-security-deep';

  public async isAvailable(): Promise<boolean> {
    return false;
  }

  public async runSecurityAudit(): Promise<DeepScanFinding[]> {
    throw new Error('الفحص الأمني العميق غير مفعّل حالياً.');
  }
}

export class FakeSecurityDeepProvider implements SecurityDeepProvider {
  public readonly name = 'fake-security-deep';

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async runSecurityAudit(_targetUrl: string, options?: { domainOwnershipVerified: boolean }): Promise<DeepScanFinding[]> {
    if (!options?.domainOwnershipVerified) {
      return [
        {
          id: 'fake-sec-1',
          ruleId: 'SEC_DEEP_OWNERSHIP',
          category: 'security',
          titleAr: 'يلزم إثبات ملكية الدومين قبل إجراء الفحص الأمني المتقدم',
          verdict: 'needs_validation',
          evidence: [{ type: 'dns_check', value: 'No verification record found' }]
        }
      ];
    }
    return [
      {
        id: 'fake-sec-2',
        ruleId: 'SEC_DEEP_CORS',
        category: 'security',
        titleAr: 'سياسة تبادل الموارد بين الأصول (CORS) سليمة ومحمية',
        verdict: 'confirmed',
        evidence: [{ type: 'cors_header', value: 'Access-Control-Allow-Origin: null' }]
      }
    ];
  }
}

export class DisabledBrowserChecksProvider implements BrowserChecksProvider {
  public readonly name = 'disabled-browser-checks';

  public async isAvailable(): Promise<boolean> {
    return false;
  }

  public async runRenderChecks(): Promise<DeepScanFinding[]> {
    throw new Error('فحص المتصفح الحقيقي غير مفعّل في هذه البيئة.');
  }
}

export class FakeBrowserChecksProvider implements BrowserChecksProvider {
  public readonly name = 'fake-browser-checks';

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async runRenderChecks(): Promise<DeepScanFinding[]> {
    return [
      {
        id: 'fake-render-1',
        ruleId: 'RENDER_OVERFLOW_320',
        category: 'responsive',
        titleAr: 'لا يوجد تمرير أفقي على شاشة 320px',
        verdict: 'confirmed',
        evidence: [{ type: 'scrollWidth', value: '320px <= 320px' }]
      }
    ];
  }
}

export const GLM_CONFIG = {
  get GLM_API_KEY(): string {
    return (process.env.GLM_API_KEY || '').trim();
  },
  get GLM_BASE_URL(): string {
    return (process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').trim();
  },
  get GLM_MODEL(): string {
    return (process.env.GLM_MODEL || 'glm-5.3').trim();
  },
  get GLM_ENABLED(): boolean {
    return process.env.GLM_ENABLED === 'true' && Boolean(process.env.GLM_API_KEY);
  }
};
