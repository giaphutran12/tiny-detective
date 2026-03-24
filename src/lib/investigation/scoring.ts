import type {
  BrandFingerprint,
  ListingCandidate,
  SellerProfile,
} from "./types";

const clamp = (value: number, min = 0, max = 100) =>
  Math.min(max, Math.max(min, Math.round(value)));

const ratio = (price: number, referencePrice: number) =>
  referencePrice > 0 ? price / referencePrice : 1;

export function scoreCounterfeitRisk(
  brand: BrandFingerprint,
  candidate: Pick<
    ListingCandidate,
    "price" | "currency" | "condition" | "signalTags" | "marketplace" | "sellerName"
  >,
  seller?: Pick<SellerProfile, "rating" | "reviewCount" | "accountAgeDays" | "redFlags" | "responseTimeHours">,
  options?: {
    referencePrice?: number;
    referenceCurrency?: string;
  },
) {
  let score = 12;
  const reasons: string[] = [];

  const referencePrice = options?.referencePrice ?? brand.referencePrice;
  const referenceCurrency = options?.referenceCurrency ?? brand.currency;

  if (candidate.currency === referenceCurrency) {
    const priceRatio = ratio(candidate.price, referencePrice);
    if (priceRatio < 0.35) {
      score += 28;
      reasons.push("price sits far below the brand reference");
    } else if (priceRatio < 0.6) {
      score += 18;
      reasons.push("price is materially discounted versus the brand reference");
    }
  }

  if (candidate.signalTags.some((tag) => /image_reuse|stock_photo|missing_serial/i.test(tag))) {
    score += 18;
    reasons.push("listing evidence suggests reused imagery or missing serialization");
  }

  if (candidate.signalTags.some((tag) => /warranty_gap|no_auth_docs|offsite_checkout/i.test(tag))) {
    score += 12;
    reasons.push("listing lacks warranty or authorization signals");
  }

  if (brand.authorizedChannels.length > 0 && /marketplace/i.test(candidate.marketplace)) {
    score += 8;
    reasons.push("sale occurs through an unmanaged marketplace channel");
  }

  if (seller) {
    if (seller.accountAgeDays < 180) {
      score += 14;
      reasons.push("seller account is newly established");
    }
    if (seller.reviewCount < 25) {
      score += 8;
      reasons.push("seller has a thin review footprint");
    }
    if (seller.rating < 4.4) {
      score += 7;
      reasons.push("seller rating is below a healthy baseline");
    }
    if (seller.responseTimeHours > 24) {
      score += 5;
      reasons.push("seller response times are slow");
    }
    if (seller.redFlags.length > 0) {
      score += Math.min(12, seller.redFlags.length * 4);
      reasons.push("seller profile contains corroborating red flags");
    }
  }

  return {
    score: clamp(score),
    reasons,
  };
}

export function scoreSellerFraudRisk(
  candidate: Pick<ListingCandidate, "price" | "currency" | "signalTags" | "sellerName">,
  seller: Pick<
    SellerProfile,
    "rating" | "reviewCount" | "accountAgeDays" | "responseTimeHours" | "transactionVolume" | "redFlags"
  >,
  options?: {
    referencePrice?: number;
    referenceCurrency?: string;
  },
) {
  let score = 10;
  const reasons: string[] = [];

  if (seller.accountAgeDays < 90) {
    score += 25;
    reasons.push("seller account is very recent");
  } else if (seller.accountAgeDays < 365) {
    score += 12;
    reasons.push("seller account is still relatively young");
  }

  if (seller.reviewCount < 20) {
    score += 16;
    reasons.push("seller has too few reviews for the observed activity");
  }

  if (seller.transactionVolume > 500) {
    score += 12;
    reasons.push("seller volume looks outsized for the account age");
  }

  if (seller.rating < 4.2) {
    score += 8;
    reasons.push("seller rating is weak");
  }

  if (seller.responseTimeHours > 48) {
    score += 10;
    reasons.push("seller response times are unusually slow");
  }

  const referencePrice = options?.referencePrice ?? null;
  const referenceCurrency = options?.referenceCurrency ?? null;

  if (
    referencePrice &&
    referencePrice > 0 &&
    referenceCurrency &&
    candidate.currency === referenceCurrency &&
    candidate.price / referencePrice < 0.7
  ) {
    score += 4;
    reasons.push("listing is price aggressive enough to merit scrutiny");
  }

  if (candidate.signalTags.some((tag) => /offsite_checkout|unverified_payout|contact_in_bio/i.test(tag))) {
    score += 14;
    reasons.push("listing encourages off-platform contact or payout");
  }

  score += Math.min(16, seller.redFlags.length * 4);
  if (seller.redFlags.length > 0) {
    reasons.push("seller profile includes operational red flags");
  }

  return {
    score: clamp(score),
    reasons,
  };
}
