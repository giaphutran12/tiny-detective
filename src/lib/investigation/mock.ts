import { createHash, randomUUID } from "crypto";
import type {
  BrandFingerprint,
  InvestigationEvent,
  InvestigationRun,
  ListingCandidate,
  SellerProfile,
} from "./types";
import { scoreCounterfeitRisk, scoreSellerFraudRisk } from "./scoring";

type RiskTemplate = {
  marketplace: "Lazada" | "Facebook Marketplace";
  titleMode: "obvious_fake" | "discount_fake" | "social_fake" | "resale_reference";
  priceMultiplier: number;
  sellerName: string;
  sellerLocation: string;
  rating: number;
  reviewCount: number;
  accountAgeDays: number;
  responseTimeHours: number;
  transactionVolume: number;
  redFlags: string[];
  signalTags: string[];
  condition: string;
};

const riskTemplates: RiskTemplate[] = [
  {
    marketplace: "Lazada",
    titleMode: "obvious_fake",
    priceMultiplier: 0.42,
    sellerName: "flashdeal_factory.vn",
    sellerLocation: "Ho Chi Minh City",
    rating: 4.0,
    reviewCount: 16,
    accountAgeDays: 51,
    responseTimeHours: 22,
    transactionVolume: 980,
    redFlags: ["new seller", "repeat relisting"],
    signalTags: ["stock_photo", "missing_serial", "no_auth_docs", "image_reuse"],
    condition: "factory_new",
  },
  {
    marketplace: "Lazada",
    titleMode: "discount_fake",
    priceMultiplier: 0.57,
    sellerName: "warehouse.outlet.pro",
    sellerLocation: "Da Nang",
    rating: 4.2,
    reviewCount: 28,
    accountAgeDays: 117,
    responseTimeHours: 38,
    transactionVolume: 1220,
    redFlags: ["bulk price swings", "no return clarity"],
    signalTags: ["stock_photo", "warranty_gap", "no_auth_docs"],
    condition: "new",
  },
  {
    marketplace: "Facebook Marketplace",
    titleMode: "social_fake",
    priceMultiplier: 0.49,
    sellerName: "local.quickdrop",
    sellerLocation: "Hanoi",
    rating: 3.9,
    reviewCount: 8,
    accountAgeDays: 36,
    responseTimeHours: 11,
    transactionVolume: 210,
    redFlags: ["off-platform payments", "contact in bio"],
    signalTags: ["offsite_checkout", "contact_in_bio", "image_reuse"],
    condition: "new",
  },
  {
    marketplace: "Lazada",
    titleMode: "resale_reference",
    priceMultiplier: 0.84,
    sellerName: "closet.rotate.archive",
    sellerLocation: "Ho Chi Minh City",
    rating: 4.8,
    reviewCount: 436,
    accountAgeDays: 920,
    responseTimeHours: 5,
    transactionVolume: 1440,
    redFlags: [],
    signalTags: ["receipt_provided"],
    condition: "used",
  },
];

const COMMON_SUBDOMAINS = new Set(["www", "m", "shop", "store", "app"]);
const IGNORE_PATH_SEGMENTS = new Set([
  "p",
  "pd",
  "product",
  "products",
  "item",
  "shop",
  "store",
  "catalog",
  "collections",
  "c",
  "us",
  "en-us",
]);

const hashInt = (value: string) =>
  Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const titleCase = (value: string) =>
  value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");

function canonicalDomain(hostname: string) {
  const parts = hostname.split(".").filter(Boolean);
  while (parts.length > 2 && COMMON_SUBDOMAINS.has(parts[0].toLowerCase())) {
    parts.shift();
  }

  if (parts.length >= 3 && isLikelyTwoPartSuffix(parts.at(-1), parts.at(-2))) {
    return parts.slice(-3).join(".");
  }

  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }

  return parts[0] ?? hostname;
}

function isLikelyTwoPartSuffix(last?: string, secondLast?: string) {
  if (!last || !secondLast) {
    return false;
  }

  return last.length <= 3 && secondLast.length <= 3;
}

export function inferBrandFingerprint(officialUrl: string): BrandFingerprint {
  const url = new URL(officialUrl);
  const brandName = inferBrandName(url.hostname);
  const productName = inferProductName(url, brandName);
  const referencePrice = guessReferencePrice(productName, brandName);
  const currency = guessCurrency(url.hostname);
  const domain = canonicalDomain(url.hostname);

  return {
    brandName,
    productName,
    officialUrl,
    domain,
    authorizedDomains: [domain, `www.${domain}`, url.hostname].filter(
      (value, index, array) => array.indexOf(value) === index,
    ),
    authorizedChannels: [
      `${brandName} official web store`,
      `${brandName} flagship marketplace stores`,
      "authorized retail partners",
    ],
    knownProducts: [
      productName,
      `${productName} alternate colorways`,
      `${productName} seasonal drops`,
    ],
    claims: buildClaims(brandName, productName),
    visualMotifs: buildVisualMotifs(productName),
    referencePrice,
    currency,
  };
}

function inferBrandName(hostname: string) {
  const parts = hostname
    .split(".")
    .filter(Boolean)
    .filter((part) => !COMMON_SUBDOMAINS.has(part.toLowerCase()));
  const token = parts[0] ?? hostname.split(".")[0] ?? "brand";
  return titleCase(token.replace(/[^a-z0-9-]+/gi, " "));
}

function inferProductName(url: URL, brandName: string) {
  const brandToken = slug(brandName);
  const candidates = url.pathname
    .split("/")
    .map((segment) => segment.replace(/\.[a-z0-9]+$/i, "").trim())
    .filter(Boolean)
    .filter((segment) => /[a-z]/i.test(segment))
    .filter((segment) => !IGNORE_PATH_SEGMENTS.has(segment.toLowerCase()))
    .filter((segment) => !/^\d+$/.test(segment))
    .filter((segment) => slug(segment) !== brandToken)
    .sort((left, right) => right.length - left.length);

  return titleCase(candidates[0] ?? "Core Product");
}

function guessReferencePrice(productName: string, brandName: string) {
  const product = productName.toLowerCase();
  const brand = brandName.toLowerCase();

  if (brand.includes("crocs") && /clog|sandal|slide/.test(product)) {
    return 50;
  }
  if (/clog|sandal|slide|slipper|flip flop/.test(product)) {
    return 60;
  }
  if (/shoe|sneaker|boot/.test(product)) {
    return 110;
  }
  if (/bag|tote|backpack|wallet/.test(product)) {
    return 135;
  }
  if (/watch|clock/.test(product)) {
    return 220;
  }
  if (/case|cover|charm|accessory/.test(product)) {
    return 35;
  }
  return 95;
}

function guessCurrency(hostname: string) {
  return hostname.endsWith(".vn") ? "VND" : "USD";
}

function isGenericProductName(productName: string) {
  return /^core product$/i.test(productName.trim());
}

function displayProductName(productName: string) {
  return isGenericProductName(productName) ? "" : productName;
}

function buildClaims(brandName: string, productName: string) {
  return [
    `${brandName} keeps official pricing and color naming consistent across owned channels`,
    `${productName} should carry recognizable branding, packaging, and return-policy cues`,
    "authorized sellers should provide receipts, warranty language, and brand-safe fulfillment details",
  ];
}

function buildVisualMotifs(productName: string) {
  const product = productName.toLowerCase();

  if (/clog|sandal|slide/.test(product)) {
    return ["molded silhouette", "distinctive vent pattern", "brand-marked heel or strap details"];
  }
  if (/shoe|sneaker|boot/.test(product)) {
    return ["consistent logo placement", "official colorway naming", "box label and product code cues"];
  }
  if (/bag|wallet|tote/.test(product)) {
    return ["material finish consistency", "logo embossing or tag placement", "hardware and stitching cues"];
  }

  return ["official brand wordmark", "consistent packaging cues", "authorized product code details"];
}

function makeCandidateId(runId: string, index: number) {
  return `cand_${runId.slice(0, 8)}_${index + 1}`;
}

function makeSellerId(runId: string, index: number) {
  return `seller_${runId.slice(-8)}_${index + 1}`;
}

export function buildMockInvestigation(officialUrl: string): InvestigationRun {
  const runId = `run_${randomUUID().slice(0, 8)}`;
  const fingerprint = inferBrandFingerprint(officialUrl);
  const templates = rotateTemplates(fingerprint.officialUrl);
  const productName = displayProductName(fingerprint.productName);

  const candidates = templates.map((template, index) =>
    buildCandidate(runId, index, fingerprint, template),
  );
  const sellerProfiles = candidates.map((candidate, index) =>
    buildSellerProfile(candidate, templates[index]),
  );

  const events: InvestigationEvent[] = [
    {
      type: "started",
      timestamp: new Date().toISOString(),
      runId,
      message: `Mock investigation started for ${fingerprint.brandName}${productName ? ` ${productName}` : ""}`,
    },
    {
      type: "progress",
      timestamp: new Date(Date.now() + 200).toISOString(),
      runId,
      message: `Captured ${fingerprint.brandName}${productName ? ` ${productName}` : ""} reference cues from the official listing.`,
    },
    ...candidates.map((candidate, index) => ({
      type: "progress" as const,
      timestamp: new Date(Date.now() + (index + 2) * 300).toISOString(),
      runId,
      message: `Flagged ${candidate.marketplace} lead: ${candidate.title}`,
    })),
    {
      type: "complete",
      timestamp: new Date(Date.now() + (candidates.length + 3) * 300).toISOString(),
      runId,
      message: "Mock investigation complete with a clean benchmark and suspicious marketplace leads.",
      result: {
        candidates,
        brandFingerprint: fingerprint,
        sellerProfiles,
      },
    },
  ];

  return {
    runId,
    brandFingerprint: fingerprint,
    candidates,
    sellerProfiles,
    events,
  };
}

function rotateTemplates(officialUrl: string) {
  const rotation = hashInt(officialUrl) % riskTemplates.length;
  return riskTemplates.map((_, index) => riskTemplates[(index + rotation) % riskTemplates.length]);
}

function buildCandidate(
  runId: string,
  index: number,
  fingerprint: BrandFingerprint,
  template: RiskTemplate,
): ListingCandidate {
  const sellerId = makeSellerId(runId, index);
  const title = makeTitle(template.titleMode, fingerprint.brandName, displayProductName(fingerprint.productName));
  const price = Math.max(10, Math.round(fingerprint.referencePrice * template.priceMultiplier));
  const candidateStub = {
    price,
    currency: fingerprint.currency,
    condition: template.condition,
    signalTags: template.signalTags,
    marketplace: template.marketplace,
    sellerName: template.sellerName,
  };
  const sellerProfileStub = {
    rating: template.rating,
    reviewCount: template.reviewCount,
    accountAgeDays: template.accountAgeDays,
    responseTimeHours: template.responseTimeHours,
    redFlags: template.redFlags,
  };
  const counterfeit = scoreCounterfeitRisk(fingerprint, candidateStub, sellerProfileStub);
  const sellerFraud = scoreSellerFraudRisk(candidateStub, {
    ...sellerProfileStub,
    transactionVolume: template.transactionVolume,
  });

  return {
    id: makeCandidateId(runId, index),
    source: "mock",
    marketplace: template.marketplace,
    url: makeMarketplaceSearchUrl(template.marketplace, title),
    title,
    sellerId,
    sellerName: template.sellerName,
    price,
    currency: fingerprint.currency,
    condition: template.condition,
    signalTags: template.signalTags,
    counterfeitRisk: counterfeit.score,
    sellerFraudRisk: sellerFraud.score,
    confidence: clampConfidence(counterfeit.score, sellerFraud.score, template.reviewCount),
    reasoning: [...counterfeit.reasons, ...sellerFraud.reasons].slice(0, 5),
  };
}

function makeTitle(titleMode: RiskTemplate["titleMode"], brandName: string, productName: string) {
  const product = displayProductName(productName);
  switch (titleMode) {
    case "obvious_fake":
      return `${brandName}${product ? ` ${product}` : ""} 1:1 same mold | ready stock | full size run`;
    case "discount_fake":
      return `${brandName}${product ? ` ${product}` : ""} warehouse sale | no box | flash deal`;
    case "social_fake":
      return `${brandName}${product ? ` ${product}` : ""} preorder | DM for price | no invoice`;
    case "resale_reference":
      return `${brandName}${product ? ` ${product}` : ""} second owner | with receipt | light wear`;
  }
}

function makeMarketplaceSearchUrl(marketplace: RiskTemplate["marketplace"], title: string) {
  if (marketplace === "Lazada") {
    return `https://www.lazada.vn/catalog/?q=${encodeURIComponent(title)}`;
  }
  return `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(title)}`;
}

function clampConfidence(counterfeitRisk: number, sellerFraudRisk: number, reviewCount: number) {
  const base = Math.max(counterfeitRisk, sellerFraudRisk) * 0.72;
  const reviewBoost = Math.min(12, Math.log10(reviewCount + 1) * 4);
  return Math.max(35, Math.min(98, Math.round(base + reviewBoost)));
}

function buildSellerProfile(candidate: ListingCandidate, template: RiskTemplate): SellerProfile {
  const redFlags = [...template.redFlags];
  const summary = [
    `${candidate.sellerName} is surfacing on ${candidate.marketplace}`,
    template.reviewCount < 30 ? "with an unusually thin review footprint" : "with a more mature review trail",
    redFlags.length ? `and shows ${redFlags.join(", ")}` : "and does not immediately show seller-level red flags",
  ].join(" ");

  return {
    id: candidate.sellerId,
    sellerName: candidate.sellerName,
    marketplace: candidate.marketplace,
    storefrontUrl: makeMarketplaceSearchUrl(candidate.marketplace as RiskTemplate["marketplace"], candidate.sellerName),
    location: template.sellerLocation,
    rating: template.rating,
    reviewCount: template.reviewCount,
    accountAgeDays: template.accountAgeDays,
    responseTimeHours: template.responseTimeHours,
    transactionVolume: template.transactionVolume,
    redFlags,
    linkedListingIds: [candidate.id],
    counterfeitRisk: candidate.counterfeitRisk,
    sellerFraudRisk: candidate.sellerFraudRisk,
    summary,
  };
}
