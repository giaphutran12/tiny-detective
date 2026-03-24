import OpenAI from "openai";
import { z } from "zod";
import type {
  AuthorityPacket,
  BrandFingerprint,
  CaseDossier,
  InvestigationRun,
  ListingCandidate,
  MarketplacePacket,
  SellerProfile,
} from "./types";
import { buildMockInvestigation } from "./mock";
import { scoreCounterfeitRisk, scoreSellerFraudRisk } from "./scoring";

export const investigateRequestSchema = z.object({
  officialUrl: z.string().url(),
});

export const caseRequestSchema = z.object({
  selectedCandidateIds: z.array(z.string().min(1)).default([]),
  investigation: z.object({
    runId: z.string().min(1).optional(),
    officialUrl: z.string().url(),
    brandFingerprint: z.custom<BrandFingerprint>(),
    candidates: z.array(z.custom<ListingCandidate>()).default([]),
    sellerProfiles: z.array(z.custom<SellerProfile>()).default([]),
  }),
});

export const reportRequestSchema = z.object({
  caseDossier: z.custom<CaseDossier>(),
});

export function buildSellerCentricCaseDossier(
  selectedCandidateIds: string[],
  investigation: InvestigationRun,
): CaseDossier {
  const selectedCandidates = investigation.candidates.filter((candidate) =>
    selectedCandidateIds.includes(candidate.id),
  );

  const sellers = new Map<string, SellerProfile>();
  for (const candidate of selectedCandidates) {
    const existing =
      sellers.get(candidate.sellerId) ?? buildSellerProfileFromCandidate(candidate, investigation);
    sellers.set(candidate.sellerId, {
      ...existing,
      linkedListingIds: Array.from(
        new Set([...existing.linkedListingIds, candidate.id]),
      ),
      counterfeitRisk: Math.max(existing.counterfeitRisk, candidate.counterfeitRisk),
      sellerFraudRisk: Math.max(existing.sellerFraudRisk, candidate.sellerFraudRisk),
      summary: `${existing.summary} Selected listing ${candidate.title} reinforces the seller pattern.`,
    });
  }

  const sellerProfiles = Array.from(sellers.values()).sort(
    (left, right) => right.sellerFraudRisk - left.sellerFraudRisk,
  );
  const primarySeller = sellerProfiles[0] ?? null;

  const counterfeitRisk = selectedCandidates.length
    ? average(selectedCandidates.map((candidate) => candidate.counterfeitRisk))
    : 0;
  const sellerFraudRisk = selectedCandidates.length
    ? average(selectedCandidates.map((candidate) => candidate.sellerFraudRisk))
    : 0;
  const confidence = selectedCandidates.length
    ? average(selectedCandidates.map((candidate) => candidate.confidence))
    : 0;

  return {
    caseId: `case_${investigation.runId}`,
    generatedAt: new Date().toISOString(),
    officialUrl: investigation.brandFingerprint.officialUrl,
    brandFingerprint: investigation.brandFingerprint,
    selectedCandidateIds,
    selectedCandidates,
    sellerProfiles,
    primarySeller,
    findings: buildFindings(investigation.brandFingerprint, selectedCandidates, sellerProfiles),
    evidence: buildEvidence(selectedCandidates, sellerProfiles),
    recommendedActions: buildRecommendedActions(primarySeller, sellerProfiles),
    riskSummary: {
      counterfeitRisk: Math.round(counterfeitRisk),
      sellerFraudRisk: Math.round(sellerFraudRisk),
      confidence: Math.round(confidence),
    },
  };
}

function buildCaseDescriptor(brand: BrandFingerprint) {
  const productName = brand.knownProducts[0];
  if (!productName || /^core product$/i.test(productName.trim())) {
    return brand.brandName;
  }

  const normalizedBrand = brand.brandName.trim().toLowerCase();
  const normalizedProduct = productName.trim().toLowerCase();
  if (normalizedProduct === normalizedBrand || normalizedProduct.startsWith(`${normalizedBrand} `)) {
    return productName;
  }

  return `${brand.brandName} ${productName}`;
}

function buildSellerProfileFromCandidate(
  candidate: ListingCandidate,
  investigation: InvestigationRun,
): SellerProfile {
  const seller = investigation.sellerProfiles.find((entry) => entry.id === candidate.sellerId);
  if (seller) {
    return seller;
  }

  const sellerFraud = scoreSellerFraudRisk(candidate, {
    rating: 4.2,
    reviewCount: 12,
    accountAgeDays: 90,
    responseTimeHours: 24,
    transactionVolume: 100,
    redFlags: [],
  });
  const counterfeit = scoreCounterfeitRisk(
    investigation.brandFingerprint,
    candidate,
    {
      rating: 4.2,
      reviewCount: 12,
      accountAgeDays: 90,
      responseTimeHours: 24,
      redFlags: [],
    },
  );

  return {
    id: candidate.sellerId,
    sellerName: candidate.sellerName,
    marketplace: candidate.marketplace,
    storefrontUrl: candidate.url,
    location: "unknown",
    rating: 4.2,
    reviewCount: 12,
    accountAgeDays: 90,
    responseTimeHours: 24,
    transactionVolume: 100,
    redFlags: candidate.signalTags,
    linkedListingIds: [candidate.id],
    counterfeitRisk: counterfeit.score,
    sellerFraudRisk: sellerFraud.score,
    summary: `${candidate.sellerName} requires manual review.`,
  };
}

function buildFindings(
  brand: BrandFingerprint,
  candidates: ListingCandidate[],
  sellers: SellerProfile[],
) {
  const descriptor = buildCaseDescriptor(brand);

  if (!candidates.length) {
    return [`No selected candidates were supplied for ${descriptor}.`];
  }

  const primarySeller = sellers[0];
  const findings = [
    `${candidates.length} selected listing${candidates.length === 1 ? "" : "s"} map back to ${primarySeller?.sellerName ?? "a seller cluster"}.`,
    `Pricing and listing signals sit well outside the expected ${descriptor} anchor of ${brand.referencePrice} ${brand.currency}.`,
    primarySeller?.sellerFraudRisk && primarySeller.sellerFraudRisk >= 60
      ? "Seller-level behavior suggests repeated marketplace abuse rather than an isolated listing issue."
      : "Listing-level indicators are stronger than account-level proof, so the package stays evidence-led.",
  ];
  return findings;
}

function buildEvidence(
  candidates: ListingCandidate[],
  sellers: SellerProfile[],
) {
  const evidence = [
    ...candidates.flatMap((candidate) => candidate.reasoning.slice(0, 2)),
    ...sellers.flatMap((seller) => seller.redFlags.slice(0, 2)),
  ];
  return Array.from(new Set(evidence));
}

function buildRecommendedActions(primarySeller: SellerProfile | null, sellers: SellerProfile[]) {
  const actions = [
    "Preserve screenshots, URLs, timestamps, and seller identifiers before issuing notices.",
    "Submit marketplace takedown requests with the strongest seller-linked listings first.",
  ];
  if (primarySeller) {
    actions.push(
      `Prioritize the seller account ${primarySeller.sellerName} because it has the highest fraud profile in the packet.`,
    );
  }
  if (sellers.some((seller) => seller.redFlags.length > 0)) {
    actions.push("Escalate the case to authority channels with clear evidence of repeated red-flag behavior.");
  }
  return actions;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

export function buildMarketplacePacket(dossier: CaseDossier): MarketplacePacket {
  const descriptor = buildCaseDescriptor(dossier.brandFingerprint);
  const prioritizedListings = [...dossier.selectedCandidates]
    .sort((left, right) => right.counterfeitRisk + right.sellerFraudRisk - (left.counterfeitRisk + left.sellerFraudRisk))
    .map((candidate) => ({
      candidateId: candidate.id,
      marketplace: candidate.marketplace,
      title: candidate.title,
      sellerName: candidate.sellerName,
      url: candidate.url,
      counterfeitRisk: candidate.counterfeitRisk,
      sellerFraudRisk: candidate.sellerFraudRisk,
    }));

  const takedownTargets = prioritizedListings.slice(0, 3).map((entry) => entry.url);

  return {
    caseId: dossier.caseId,
    subject: `${descriptor} marketplace enforcement packet`,
    summary: `The selected listings present a seller-linked counterfeit risk profile for ${descriptor}, scored at ${dossier.riskSummary.counterfeitRisk}/100.`,
    prioritizedListings,
    evidence: dossier.evidence,
    takedownTargets,
    narrative: [
      `This packet focuses on ${descriptor} listings that deviate from the official pricing and channel pattern.`,
      `Selected sellers show repeatable red flags, including account age, response behavior, and suspicious listing signals.`,
      `The strongest removal candidates are the listings at the top of the priority list.`,
    ].join(" "),
  };
}

export function buildAuthorityPacket(dossier: CaseDossier): AuthorityPacket {
  const descriptor = buildCaseDescriptor(dossier.brandFingerprint);
  const allegations = [
    "Suspected counterfeit distribution through unauthorized seller accounts.",
    "Seller-level conduct suggests deliberate marketplace abuse and possible fraud.",
  ];
  const requestedActions = [
    "Investigate the seller identity, payment trail, and relisting behavior.",
    "Preserve the associated records for civil enforcement and platform preservation requests.",
    "Treat the highest-risk seller as the primary subject for follow-up.",
  ];

  return {
    caseId: dossier.caseId,
    subject: `${descriptor} authority referral`,
    summary: `This referral packages the selected evidence for ${descriptor} into a seller-centric case with a fraud risk of ${dossier.riskSummary.sellerFraudRisk}/100.`,
    allegations,
    evidence: dossier.evidence,
    requestedActions,
    narrative: [
      `The selected listings for ${descriptor} are consistent with an unauthorized resale pattern that warrants platform and authority review.`,
      `The seller profile shows the kind of repeat behavior that often appears in coordinated counterfeit or fraud cases.`,
      `This packet is drafted to be readable by a marketplace trust team or a public authority reviewer without additional context.`,
    ].join(" "),
  };
}

export async function generateReportNarrative(dossier: CaseDossier) {
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "You draft concise enforcement narratives for IP and fraud investigations. Return valid JSON only.",
          },
          {
            role: "user",
            content: JSON.stringify({
              dossier,
              request:
                "Write concise marketplace and authority narratives, each 3 short paragraphs max, grounded in the provided evidence.",
            }),
          },
        ],
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message.content;
      if (content) {
        const parsed = JSON.parse(content) as {
          marketplaceNarrative?: string;
          authorityNarrative?: string;
        };
        if (parsed.marketplaceNarrative && parsed.authorityNarrative) {
          return parsed;
        }
      }
    } catch {
      // Fall back to deterministic copy below.
    }
  }

  return {
    marketplaceNarrative: buildMarketplacePacket(dossier).narrative,
    authorityNarrative: buildAuthorityPacket(dossier).narrative,
  };
}

export function mockInvestigationForUrl(officialUrl: string) {
  return buildMockInvestigation(officialUrl);
}
