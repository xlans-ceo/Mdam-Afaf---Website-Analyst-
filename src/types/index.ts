export type JobStatus = 
  | 'queued' 
  | 'running' 
  | 'completed' 
  | 'partial' 
  | 'failed' 
  | 'cancelled' 
  | 'unsupported_large_ecommerce';

export type JobStage = 
  | 'validating' 
  | 'discovering' 
  | 'interacting' 
  | 'auditing' 
  | 'reporting' 
  | 'done';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'improvement';

export type FindingConfidence = 'confirmed' | 'likely' | 'unverified';

export type FindingStatusType = 
  | 'confirmed_defect' 
  | 'suspected_issue' 
  | 'unverified_behavior' 
  | 'recommendation';

export type FindingCategory = 
  | 'navigation' 
  | 'responsive' 
  | 'performance' 
  | 'seo' 
  | 'accessibility' 
  | 'forms' 
  | 'ajax' 
  | 'visual';

export interface Finding {
  id: string;
  category: FindingCategory;
  title: string;
  titleAr: string;
  explanationAr: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  statusType: FindingStatusType;
  affectedUrl: string;
  reproductionStepsAr?: string[];
  evidenceReferences?: string[];
  observedBehavior: string;
  expectedBehavior?: string;
  recommendedFixAr: string;
  recommendedFixEn?: string;
  sourceOfEvidence: string;
  technicalDetails?: {
    selector?: string;
    httpStatus?: number;
    consoleErrors?: string[];
    failedRequests?: string[];
    lighthouseScore?: number;
    viewport?: string;
  };
}

export interface InspectedPage {
  url: string;
  title?: string;
  statusCode: number;
  isMeaningful: boolean;
  pageType: 'homepage' | 'about' | 'contact' | 'category' | 'product' | 'service' | 'general';
  interactionStatesTested: number;
}

export interface ScanJob {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  registrableDomain: string;
  status: JobStatus;
  stage: JobStage;
  progressPercent: number;
  stageMessageAr: string;
  visitorId: string;
  websitePurpose?: string;
  mainJourney?: string;
  createdAt: number;
  completedAt?: number;
  errorMessageAr?: string;
  stats: {
    uniquePagesInspected: number;
    interactionStatesTested: number;
    maxPagesAllowed: number;
    isEcommerce: boolean;
    ecommerceConfidence?: number;
    durationMs: number;
  };
  inspectedPages: InspectedPage[];
  findings: Finding[];
  repairPrompt?: {
    masterPrompt: string;
    individualPrompts: Record<string, string>;
  };
  summaryAr?: string;
}


