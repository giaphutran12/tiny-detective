import { buildMockInvestigation } from "./mock";
import { scoreCounterfeitRisk, scoreSellerFraudRisk } from "./scoring";
import type {
  BrandFingerprint,
  InvestigationEvent,
  InvestigationRun,
  ListingCandidate,
  SellerProfile,
} from "./types";

type TinyFishSseEvent =
  | {
      type: "STARTED";
      run_id: string;
      timestamp: string;
    }
  | {
      type: "STREAMING_URL";
      run_id: string;
      streaming_url: string;
      timestamp: string;
    }
  | {
      type: "PROGRESS";
      run_id: string;
      purpose: string;
      timestamp: string;
    }
  | {
      type: "HEARTBEAT";
      run_id: string;
      timestamp: string;
    }
  | {
      type: "COMPLETE";
      run_id: string;
      status: string;
      result?: unknown;
      timestamp: string;
    };

const TINYFISH_ENDPOINT = "https://agent.tinyfish.ai/v1/automation/run-sse";
const TINYFISH_ASYNC_ENDPOINT = "https://agent.tinyfish.ai/v1/automation/run-async";
const TINYFISH_RUNS_BATCH_ENDPOINT = "https://agent.tinyfish.ai/v1/runs/batch";
const RETRYABLE_BLOCK_CODES = new Set(["SITE_BLOCKED", "FORBIDDEN", "RATE_LIMIT_EXCEEDED"]);
const SEARCH_POLL_MS = 2_500;
const SEARCH_TIMEOUT_MS = 420_000;

type TinyFishAsyncRunResponse = {
  run_id?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

type TinyFishRunRecord = {
  run_id: string;
  status: string;
  result?: unknown;
  error?: {
    code?: string;
    message?: string;
    category?: string;
  };
  streaming_url?: string | null;
};

type TinyFishRunsBatchResponse = {
  data?: TinyFishRunRecord[];
  not_found?: string[] | null;
};

type SearchProbe = {
  id: string;
  label: string;
  marketplace: string;
  url: string;
  goal: string;
  browserProfile: "lite" | "stealth";
  proxyCountry?: "US" | "GB" | "CA" | "DE" | "FR" | "JP" | "AU";
};

type StartedSearchProbe = SearchProbe & {
  runId: string;
};

export function hasTinyFishApiKey() {
  return Boolean(process.env.TINYFISH_API_KEY?.trim());
}

export function buildInvestigationGoal(officialUrl: string) {
  return [
    `First inspect ${officialUrl} to extract the official brand and product details from the product page itself.`,
    "Then search Amazon for the cleanest official or highly trusted benchmark listing so the investigation has a reliable marketplace price anchor before checking suspicious channels.",
    "After that, search Lazada VN for similar products and current prices, preferring suspicious underpriced or counterfeit-looking listings over generic brand-site guesses.",
    "Return only a single JSON object in the COMPLETE result with brandFingerprint, candidates, sellerProfiles, and analysisSummary. Do not wrap the JSON in markdown.",
    "Each candidate should include marketplace, url, title, sellerName, sellerId, price, currency, condition, signalTags, counterfeitRisk, sellerFraudRisk, confidence, and reasoning.",
    "Include one benchmark listing from Amazon or another trusted official marketplace when available, then include one suspicious underpriced listing from Lazada VN if found, and the strongest likely counterfeit listing when one is obvious.",
    "If Lazada presents a bot challenge or slider verification, note that in the reasoning and keep the benchmark plus any suspicious listings already captured rather than stalling the whole run.",
    "Use numeric 0-100 values for counterfeitRisk, sellerFraudRisk, and confidence whenever possible.",
  ].join(" ");
}

function buildFingerprintGoal(officialUrl: string) {
  return [
    `Inspect ${officialUrl} and extract the official brand and product details from the real product page.`,
    "Return only JSON with brandFingerprint and analysisSummary.",
    "brandFingerprint should include brandName, productName, officialUrl, currency, officialPrice or referencePrice when available, knownProducts, claims, and visual motifs or materials.",
    "Do not search secondary marketplaces yet.",
  ].join(" ");
}

function buildProbeGoal(probe: SearchProbe, fingerprint: BrandFingerprint, referenceIdentifier: string) {
  const productQuery = [fingerprint.brandName, fingerprint.productName, referenceIdentifier]
    .filter(Boolean)
    .join(" ")
    .trim();

  return [
    `Search ${probe.marketplace} for ${productQuery}.`,
    probe.marketplace === "Amazon"
      ? "Prioritize the cleanest official, flagship, or highly trusted benchmark listing and return at most 2 candidates."
      : "Prioritize suspicious underpriced, counterfeit-looking, or misleading listings and return at most 3 strong candidates.",
    "Return only JSON with candidates, sellerProfiles, and analysisSummary.",
    "Each candidate must include marketplace, url, title, sellerName, sellerId, price, currency, condition, signalTags, counterfeitRisk, sellerFraudRisk, confidence, and reasoning.",
    "Use numeric 0-100 values for counterfeitRisk, sellerFraudRisk, and confidence whenever possible.",
    "If the site presents bot detection or slider verification, note that clearly in reasoning or analysisSummary and return any usable findings you already captured.",
  ].join(" ");
}

export async function* iterateInvestigation(
  officialUrl: string,
): AsyncGenerator<InvestigationEvent, InvestigationRun, void> {
  const fallback = buildMockInvestigation(officialUrl);
  const orchestrationRunId = fallback.runId;

  if (!hasTinyFishApiKey()) {
    yield* mockEvents(fallback);
    return fallback;
  }

  yield {
    type: "started",
    timestamp: new Date().toISOString(),
    runId: orchestrationRunId,
    message: "Investigation started. Extracting the official product fingerprint.",
  };

  const fingerprintGoal = buildFingerprintGoal(officialUrl);
  let response = await startTinyFishRun({
    url: officialUrl,
    goal: fingerprintGoal,
    browser_profile: "lite",
  });

  if (!response.ok && (await shouldRetryWithStealth(response))) {
    response = await startTinyFishRun({
      url: officialUrl,
      goal: fingerprintGoal,
      browser_profile: "stealth",
      proxy_config: {
        enabled: true,
        country_code: "JP",
      },
    });
  }

  if (!response.ok || !response.body) {
    yield* mockEvents(fallback);
    return fallback;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawExtractionComplete = false;
  let brandFingerprint = fallback.brandFingerprint;
  let aggregateCandidates: ListingCandidate[] = [];
  let aggregateSellerProfiles: SellerProfile[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        const payload = parseTinyFishFrame(frame);
        if (!payload) {
          continue;
        }

        if (payload.type === "STARTED") {
          yield {
            type: "progress",
            timestamp: payload.timestamp ?? new Date().toISOString(),
            runId: orchestrationRunId,
            message: "TinyFish is reading the official product page.",
            probeLabel: "Official product",
          };
          continue;
        }

        if (payload.type === "STREAMING_URL") {
          yield {
            type: "streaming_url",
            timestamp: payload.timestamp ?? new Date().toISOString(),
            runId: orchestrationRunId,
            streamingUrl: payload.streaming_url,
            probeLabel: "Official product",
          };
          continue;
        }

        if (payload.type === "PROGRESS") {
          yield {
            type: "progress",
            timestamp: payload.timestamp ?? new Date().toISOString(),
            runId: orchestrationRunId,
            message: payload.purpose,
            probeLabel: "Official product",
          };
          continue;
        }

        if (payload.type === "HEARTBEAT") {
          yield {
            type: "heartbeat",
            timestamp: payload.timestamp ?? new Date().toISOString(),
            runId: orchestrationRunId,
            message: "heartbeat",
            probeLabel: "Official product",
          };
          continue;
        }

        if (payload.type === "COMPLETE") {
          sawExtractionComplete = true;
          const rawResult = payload.result;
          const extractionRoot = unwrapResult(rawResult);
          const normalized = normalizeTinyFishResult(rawResult, fallback, officialUrl);
          brandFingerprint = normalizeBrandFingerprint(extractionRoot, fallback.brandFingerprint, officialUrl);

          if (normalized?.candidates.length) {
            aggregateCandidates = mergeCandidates(aggregateCandidates, normalized.candidates);
            aggregateSellerProfiles = mergeSellerProfiles(
              aggregateSellerProfiles,
              normalized.sellerProfiles,
              aggregateCandidates,
            );
          }

          yield {
            type: "fingerprint",
            timestamp: payload.timestamp ?? new Date().toISOString(),
            runId: orchestrationRunId,
            message: `Captured ${brandFingerprint.brandName} ${brandFingerprint.productName}. Launching the search swarm.`,
            probeLabel: "Official product",
            result: {
              brandFingerprint,
              candidates: aggregateCandidates,
              sellerProfiles: aggregateSellerProfiles,
            },
          };
        }
      }
    }
  } catch {
    yield* mockEvents(fallback);
    return fallback;
  }

  if (!sawExtractionComplete) {
    yield* mockEvents(fallback);
    return fallback;
  }

  const probes = buildSearchProbes(brandFingerprint, officialUrl);
  yield {
    type: "progress",
    timestamp: new Date().toISOString(),
    runId: orchestrationRunId,
    message: `Launching ${probes.length} parallel search agents across Amazon, Lazada, and Shopee.`,
  };

  const queuedProbeResults = await Promise.all(
    probes.map(async (probe) => {
      const started = await startTinyFishAsyncRun({
        url: probe.url,
        goal: probe.goal,
        browser_profile: probe.browserProfile,
        proxy_config: probe.proxyCountry
          ? {
              enabled: true,
              country_code: probe.proxyCountry,
            }
          : undefined,
      });

      return started
        ? ({
            ...probe,
            runId: started,
          } satisfies StartedSearchProbe)
        : probe;
    }),
  );

  const startedProbes = queuedProbeResults.filter(
    (probe): probe is StartedSearchProbe => "runId" in probe,
  );
  const failedProbes = queuedProbeResults.filter(
    (probe): probe is SearchProbe => !("runId" in probe),
  );

  for (const failedProbe of failedProbes) {
    yield {
      type: "progress",
      timestamp: new Date().toISOString(),
      runId: orchestrationRunId,
      message: `${failedProbe.label} could not be queued.`,
      probeLabel: failedProbe.label,
    };
  }

  if (startedProbes.length === 0) {
    const result = aggregateCandidates.length
      ? {
          runId: orchestrationRunId,
          brandFingerprint,
          candidates: aggregateCandidates,
          sellerProfiles: aggregateSellerProfiles,
          events: [],
        }
      : fallback;

    yield {
      type: "complete",
      timestamp: new Date().toISOString(),
      runId: orchestrationRunId,
      message: "No search probes could be started.",
      result: {
        candidates: result.candidates,
        brandFingerprint: result.brandFingerprint,
        sellerProfiles: result.sellerProfiles,
      },
    };
    return result;
  }

  const probeByRunId = new Map(startedProbes.map((probe) => [probe.runId, probe]));
  const seenStatuses = new Map<string, string>();
  const completedProbeIds = new Set<string>();
  const processedProbeIds = new Set<string>();
  const emittedStreamingUrls = new Set<string>();
  const startedAt = Date.now();

  while (
    completedProbeIds.size < startedProbes.length &&
    Date.now() - startedAt < SEARCH_TIMEOUT_MS
  ) {
    const runs = await getTinyFishRunsBatch(startedProbes.map((probe) => probe.runId));
    if (!runs.length) {
      await wait(SEARCH_POLL_MS);
      continue;
    }

    for (const run of runs) {
      const probe = probeByRunId.get(run.run_id);
      if (!probe) {
        continue;
      }

      if (run.streaming_url && !emittedStreamingUrls.has(run.run_id)) {
        emittedStreamingUrls.add(run.run_id);
        yield {
          type: "streaming_url",
          timestamp: new Date().toISOString(),
          runId: orchestrationRunId,
          streamingUrl: run.streaming_url,
          probeLabel: probe.label,
          message: `${probe.label} opened a live browser session.`,
        };
      }

      const status = run.status.toUpperCase();
      const previousStatus = seenStatuses.get(run.run_id);
      if (previousStatus !== status) {
        seenStatuses.set(run.run_id, status);

        if (status !== "COMPLETED" && status !== "FAILED" && status !== "CANCELLED") {
          yield {
            type: "progress",
            timestamp: new Date().toISOString(),
            runId: orchestrationRunId,
            message: `${probe.label} is ${humanizeRunStatus(status)}.`,
            probeLabel: probe.label,
          };
        }
      }

      if (processedProbeIds.has(run.run_id)) {
        continue;
      }

      if (status === "COMPLETED") {
        processedProbeIds.add(run.run_id);
        completedProbeIds.add(run.run_id);

        const normalized = normalizeTinyFishResult(run.result, {
          ...fallback,
          runId: orchestrationRunId,
          brandFingerprint,
          candidates: aggregateCandidates,
          sellerProfiles: aggregateSellerProfiles,
        }, officialUrl);

        if (!normalized) {
          yield {
            type: "progress",
            timestamp: new Date().toISOString(),
            runId: orchestrationRunId,
            message: `${probe.label} completed without usable listing data.`,
            probeLabel: probe.label,
            result: {
              completedAgents: completedProbeIds.size,
              totalAgents: startedProbes.length,
            },
          };
          continue;
        }

        const nextFingerprint = chooseBetterFingerprint(brandFingerprint, normalized.brandFingerprint);
        const mergedCandidates = mergeCandidates(aggregateCandidates, normalized.candidates);
        const previousCount = aggregateCandidates.length;
        aggregateCandidates = mergedCandidates;
        aggregateSellerProfiles = mergeSellerProfiles(
          aggregateSellerProfiles,
          normalized.sellerProfiles,
          aggregateCandidates,
        );
        brandFingerprint = nextFingerprint;

        const newestCandidate = aggregateCandidates[0] ?? undefined;

        yield {
          type: "candidate_found",
          timestamp: new Date().toISOString(),
          runId: orchestrationRunId,
          probeLabel: probe.label,
          message:
            aggregateCandidates.length > previousCount
              ? `${probe.label} added ${aggregateCandidates.length - previousCount} new candidate${aggregateCandidates.length - previousCount === 1 ? "" : "s"}.`
              : `${probe.label} completed with overlapping evidence.`,
          result: {
            candidate: newestCandidate,
            candidates: aggregateCandidates,
            brandFingerprint,
            sellerProfiles: aggregateSellerProfiles,
            completedAgents: completedProbeIds.size,
            totalAgents: startedProbes.length,
          },
        };
        continue;
      }

      if (status === "FAILED" || status === "CANCELLED") {
        processedProbeIds.add(run.run_id);
        completedProbeIds.add(run.run_id);

        yield {
          type: "progress",
          timestamp: new Date().toISOString(),
          runId: orchestrationRunId,
          probeLabel: probe.label,
          message: `${probe.label} ${status === "FAILED" ? "failed" : "was cancelled"}${run.error?.message ? `: ${run.error.message}` : "."}`,
          result: {
            completedAgents: completedProbeIds.size,
            totalAgents: startedProbes.length,
          },
        };
      }
    }

    if (completedProbeIds.size < startedProbes.length) {
      await wait(SEARCH_POLL_MS);
    }
  }

  if (completedProbeIds.size < startedProbes.length) {
    yield {
      type: "progress",
      timestamp: new Date().toISOString(),
      runId: orchestrationRunId,
      message: `Search swarm timed out after ${Math.round(SEARCH_TIMEOUT_MS / 1000)} seconds. Returning partial results.`,
      result: {
        completedAgents: completedProbeIds.size,
        totalAgents: startedProbes.length,
      },
    };
  }

  const finalRun: InvestigationRun = {
    runId: orchestrationRunId,
    brandFingerprint,
    candidates: aggregateCandidates,
    sellerProfiles: aggregateSellerProfiles,
    events: [],
  };

  if (finalRun.candidates.length === 0) {
    const emptyRun = {
      ...fallback,
      runId: orchestrationRunId,
      brandFingerprint,
      candidates: [],
      sellerProfiles: [],
      events: [],
    };

    yield {
      type: "complete",
      timestamp: new Date().toISOString(),
      runId: orchestrationRunId,
      message: "Search swarm finished without usable suspicious listings.",
      result: {
        candidates: emptyRun.candidates,
        brandFingerprint: emptyRun.brandFingerprint,
        sellerProfiles: emptyRun.sellerProfiles,
      },
    };
    return emptyRun;
  }

  yield {
    type: "complete",
    timestamp: new Date().toISOString(),
    runId: orchestrationRunId,
    message: `Investigation completed with ${finalRun.candidates.length} candidate${finalRun.candidates.length === 1 ? "" : "s"} from ${completedProbeIds.size}/${startedProbes.length} probes.`,
    result: {
      candidates: finalRun.candidates,
      brandFingerprint: finalRun.brandFingerprint,
      sellerProfiles: finalRun.sellerProfiles,
      completedAgents: completedProbeIds.size,
      totalAgents: startedProbes.length,
    },
  };

  return finalRun;
}

export function createInvestigationStream(events: AsyncIterable<InvestigationEvent>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
          await wait(140);
        }
      } finally {
        controller.close();
      }
    },
  });
}

function parseTinyFishFrame(frame: string): TinyFishSseEvent | null {
  const dataLine = frame
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.replace(/^data:\s*/, "");
  if (!dataLine) {
    return null;
  }

  try {
    return JSON.parse(dataLine) as TinyFishSseEvent;
  } catch {
    return null;
  }
}

async function startTinyFishRun(body: Record<string, unknown>) {
  return fetch(TINYFISH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.TINYFISH_API_KEY ?? "",
    },
    body: JSON.stringify(body),
  });
}

async function shouldRetryWithStealth(response: Response) {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }

  const payload = await response.clone().json().catch(() => null);
  const code = payload?.error?.code;
  return typeof code === "string" && RETRYABLE_BLOCK_CODES.has(code);
}

async function startTinyFishAsyncRun(body: Record<string, unknown>) {
  const response = await fetch(TINYFISH_ASYNC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.TINYFISH_API_KEY ?? "",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as TinyFishAsyncRunResponse | null;
  const runId = payload?.run_id?.trim();
  return runId || null;
}

async function getTinyFishRunsBatch(runIds: string[]) {
  if (runIds.length === 0) {
    return [];
  }

  const response = await fetch(TINYFISH_RUNS_BATCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.TINYFISH_API_KEY ?? "",
    },
    body: JSON.stringify({
      run_ids: runIds,
    }),
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json().catch(() => null)) as TinyFishRunsBatchResponse | null;
  return payload?.data ?? [];
}

function buildSearchProbes(fingerprint: BrandFingerprint, officialUrl: string): SearchProbe[] {
  const { exactQuery, baseQuery, cheapQuery, genuineQuery, counterfeitQuery, grayMarketQuery } =
    buildSearchQueries(fingerprint, officialUrl);

  const amazonExact = buildMarketplaceUrl("Amazon", exactQuery);
  const amazonBase = buildMarketplaceUrl("Amazon", baseQuery);
  const lazadaExact = buildMarketplaceUrl("Lazada VN", exactQuery);
  const lazadaCheap = buildMarketplaceUrl("Lazada VN", cheapQuery);
  const lazadaGenuine = buildMarketplaceUrl("Lazada VN", genuineQuery);
  const lazadaCounterfeit = buildMarketplaceUrl("Lazada VN", counterfeitQuery);
  const lazadaGrayMarket = buildMarketplaceUrl("Lazada VN", grayMarketQuery);
  const shopeeExact = buildMarketplaceUrl("Shopee VN", exactQuery);
  const shopeeCheap = buildMarketplaceUrl("Shopee VN", cheapQuery);
  const shopeeGenuine = buildMarketplaceUrl("Shopee VN", genuineQuery);
  const shopeeCounterfeit = buildMarketplaceUrl("Shopee VN", counterfeitQuery);

  const probes: SearchProbe[] = [
    {
      id: "amazon-exact",
      label: "Amazon exact benchmark",
      marketplace: "Amazon",
      url: amazonExact,
      goal: "",
      browserProfile: "lite",
      proxyCountry: "US",
    },
    {
      id: "amazon-base",
      label: "Amazon fallback benchmark",
      marketplace: "Amazon",
      url: amazonBase,
      goal: "",
      browserProfile: "lite",
      proxyCountry: "US",
    },
    {
      id: "lazada-exact",
      label: "Lazada exact query",
      marketplace: "Lazada VN",
      url: lazadaExact,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "lazada-genuine",
      label: "Lazada genuine-claim scan",
      marketplace: "Lazada VN",
      url: lazadaGenuine,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "lazada-cheap",
      label: "Lazada cheap-price scan",
      marketplace: "Lazada VN",
      url: lazadaCheap,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "lazada-counterfeit",
      label: "Lazada counterfeit-euphemism scan",
      marketplace: "Lazada VN",
      url: lazadaCounterfeit,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "lazada-gray-market",
      label: "Lazada no-box grey-market scan",
      marketplace: "Lazada VN",
      url: lazadaGrayMarket,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "shopee-exact",
      label: "Shopee exact query",
      marketplace: "Shopee VN",
      url: shopeeExact,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "shopee-genuine",
      label: "Shopee genuine-claim scan",
      marketplace: "Shopee VN",
      url: shopeeGenuine,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "shopee-cheap",
      label: "Shopee cheap-price scan",
      marketplace: "Shopee VN",
      url: shopeeCheap,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
    {
      id: "shopee-counterfeit",
      label: "Shopee counterfeit-euphemism scan",
      marketplace: "Shopee VN",
      url: shopeeCounterfeit,
      goal: "",
      browserProfile: "stealth",
      proxyCountry: "JP",
    },
  ];

  const referenceIdentifier = deriveReferenceIdentifier(fingerprint, officialUrl);
  return probes.map((probe) => ({
    ...probe,
    goal: buildProbeGoal(probe, fingerprint, referenceIdentifier),
  }));
}

function buildSearchQueries(fingerprint: BrandFingerprint, officialUrl: string) {
  const referenceIdentifier = deriveReferenceIdentifier(fingerprint, officialUrl);
  const baseQuery = [fingerprint.brandName, fingerprint.productName].filter(Boolean).join(" ").trim();
  const exactQuery = [baseQuery, referenceIdentifier].filter(Boolean).join(" ").trim();

  return {
    baseQuery,
    exactQuery: exactQuery || baseQuery,
    cheapQuery: `${baseQuery} giá rẻ`,
    genuineQuery: `${baseQuery} chính hãng`,
    counterfeitQuery: `${baseQuery} hàng nguyên a`,
    grayMarketQuery: `${baseQuery} no box no invoice`,
  };
}

function deriveReferenceIdentifier(fingerprint: BrandFingerprint, officialUrl: string) {
  const knownId = fingerprint.knownProducts
    .map((entry) => entry.match(/\b[a-z0-9]{4,}\b/i)?.[0] ?? "")
    .find((entry) => /^\d{4,}$/.test(entry));
  if (knownId) {
    return knownId;
  }

  try {
    const url = new URL(officialUrl);
    const segment = url.pathname
      .split("/")
      .map((entry) => entry.replace(/\.[a-z0-9]+$/i, ""))
      .find((entry) => /^\d{4,}$/.test(entry));
    return segment ?? "";
  } catch {
    return "";
  }
}

function mergeCandidates(
  currentCandidates: ListingCandidate[],
  incomingCandidates: ListingCandidate[],
) {
  const merged = new Map<string, ListingCandidate>();

  for (const candidate of [...currentCandidates, ...incomingCandidates]) {
    const key = candidateIdentityKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }

    merged.set(key, {
      ...existing,
      id: existing.id || candidate.id,
      url: preferCandidateUrl(existing.url, candidate.url),
      title: preferLongerText(existing.title, candidate.title),
      signalTags: Array.from(new Set([...existing.signalTags, ...candidate.signalTags])),
      counterfeitRisk: Math.max(existing.counterfeitRisk, candidate.counterfeitRisk),
      sellerFraudRisk: Math.max(existing.sellerFraudRisk, candidate.sellerFraudRisk),
      confidence: Math.max(existing.confidence, candidate.confidence),
      reasoning: Array.from(new Set([...existing.reasoning, ...candidate.reasoning])).slice(0, 6),
    });
  }

  return Array.from(merged.values()).sort(
    (left, right) =>
      right.counterfeitRisk + right.sellerFraudRisk - (left.counterfeitRisk + left.sellerFraudRisk),
  );
}

function mergeSellerProfiles(
  currentProfiles: SellerProfile[],
  incomingProfiles: SellerProfile[],
  candidates: ListingCandidate[],
) {
  const merged = new Map<string, SellerProfile>();

  for (const profile of [...currentProfiles, ...incomingProfiles]) {
    const key = profile.id || profile.sellerName.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, profile);
      continue;
    }

    merged.set(key, {
      ...existing,
      storefrontUrl: preferCandidateUrl(existing.storefrontUrl, profile.storefrontUrl),
      location: existing.location !== "unknown" ? existing.location : profile.location,
      rating: Math.max(existing.rating, profile.rating),
      reviewCount: Math.max(existing.reviewCount, profile.reviewCount),
      accountAgeDays: Math.max(existing.accountAgeDays, profile.accountAgeDays),
      transactionVolume: Math.max(existing.transactionVolume, profile.transactionVolume),
      redFlags: Array.from(new Set([...existing.redFlags, ...profile.redFlags])),
      linkedListingIds: Array.from(
        new Set([...existing.linkedListingIds, ...profile.linkedListingIds]),
      ),
      counterfeitRisk: Math.max(existing.counterfeitRisk, profile.counterfeitRisk),
      sellerFraudRisk: Math.max(existing.sellerFraudRisk, profile.sellerFraudRisk),
      summary: preferLongerText(existing.summary, profile.summary),
    });
  }

  for (const candidate of candidates) {
    const key = candidate.sellerId;
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, {
        ...existing,
        linkedListingIds: Array.from(new Set([...existing.linkedListingIds, candidate.id])),
        counterfeitRisk: Math.max(existing.counterfeitRisk, candidate.counterfeitRisk),
        sellerFraudRisk: Math.max(existing.sellerFraudRisk, candidate.sellerFraudRisk),
      });
      continue;
    }

    merged.set(key, {
      id: candidate.sellerId,
      sellerName: candidate.sellerName,
      marketplace: candidate.marketplace,
      storefrontUrl: candidate.url,
      location: "unknown",
      rating: 4.1,
      reviewCount: 0,
      accountAgeDays: 90,
      responseTimeHours: 24,
      transactionVolume: 0,
      redFlags: candidate.signalTags.slice(0, 3),
      linkedListingIds: [candidate.id],
      counterfeitRisk: candidate.counterfeitRisk,
      sellerFraudRisk: candidate.sellerFraudRisk,
      summary: `${candidate.sellerName} surfaced through the parallel search sweep.`,
    });
  }

  return Array.from(merged.values()).sort(
    (left, right) => right.sellerFraudRisk - left.sellerFraudRisk,
  );
}

function candidateIdentityKey(candidate: ListingCandidate) {
  return [
    normalizeIdentityToken(candidate.url),
    normalizeIdentityToken(candidate.title),
    normalizeIdentityToken(candidate.sellerId || candidate.sellerName),
    normalizeIdentityToken(candidate.marketplace),
  ].join("|");
}

function normalizeIdentityToken(value: string) {
  return value.trim().toLowerCase();
}

function preferCandidateUrl(currentUrl: string, nextUrl: string) {
  const currentIsSearch = classifyMarketplaceUrl(currentUrl) === "search";
  const nextIsSearch = classifyMarketplaceUrl(nextUrl) === "search";

  if (currentIsSearch && !nextIsSearch) {
    return nextUrl;
  }
  if (!currentIsSearch && nextIsSearch) {
    return currentUrl;
  }
  return nextUrl.length > currentUrl.length ? nextUrl : currentUrl;
}

function preferLongerText(currentText: string, nextText: string) {
  return nextText.length > currentText.length ? nextText : currentText;
}

function chooseBetterFingerprint(current: BrandFingerprint, next: BrandFingerprint) {
  return {
    ...current,
    brandName: next.brandName || current.brandName,
    productName:
      next.productName && !/^core product$/i.test(next.productName) ? next.productName : current.productName,
    authorizedDomains: Array.from(new Set([...current.authorizedDomains, ...next.authorizedDomains])),
    authorizedChannels: Array.from(new Set([...current.authorizedChannels, ...next.authorizedChannels])),
    knownProducts: Array.from(new Set([...current.knownProducts, ...next.knownProducts])),
    claims: Array.from(new Set([...current.claims, ...next.claims])),
    visualMotifs: Array.from(new Set([...current.visualMotifs, ...next.visualMotifs])),
    referencePrice: next.referencePrice || current.referencePrice,
    currency: next.currency || current.currency,
  };
}

function humanizeRunStatus(status: string) {
  return status.toLowerCase().replace(/_/g, " ");
}

function normalizeTinyFishResult(
  rawResult: unknown,
  fallback: InvestigationRun,
  officialUrl: string,
): {
  brandFingerprint: BrandFingerprint;
  candidates: ListingCandidate[];
  sellerProfiles: SellerProfile[];
} | null {
  const root = unwrapResult(rawResult);
  const brandFingerprint = normalizeBrandFingerprint(root, fallback.brandFingerprint, officialUrl);
  const candidateSources = collectCandidateSources(root);

  if (candidateSources.length === 0) {
    return null;
  }

  const rawSellerProfiles = collectSellerProfileSources(root);
  const sellerProfileLookup = new Map<string, SellerProfile>();

  for (const rawSellerProfile of rawSellerProfiles) {
    const normalized = normalizeSellerProfile(rawSellerProfile, brandFingerprint);
    if (normalized) {
      sellerProfileLookup.set(normalized.id, normalized);
      sellerProfileLookup.set(normalized.sellerName.toLowerCase(), normalized);
    }
  }

  const candidates = candidateSources
    .map((candidateSource, index) =>
      normalizeCandidate(candidateSource, index, brandFingerprint, sellerProfileLookup),
    )
    .filter((candidate): candidate is ListingCandidate => Boolean(candidate));

  if (candidates.length === 0) {
    return null;
  }

  const initialSellerProfiles = buildSellerProfiles(candidates, rawSellerProfiles, brandFingerprint);
  const pricedCandidates = recalibrateCandidatePricing(candidates, initialSellerProfiles, brandFingerprint);
  const sellerProfiles = buildSellerProfiles(pricedCandidates, rawSellerProfiles, brandFingerprint);

  return {
    brandFingerprint,
    candidates: pricedCandidates,
    sellerProfiles,
  };
}

function unwrapResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const nested = record.result ?? record.data ?? record.payload;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }

  return record;
}

function normalizeBrandFingerprint(
  root: Record<string, unknown> | null,
  fallback: BrandFingerprint,
  officialUrl: string,
): BrandFingerprint {
  const source = root?.brandFingerprint && typeof root.brandFingerprint === "object"
    ? (root.brandFingerprint as Record<string, unknown>)
    : root;

  const brandName = pickString(source, ["brandName", "brand", "manufacturer"], fallback.brandName);
  const productName = pickString(
    source,
    ["productName", "product", "model", "listingTitle", "title"],
    fallback.productName,
  );
  const domain = pickString(source, ["domain"], fallback.domain);
  const currency = pickString(source, ["currency"], fallback.currency);
  const referencePrice = pickNumber(
    source,
    ["referencePrice", "reference_price", "officialPrice", "msrp", "price"],
    fallback.referencePrice,
  );
  const claims = pickStringArray(source, ["claims", "keyFeatures"], fallback.claims);
  const visualMotifs = pickStringArray(
    source,
    ["visualMotifs", "visual_motifs", "materials"],
    fallback.visualMotifs,
  );
  const knownProducts = pickStringArray(
    source,
    ["knownProducts", "known_products"],
    Array.from(new Set([fallback.productName, productName, ...fallback.knownProducts])).filter(Boolean),
  );

  return {
    brandName,
    productName,
    officialUrl: pickString(source, ["officialUrl", "official_url"], officialUrl) ?? officialUrl,
    domain,
    authorizedDomains: pickStringArray(
      source,
      ["authorizedDomains", "authorized_domains"],
      fallback.authorizedDomains,
    ),
    authorizedChannels: pickStringArray(
      source,
      ["authorizedChannels", "authorized_channels"],
      fallback.authorizedChannels,
    ),
    knownProducts,
    claims,
    visualMotifs,
    referencePrice,
    currency,
  };
}

function collectCandidateSources(root: Record<string, unknown> | null) {
  const sources = new Map<string, Record<string, unknown>>();
  const queue: unknown[] = root ? [root] : [];
  const seen = new Set<unknown>();
  const candidateKeys = [
    "candidates",
    "listings",
    "results",
    "items",
    "searchResults",
    "marketplaceListings",
    "prioritizedListings",
    "lazadaListings",
    "suspectListings",
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current) || typeof current !== "object") {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (isRecord(item)) {
          if (looksLikeCandidate(item)) {
            const key = stableCandidateKey(item);
            sources.set(key, item);
          } else {
            queue.push(item);
          }
        }
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const key of candidateKeys) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isRecord(item)) {
            if (looksLikeCandidate(item)) {
              sources.set(stableCandidateKey(item), item);
            } else {
              queue.push(item);
            }
          }
        }
      } else if (isRecord(value)) {
        queue.push(value);
      }
    }

    for (const nestedKey of ["data", "result", "payload", "lazada", "marketplace", "marketplaces"]) {
      const nested = record[nestedKey];
      if (nested) {
        queue.push(nested);
      }
    }
  }

  return Array.from(sources.values());
}

function collectSellerProfileSources(root: Record<string, unknown> | null) {
  const sources = new Map<string, Record<string, unknown>>();
  const queue: unknown[] = root ? [root] : [];
  const seen = new Set<unknown>();
  const sellerKeys = ["sellerProfiles", "sellers", "vendors", "stores"];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current) || typeof current !== "object") {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (isRecord(item)) {
          if (looksLikeSellerProfile(item)) {
            sources.set(stableSellerKey(item), item);
          } else {
            queue.push(item);
          }
        }
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const key of sellerKeys) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (isRecord(item)) {
            if (looksLikeSellerProfile(item)) {
              sources.set(stableSellerKey(item), item);
            } else {
              queue.push(item);
            }
          }
        }
      } else if (isRecord(value)) {
        queue.push(value);
      }
    }
  }

  return Array.from(sources.values());
}

function normalizeCandidate(
  source: Record<string, unknown>,
  index: number,
  fingerprint: BrandFingerprint,
  sellerProfileLookup: Map<string, SellerProfile>,
): ListingCandidate | null {
  const title = pickString(source, ["title", "name", "listingTitle", "productName"], "");
  const url = pickString(source, ["url", "link", "href", "productUrl"], "");
  if (!url || classifyMarketplaceUrl(url) !== "listing") {
    return null;
  }

  const marketplace = pickString(
    source,
    ["marketplace", "source", "platform"],
    inferMarketplace(url),
  );
  const sellerName = pickString(
    source,
    ["sellerName", "seller", "shopName", "storeName", "vendor", "merchant"],
    inferSellerName(url, marketplace, index),
  );
  const sellerId = pickString(
    source,
    ["sellerId", "seller_id", "storeId"],
    buildSellerId(sellerName, `${marketplace}-${index + 1}`),
  );
  const resolvedUrl = url;
  const price = pickNumber(
    source,
    ["price", "currentPrice", "listedPrice", "amount", "value"],
    Number.NaN,
  );
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  const currency = pickString(source, ["currency"], fingerprint.currency);
  const condition = pickString(source, ["condition", "state"], "new");
  const signalTags = normalizeStringArray(source, ["signalTags", "signals", "flags", "redFlags"]);
  const candidateSeller = sellerProfileLookup.get(sellerId.toLowerCase()) ?? sellerProfileLookup.get(sellerName.toLowerCase());
  const sellerStub = candidateSeller
    ? candidateSeller
    : {
        id: sellerId,
      sellerName,
      marketplace,
      storefrontUrl: resolvedUrl,
      location: pickString(source, ["location", "sellerLocation"], "unknown"),
      rating: pickNumber(source, ["rating", "sellerRating"], 4.6),
      reviewCount: pickNumber(source, ["reviewCount", "reviews", "reviewTotal"], 100),
      accountAgeDays: pickNumber(source, ["accountAgeDays", "accountAge", "sellerAgeDays"], 365),
      responseTimeHours: pickNumber(source, ["responseTimeHours", "responseHours"], 12),
      transactionVolume: pickNumber(source, ["transactionVolume", "sales", "volume"], 0),
      redFlags: signalTags.slice(0, 3),
      linkedListingIds: [],
        counterfeitRisk: 0,
        sellerFraudRisk: 0,
        summary: `${sellerName} requires manual review.`,
      };

  const counterfeit = scoreCounterfeitRisk(
    fingerprint,
    {
      price,
      currency,
      condition,
      signalTags,
      marketplace,
      sellerName,
    },
    sellerStub,
  );
  const sellerFraud = scoreSellerFraudRisk(
    {
      price,
      currency,
      signalTags,
      sellerName,
    },
    sellerStub,
  );

  const reasoning = normalizeReasoning(source, counterfeit.reasons, sellerFraud.reasons);

  const modelCounterfeitRisk = pickScore(source, ["counterfeitRisk", "risk"], -1);
  const modelSellerFraudRisk = pickScore(source, ["sellerFraudRisk", "fraudRisk"], -1);
  const counterfeitRisk = blendRiskScore(counterfeit.score, modelCounterfeitRisk);
  const sellerFraudRisk = blendRiskScore(sellerFraud.score, modelSellerFraudRisk);
  const confidence = pickConfidence(
    source,
    ["confidence", "confidenceScore"],
    clampConfidence(counterfeitRisk, sellerFraudRisk, sellerStub.reviewCount),
  );

  return {
    id: pickString(
      source,
      ["id", "candidateId", "listingId"],
      buildCandidateId(resolvedUrl, title || `${fingerprint.brandName} listing`, sellerId, marketplace, index),
    ),
    source: "tinyfish",
    marketplace,
    url: resolvedUrl,
    title: title || `${fingerprint.brandName} listing`,
    sellerId,
    sellerName,
    price,
    currency,
    condition,
    signalTags,
    counterfeitRisk,
    sellerFraudRisk,
    confidence,
    reasoning,
  };
}

function normalizeSellerProfile(
  source: Record<string, unknown>,
  fingerprint: BrandFingerprint,
): SellerProfile | null {
  const sellerName = pickString(source, ["sellerName", "name", "shopName", "storeName"], "");
  if (!sellerName) {
    return null;
  }

  const marketplace = pickString(source, ["marketplace", "platform"], "Lazada");
  const linkedListingIds = normalizeStringArray(source, ["linkedListingIds", "linkedListings"]);

  return {
    id: pickString(
      source,
      ["id", "sellerId", "storeId"],
      buildSellerId(sellerName, `${marketplace}-${linkedListingIds.length}`),
    ),
    sellerName,
    marketplace,
    storefrontUrl: pickString(source, ["storefrontUrl", "url", "link"], buildMarketplaceUrl(marketplace, sellerName)),
    location: pickString(source, ["location", "sellerLocation"], "unknown"),
    rating: pickRating(source, ["rating", "sellerRating"], 4.1),
    reviewCount: pickCount(source, ["reviewCount", "reviews", "reviewTotal"], 0),
    accountAgeDays: pickAccountAgeDays(source, ["accountAgeDays", "accountAge", "sellerAgeDays", "yearsActive"], 90),
    responseTimeHours: pickNumber(source, ["responseTimeHours", "responseHours"], 24),
    transactionVolume: pickNumber(source, ["transactionVolume", "sales", "volume"], 0),
    redFlags: normalizeStringArray(source, ["redFlags", "flags"]),
    linkedListingIds,
    counterfeitRisk: pickScore(source, ["counterfeitRisk", "risk"], 0),
    sellerFraudRisk: pickScore(source, ["sellerFraudRisk", "fraudRisk"], 0),
    summary:
      pickString(source, ["summary", "notes"], "") ||
      `${sellerName} requires manual review against ${fingerprint.brandName}.`,
  };
}

function buildSellerProfiles(
  candidates: ListingCandidate[],
  rawSellerProfiles: Record<string, unknown>[],
  fingerprint: BrandFingerprint,
): SellerProfile[] {
  const bySeller = new Map<string, SellerProfile>();

  for (const rawSellerProfile of rawSellerProfiles) {
    const normalized = normalizeSellerProfile(rawSellerProfile, fingerprint);
    if (normalized) {
      bySeller.set(normalized.id, normalized);
      bySeller.set(normalized.sellerName.toLowerCase(), normalized);
    }
  }

  for (const candidate of candidates) {
    const existing =
      bySeller.get(candidate.sellerId) ?? bySeller.get(candidate.sellerName.toLowerCase());
    if (existing) {
      bySeller.set(existing.id, {
        ...existing,
        linkedListingIds: Array.from(new Set([...existing.linkedListingIds, candidate.id])),
        counterfeitRisk: Math.max(existing.counterfeitRisk, candidate.counterfeitRisk),
        sellerFraudRisk: Math.max(existing.sellerFraudRisk, candidate.sellerFraudRisk),
      });
      continue;
    }

    const derived: SellerProfile = {
      id: candidate.sellerId,
      sellerName: candidate.sellerName,
      marketplace: candidate.marketplace,
      storefrontUrl: candidate.url,
      location: "unknown",
      rating: 4.1,
      reviewCount: 0,
      accountAgeDays: 90,
      responseTimeHours: 24,
      transactionVolume: 0,
      redFlags: candidate.signalTags.slice(0, 3),
      linkedListingIds: [candidate.id],
      counterfeitRisk: candidate.counterfeitRisk,
      sellerFraudRisk: candidate.sellerFraudRisk,
      summary: `${candidate.sellerName} requires manual review.`,
    };
    bySeller.set(derived.id, derived);
  }

  const uniqueProfiles = new Map<string, SellerProfile>();
  for (const seller of bySeller.values()) {
    uniqueProfiles.set(seller.id, seller);
  }

  return Array.from(uniqueProfiles.values()).sort(
    (left, right) => right.sellerFraudRisk - left.sellerFraudRisk,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function buildSellerId(sellerName: string, seed: string | number) {
  const slug = slugifyValue(sellerName).slice(0, 40);
  const suffix = slugifyValue(String(seed)).slice(0, 24);
  return `seller_live_${slug || "unknown"}_${suffix || "seed"}`;
}

function buildCandidateId(
  url: string,
  title: string,
  sellerId: string,
  marketplace: string,
  index: number,
) {
  const base = [url, title, sellerId, marketplace].find(Boolean) ?? `candidate-${index + 1}`;
  return `candidate_${slugifyValue(base).slice(0, 88) || `live-${index + 1}`}`;
}

function slugifyValue(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function looksLikeCandidate(value: Record<string, unknown>) {
  return Boolean(
    value.url || value.link || value.href || value.title || value.name || value.price || value.sellerName,
  );
}

function looksLikeSellerProfile(value: Record<string, unknown>) {
  return Boolean(value.sellerName || value.name || value.shopName || value.storeName);
}

function pickString(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = "",
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function pickNumber(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = 0,
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace(/[^0-9.-]+/g, ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return fallback;
}

function pickCount(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = 0,
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    const parsed = normalizeCountValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return fallback;
}

function pickRating(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = 0,
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    const parsed = normalizeRatingValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return fallback;
}

function pickAccountAgeDays(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = 0,
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    const parsed = normalizeAgeDays(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return fallback;
}

function pickScore(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = 0,
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    const parsed = normalizeScoreValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return fallback;
}

function blendRiskScore(deterministicScore: number, modelScore: number) {
  if (modelScore < 0) {
    return deterministicScore;
  }

  return Math.max(deterministicScore, modelScore);
}

function pickConfidence(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback = 0,
) {
  if (!source) {
    return fallback;
  }

  for (const key of keys) {
    const value = source[key];
    const parsed = normalizeConfidenceValue(value);
    if (parsed !== null) {
      return parsed;
    }
  }

  return fallback;
}

function normalizeStringArray(
  source: Record<string, unknown> | null,
  keys: string[],
) {
  if (!source) {
    return [];
  }

  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
      return value
        .split(/[,;|]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }

  return [];
}

function pickStringArray(
  source: Record<string, unknown> | null,
  keys: string[],
  fallback: string[],
) {
  const values = normalizeStringArray(source, keys);
  return values.length > 0 ? Array.from(new Set(values)) : fallback;
}

function normalizeReasoning(
  source: Record<string, unknown>,
  ...reasonLists: string[][]
) {
  const sourceReasoning = extractReasoningItems(source);
  const combined = [...sourceReasoning, ...reasonLists.flat()].map((entry) => entry.trim()).filter(Boolean);
  return Array.from(new Set(combined)).slice(0, 5);
}

function stableCandidateKey(source: Record<string, unknown>) {
  return [
    pickString(source, ["url", "link", "href"], ""),
    pickString(source, ["title", "name"], ""),
    pickString(source, ["sellerName", "seller", "shopName", "storeName"], ""),
  ].join("|");
}

function stableSellerKey(source: Record<string, unknown>) {
  return [
    pickString(source, ["sellerName", "name", "shopName", "storeName"], ""),
    pickString(source, ["marketplace", "platform"], ""),
  ].join("|");
}

function inferMarketplace(url: string) {
  const normalized = url.toLowerCase();
  if (normalized.includes("amazon.")) {
    return "Amazon";
  }
  if (normalized.includes("shopee.vn")) {
    return "Shopee VN";
  }
  if (normalized.includes("lazada.vn")) {
    return "Lazada VN";
  }
  if (normalized.includes("lazada")) {
    return "Lazada";
  }
  if (normalized.includes("facebook.com/marketplace")) {
    return "Facebook Marketplace";
  }
  return "Lazada";
}

function inferSellerName(url: string, marketplace: string, index: number) {
  const host = safeHostname(url);
  if (host) {
    return `${host.replace(/^www\./i, "")}-${marketplace.toLowerCase().replace(/\s+/g, "-")}-${index + 1}`;
  }
  return `${marketplace.toLowerCase().replace(/\s+/g, "-")}-${index + 1}`;
}

function safeHostname(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function buildMarketplaceUrl(marketplace: string, query: string) {
  const encoded = encodeURIComponent(query.trim() || "brand product");
  if (marketplace === "Facebook Marketplace") {
    return `https://www.facebook.com/marketplace/search/?query=${encoded}`;
  }
  if (marketplace === "Amazon") {
    return `https://www.amazon.com/s?k=${encoded}`;
  }
  if (marketplace === "Shopee VN") {
    return `https://shopee.vn/search?keyword=${encoded}`;
  }
  return `https://www.lazada.vn/catalog/?q=${encoded}`;
}

function classifyMarketplaceUrl(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const search = `${parsed.search}${parsed.hash}`.toLowerCase();

    if (
      path.includes("/search") ||
      path.includes("/results") ||
      path.includes("/browse") ||
      /[?&](q|query|keyword|search|k)=/.test(search)
    ) {
      return "search" as const;
    }

    return "listing" as const;
  } catch {
    return "listing" as const;
  }
}

function recalibrateCandidatePricing(
  candidates: ListingCandidate[],
  sellerProfiles: SellerProfile[],
  fingerprint: BrandFingerprint,
) {
  const benchmark = findOfficialBenchmarkCandidate(candidates, fingerprint);
  if (!benchmark) {
    return candidates;
  }

  return candidates.map((candidate) => {
    if (candidate.currency !== benchmark.currency) {
      return candidate;
    }

    const seller =
      sellerProfiles.find((profile) => profile.id === candidate.sellerId) ??
      sellerProfiles.find((profile) => profile.sellerName.toLowerCase() === candidate.sellerName.toLowerCase());

    const counterfeit = scoreCounterfeitRisk(
      {
        ...fingerprint,
        referencePrice: benchmark.price,
        currency: benchmark.currency,
      },
      candidate,
      seller,
    );
    const sellerFraud = scoreSellerFraudRisk(
      candidate,
      seller ?? {
        rating: 4.1,
        reviewCount: 0,
        accountAgeDays: 90,
        responseTimeHours: 24,
        transactionVolume: 0,
        redFlags: [],
      },
      {
        referencePrice: benchmark.price,
        referenceCurrency: benchmark.currency,
      },
    );

    if (candidate.id === benchmark.id) {
      return {
        ...candidate,
        counterfeitRisk: Math.min(candidate.counterfeitRisk, 24),
      };
    }

    return {
      ...candidate,
      counterfeitRisk: Math.max(candidate.counterfeitRisk, counterfeit.score),
      sellerFraudRisk: Math.max(candidate.sellerFraudRisk, sellerFraud.score),
    };
  });
}

function findOfficialBenchmarkCandidate(
  candidates: ListingCandidate[],
  fingerprint: BrandFingerprint,
) {
  const brandToken = fingerprint.brandName.trim().toLowerCase();

  return candidates
    .filter((candidate) => {
      if (classifyMarketplaceUrl(candidate.url) !== "listing") {
        return false;
      }

      const sellerName = candidate.sellerName.toLowerCase();
      const title = candidate.title.toLowerCase();
      const tags = candidate.signalTags.join(" ").toLowerCase();
      const host = safeHostname(candidate.url).toLowerCase();
      const hasBrandSeller = sellerName.includes(brandToken);
      const hasAuthorizedDomain = fingerprint.authorizedDomains.some((domain) => {
        const normalizedDomain = domain.toLowerCase();
        return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
      });
      const hasTrustedBadge = /lazmall|brand store|official_store|mall/.test(tags);
      const hasOfficialSignal =
        hasAuthorizedDomain ||
        hasBrandSeller ||
        (hasTrustedBadge && hasBrandSeller);
      const hasCounterfeitSignal = /h[àa]ng nguy[êe]n a|1:1|replica|copy|fake|super\s*fake/.test(
        `${title} ${tags}`,
      );
      const hasSuspiciousAuthenticityClaim =
        /(ch[íi]nh h[ãa]ng|authentic|genuine|original)/.test(`${title} ${tags}`) &&
        !hasAuthorizedDomain &&
        !hasBrandSeller;
      return (
        hasOfficialSignal &&
        !hasCounterfeitSignal &&
        !hasSuspiciousAuthenticityClaim &&
        candidate.counterfeitRisk <= 28 &&
        candidate.sellerFraudRisk <= 35
      );
    })
    .sort((left, right) => left.counterfeitRisk - right.counterfeitRisk)[0];
}

function normalizeCountValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/\+/g, "");
  const match = normalized.match(/([\d.]+)\s*([km])?/);
  if (!match) {
    return null;
  }

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const suffix = match[2];
  if (suffix === "k") {
    return Math.round(amount * 1_000);
  }
  if (suffix === "m") {
    return Math.round(amount * 1_000_000);
  }
  return Math.round(amount);
}

function normalizeRatingValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 5 ? Math.min(5, value / 20) : value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number.parseFloat(value.replace(/[^0-9.]+/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed > 5 ? Math.min(5, parsed / 20) : parsed;
}

function normalizeAgeDays(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const parsed = Number.parseFloat(normalized.replace(/[^0-9.]+/g, ""));
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (normalized.includes("year")) {
    return Math.round(parsed * 365);
  }
  if (normalized.includes("month")) {
    return Math.round(parsed * 30);
  }
  if (normalized.includes("week")) {
    return Math.round(parsed * 7);
  }
  return Math.round(parsed);
}

function normalizeScoreValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumericScore(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const numeric = Number.parseFloat(value.replace(/[^0-9.]+/g, ""));
  if (Number.isFinite(numeric)) {
    return clampNumericScore(numeric);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.includes("low-medium")) {
    return 44;
  }
  if (normalized.includes("medium-high")) {
    return 72;
  }
  if (normalized.includes("medium")) {
    return 58;
  }
  if (normalized.includes("high")) {
    return 84;
  }
  if (normalized.includes("low")) {
    return 24;
  }
  return null;
}

function normalizeConfidenceValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumericScore(value <= 1 ? value * 100 : value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const numeric = Number.parseFloat(value.replace(/[^0-9.]+/g, ""));
  if (Number.isFinite(numeric)) {
    return clampNumericScore(numeric <= 1 ? numeric * 100 : numeric);
  }

  return normalizeScoreValue(value);
}

function clampNumericScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function extractReasoningItems(source: Record<string, unknown>) {
  const items: string[] = [];
  for (const key of ["reasoning", "reasons", "notes", "analysisSummary", "evidence"]) {
    const value = source[key];
    if (Array.isArray(value)) {
      items.push(
        ...value
          .filter((entry): entry is string => typeof entry === "string")
          .flatMap((entry) => splitReasoning(entry)),
      );
      continue;
    }

    if (typeof value === "string" && value.trim()) {
      items.push(...splitReasoning(value));
    }
  }

  return items;
}

function splitReasoning(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length < 190) {
    return [normalized];
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9[])/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return sentences.length > 0 ? sentences : [normalized];
}

function clampConfidence(counterfeitRisk: number, sellerFraudRisk: number, reviewCount: number) {
  const base = Math.max(counterfeitRisk, sellerFraudRisk) * 0.72;
  const reviewBoost = Math.min(12, Math.log10(reviewCount + 1) * 4);
  return Math.max(35, Math.min(98, Math.round(base + reviewBoost)));
}

async function* mockEvents(
  run: InvestigationRun,
): AsyncGenerator<InvestigationEvent, InvestigationRun, void> {
  for (const event of run.events) {
    yield event;
    await wait(140);
  }
  return run;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
