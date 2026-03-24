export type InvestigationEventType =
  | "started"
  | "streaming_url"
  | "progress"
  | "heartbeat"
  | "fingerprint"
  | "candidate_found"
  | "complete"
  | "mock";

export interface BrandFingerprint {
  brandName: string;
  productName: string;
  officialUrl: string;
  domain: string;
  authorizedDomains: string[];
  authorizedChannels: string[];
  knownProducts: string[];
  claims: string[];
  visualMotifs: string[];
  referencePrice: number;
  currency: string;
}

export interface ListingCandidate {
  id: string;
  source: "tinyfish" | "mock";
  marketplace: string;
  url: string;
  title: string;
  sellerId: string;
  sellerName: string;
  price: number;
  currency: string;
  condition: string;
  signalTags: string[];
  counterfeitRisk: number;
  sellerFraudRisk: number;
  confidence: number;
  reasoning: string[];
}

export interface SellerProfile {
  id: string;
  sellerName: string;
  marketplace: string;
  storefrontUrl: string;
  location: string;
  rating: number;
  reviewCount: number;
  accountAgeDays: number;
  responseTimeHours: number;
  transactionVolume: number;
  redFlags: string[];
  linkedListingIds: string[];
  counterfeitRisk: number;
  sellerFraudRisk: number;
  summary: string;
}

export interface CaseDossier {
  caseId: string;
  generatedAt: string;
  officialUrl: string;
  brandFingerprint: BrandFingerprint;
  selectedCandidateIds: string[];
  selectedCandidates: ListingCandidate[];
  sellerProfiles: SellerProfile[];
  primarySeller: SellerProfile | null;
  findings: string[];
  evidence: string[];
  recommendedActions: string[];
  riskSummary: {
    counterfeitRisk: number;
    sellerFraudRisk: number;
    confidence: number;
  };
}

export interface MarketplacePacket {
  caseId: string;
  subject: string;
  summary: string;
  prioritizedListings: Array<{
    candidateId: string;
    marketplace: string;
    title: string;
    sellerName: string;
    url: string;
    counterfeitRisk: number;
    sellerFraudRisk: number;
  }>;
  evidence: string[];
  takedownTargets: string[];
  narrative: string;
}

export interface AuthorityPacket {
  caseId: string;
  subject: string;
  summary: string;
  allegations: string[];
  evidence: string[];
  requestedActions: string[];
  narrative: string;
}

export interface InvestigationEvent {
  type: InvestigationEventType;
  timestamp: string;
  runId: string;
  message?: string;
  streamingUrl?: string;
  probeLabel?: string;
  result?: {
    candidate?: ListingCandidate;
    candidates?: ListingCandidate[];
    brandFingerprint?: BrandFingerprint;
    sellerProfiles?: SellerProfile[];
    completedAgents?: number;
    totalAgents?: number;
  };
}

export interface InvestigationRun {
  runId: string;
  brandFingerprint: BrandFingerprint;
  candidates: ListingCandidate[];
  sellerProfiles: SellerProfile[];
  events: InvestigationEvent[];
}
