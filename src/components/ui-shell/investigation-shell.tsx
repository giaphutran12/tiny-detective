"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  Radar,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import type {
  AuthorityPacket,
  BrandFingerprint,
  CaseDossier,
  InvestigationEvent,
  ListingCandidate,
  MarketplacePacket,
  SellerProfile,
} from "@/lib/investigation/types";

type ActivityItem = {
  id: string;
  label: string;
  tone: "neutral" | "live" | "warning" | "risk" | "success";
  timestamp: string;
};

type ProbeStatus = "waiting" | "working" | "live" | "complete" | "error";

type ProbePanel = {
  id: string;
  label: string;
  status: ProbeStatus;
  streamingUrl: string | null;
  activity: ActivityItem[];
  updatedAt: string;
};

type InvestigationPayload = {
  runId?: string;
  officialUrl: string;
  brandFingerprint: BrandFingerprint;
  candidates: ListingCandidate[];
  sellerProfiles: SellerProfile[];
};

type ReportResponse = {
  marketplacePacket: MarketplacePacket;
  authorityPacket: AuthorityPacket;
};

const starterUrl = "https://www.crocs.com/p/classic-clog/10001.html";

const demoBullets = [
  "Paste one official product URL and let TinyFish infer brand cues, price anchors, and product traits.",
  "Establish a clean marketplace benchmark first, then stream suspicious marketplace leads into a ranked evidence view instead of hunting listing by listing.",
  "Turn selected listings into a seller case, then export both a marketplace packet and an authority-ready report.",
];

export function InvestigationShell() {
  const [officialUrl, setOfficialUrl] = useState(starterUrl);
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "error">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [brandFingerprint, setBrandFingerprint] = useState<BrandFingerprint | null>(null);
  const [candidates, setCandidates] = useState<ListingCandidate[]>([]);
  const [sellerProfiles, setSellerProfiles] = useState<SellerProfile[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [probePanels, setProbePanels] = useState<ProbePanel[]>([]);
  const [probeTotals, setProbeTotals] = useState({
    completed: 0,
    total: 0,
  });
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [caseDossier, setCaseDossier] = useState<CaseDossier | null>(null);
  const [reports, setReports] = useState<ReportResponse | null>(null);
  const [activeReportTab, setActiveReportTab] = useState<"marketplace" | "authority">(
    "marketplace",
  );
  const [activityOpen, setActivityOpen] = useState(true);
  const [isBuildingCase, startCaseTransition] = useTransition();
  const [isBuildingReport, startReportTransition] = useTransition();

  const sortedCandidates = [...candidates].sort(
    (left, right) =>
      right.counterfeitRisk + right.sellerFraudRisk - (left.counterfeitRisk + left.sellerFraudRisk),
  );
  const officialBenchmark =
    brandFingerprint ? findOfficialBenchmarkCandidate(sortedCandidates, brandFingerprint) ?? null : null;
  const visibleCandidates =
    officialBenchmark && sortedCandidates.some((candidate) => candidate.id !== officialBenchmark.id)
      ? sortedCandidates.filter((candidate) => candidate.id !== officialBenchmark.id)
      : sortedCandidates;

  const selectedCandidates = candidates.filter((candidate) =>
    selectedCandidateIds.includes(candidate.id),
  );

  const featuredCounterfeitCandidate = visibleCandidates[0] ?? null;
  const prioritizedSellerProfiles = [...(caseDossier?.sellerProfiles ?? sellerProfiles)].sort(
    (left, right) => right.sellerFraudRisk - left.sellerFraudRisk,
  );
  const activePacket =
    activeReportTab === "marketplace" ? reports?.marketplacePacket : reports?.authorityPacket;
  const evidenceFeed =
    caseDossier?.evidence.length
      ? caseDossier.evidence
      : visibleCandidates.flatMap((candidate) => candidate.reasoning).slice(0, 6);
  const liveProbeCount = probePanels.filter((panel) => panel.streamingUrl).length;
  const activeProbeCount = probePanels.filter(
    (panel) => panel.status === "working" || panel.status === "live",
  ).length;
  const hasLiveCandidates = candidates.some((candidate) => candidate.source === "tinyfish");
  const readinessBadge = hasLiveCandidates
    ? { label: "live-results", tone: "live" as const }
    : status === "running" || Boolean(runId) || probePanels.length > 0 || Boolean(brandFingerprint)
      ? { label: "live-session", tone: "live" as const }
      : { label: "ready", tone: "neutral" as const };

  async function handleInvestigate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("running");
    setRunId(null);
    setBrandFingerprint(null);
    setCandidates([]);
    setSellerProfiles([]);
    setSelectedCandidateIds([]);
    setProbePanels([]);
    setProbeTotals({
      completed: 0,
      total: 0,
    });
    setActivity([
      {
        id: crypto.randomUUID(),
        label: "Investigation queued. Preparing TinyFish orchestration.",
        tone: "neutral",
        timestamp: new Date().toISOString(),
      },
    ]);
    setLastError(null);
    setCaseDossier(null);
    setReports(null);

    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ officialUrl }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? "Investigation failed to start.");
      }

      await consumeEventStream(response, (streamEvent) => {
        setRunId(streamEvent.runId ?? null);
        if (shouldTrackProbeEvent(streamEvent)) {
          setProbePanels((current) => syncProbePanels(current, streamEvent));
        }
        if (
          typeof streamEvent.result?.completedAgents === "number" ||
          typeof streamEvent.result?.totalAgents === "number"
        ) {
          setProbeTotals((current) => ({
            completed: streamEvent.result?.completedAgents ?? current.completed,
            total: streamEvent.result?.totalAgents ?? current.total,
          }));
        }

        if (streamEvent.result?.brandFingerprint) {
          setBrandFingerprint(streamEvent.result.brandFingerprint);
        }
        if (streamEvent.result?.candidates) {
          setCandidates(streamEvent.result.candidates);
        }
        if (streamEvent.result?.sellerProfiles) {
          setSellerProfiles(streamEvent.result.sellerProfiles);
        }

        if (streamEvent.type === "started") {
          pushActivity(setActivity, streamEvent.message ?? "Investigation started.", "live");
          return;
        }

        if (streamEvent.type === "streaming_url") {
          pushActivity(
            setActivity,
            streamEvent.message ??
              `${streamEvent.probeLabel ?? "A probe"} opened a live browser session.`,
            "success",
          );
          return;
        }

        if (streamEvent.type === "progress") {
          pushActivity(setActivity, streamEvent.message ?? "TinyFish is collecting evidence.", "live");
          return;
        }

        if (streamEvent.type === "heartbeat") {
          return;
        }

        if (streamEvent.type === "fingerprint") {
          pushActivity(
            setActivity,
            streamEvent.message ?? "Official product fingerprint captured.",
            "success",
          );
          return;
        }

        if (streamEvent.type === "candidate_found") {
          const nextSellerProfiles =
            streamEvent.result?.sellerProfiles ??
            buildSellerProfiles(streamEvent.result?.candidates ?? []);
          setSellerProfiles(nextSellerProfiles);
          pushActivity(
            setActivity,
            streamEvent.message ?? "A search probe returned new suspicious candidates.",
            "warning",
          );
          return;
        }

        if (streamEvent.type === "complete") {
          const nextSellerProfiles =
            streamEvent.result?.sellerProfiles ??
            buildSellerProfiles(streamEvent.result?.candidates ?? []);
          setSellerProfiles(nextSellerProfiles);
          setStatus("complete");
          pushActivity(
            setActivity,
            streamEvent.message ?? "Investigation completed and candidates ranked.",
            "success",
          );
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected error while starting investigation.";
      setStatus("error");
      setLastError(message);
      pushActivity(setActivity, message, "risk");
    }
  }

  function toggleCandidate(candidateId: string) {
    setSelectedCandidateIds((current) =>
      current.includes(candidateId)
        ? current.filter((entry) => entry !== candidateId)
        : [...current, candidateId],
    );
    setCaseDossier(null);
    setReports(null);
  }

  function handleBuildCase() {
    if (!brandFingerprint || selectedCandidateIds.length === 0) {
      return;
    }

    startCaseTransition(async () => {
      try {
        const investigation: InvestigationPayload = {
          runId: runId ?? undefined,
          officialUrl,
          brandFingerprint,
          candidates,
          sellerProfiles,
        };

        const response = await fetch("/api/case", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            selectedCandidateIds,
            investigation,
          }),
        });

        if (!response.ok) {
          throw new Error("Unable to build the seller case.");
        }

        const dossier = (await response.json()) as CaseDossier;
        setCaseDossier(dossier);
        pushActivity(
          setActivity,
          `Seller case built around ${dossier.primarySeller?.sellerName ?? "the selected listings"}.`,
          "success",
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to build the seller case.";
        setLastError(message);
        pushActivity(setActivity, message, "risk");
      }
    });
  }

  function handleGenerateReports() {
    if (!caseDossier) {
      return;
    }

    startReportTransition(async () => {
      try {
        const response = await fetch("/api/report", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            caseDossier,
          }),
        });

        if (!response.ok) {
          throw new Error("Unable to generate the report pack.");
        }

        const payload = (await response.json()) as ReportResponse;
        setReports(payload);
        pushActivity(setActivity, "Marketplace and authority packets are ready.", "success");
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to generate the report pack.";
        setLastError(message);
        pushActivity(setActivity, message, "risk");
      }
    });
  }

  function exportJson() {
    const payload = {
      officialUrl,
      brandFingerprint,
      candidates: sortedCandidates,
      caseDossier,
      reports,
    };
    downloadFile(
      "tiny-detective-export.json",
      JSON.stringify(payload, null, 2),
      "application/json",
    );
  }

  function exportMarkdown() {
    const markdown = buildMarkdownExport({
      officialUrl,
      brandFingerprint,
      candidates: sortedCandidates,
      dossier: caseDossier,
      reports,
    });
    downloadFile("tiny-detective-export.md", markdown, "text/markdown");
  }

  return (
    <main className="min-h-screen px-4 py-4 text-[var(--ink)] sm:px-6 lg:px-8">
      <div
        className="mx-auto flex w-full max-w-[1600px] flex-col gap-5"
      >
        <section
          className="overflow-hidden rounded-[32px] border border-[color:var(--border-strong)] bg-[rgba(251,248,243,0.88)] shadow-[var(--shadow)] backdrop-blur"
        >
          <div className="grid gap-0 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6 p-6 sm:p-8">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge label={statusLabel(status)} tone={statusTone(status)} />
                <StatusBadge
                  label={readinessBadge.label}
                  tone={readinessBadge.tone}
                />
                <span className="rounded-full border border-[color:var(--border)] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-[rgba(22,19,18,0.58)]">
                  Vietnam brand protection
                </span>
              </div>

              <div className="space-y-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.38em] text-[var(--live)]">
                  TinyFish-powered investigation workspace
                </p>
                <div className="max-w-4xl space-y-3">
                  <h1 className="font-serif text-4xl leading-[1.05] text-[var(--ink)] sm:text-5xl lg:text-6xl">
                    Find counterfeit listings, link seller patterns, and package a case that
                    authorities can actually use.
                  </h1>
                  <p className="max-w-3xl text-sm leading-7 text-[rgba(22,19,18,0.72)] sm:text-base">
                    Tiny Detective keeps the workflow deliberately simple: one official listing URL
                    in, ranked counterfeit risk out, seller evidence built up, and two report
                    packets exported without leaving the same workspace.
                  </p>
                </div>
              </div>

              <form className="space-y-3" onSubmit={handleInvestigate}>
                <label className="block text-sm font-medium text-[rgba(22,19,18,0.82)]">
                  Official product listing
                </label>
                <div className="flex flex-col gap-3 rounded-[28px] border border-[color:var(--border-strong)] bg-[rgba(255,255,255,0.72)] p-3 shadow-[0_10px_40px_rgba(15,21,22,0.06)] sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[22px] border border-[rgba(22,19,18,0.08)] bg-[var(--panel)] px-4 py-3">
                    <Search className="size-4 shrink-0 text-[var(--live)]" />
                    <input
                      value={officialUrl}
                      onChange={(inputEvent) => setOfficialUrl(inputEvent.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[rgba(22,19,18,0.4)]"
                      placeholder="https://brand.com/product/classic-clog"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={status === "running"}
                    className="inline-flex items-center justify-center gap-2 rounded-[22px] bg-[var(--ink)] px-5 py-3 text-sm font-semibold text-[var(--panel)] transition hover:translate-y-[-1px] hover:bg-[rgba(22,19,18,0.92)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {status === "running" ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        Investigating
                      </>
                    ) : (
                      <>
                        <Radar className="size-4" />
                        Start investigation
                      </>
                    )}
                  </button>
                </div>
              </form>

              <div className="grid gap-3 md:grid-cols-3">
                {demoBullets.map((bullet) => (
                  <div
                    key={bullet}
                    className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.44)] p-4 text-sm leading-6 text-[rgba(22,19,18,0.72)]"
                  >
                    {bullet}
                  </div>
                ))}
              </div>
            </div>

            <div className="relative overflow-hidden border-t border-[color:var(--border)] bg-[var(--rail)] p-6 text-[rgba(245,241,232,0.9)] lg:border-t-0 lg:border-l">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(25,140,138,0.22),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(198,93,58,0.18),transparent_28%)]" />
              <div className="relative space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-[rgba(245,241,232,0.56)]">
                      Live browser wall
                    </p>
                    <h2 className="mt-2 font-serif text-3xl leading-tight text-[var(--panel)]">
                      Watch multiple probes at once, then drop back into the evidence.
                    </h2>
                  </div>
                  <div className="rounded-full border border-[rgba(245,241,232,0.14)] bg-[rgba(255,255,255,0.03)] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-[rgba(245,241,232,0.72)]">
                    {probeTotals.total > 0
                      ? `${probeTotals.completed}/${probeTotals.total} done`
                      : liveProbeCount > 0
                        ? `${liveProbeCount} live`
                        : "waiting"}
                  </div>
                </div>
                <p className="text-sm leading-6 text-[rgba(245,241,232,0.66)]">
                  The wall keeps the freshest five probe sessions pinned so you can see which
                  marketplace search is actually running, which ones opened a live browser, and
                  which ones finished or failed.
                </p>

                <div className="overflow-hidden rounded-[28px] border border-[rgba(245,241,232,0.12)] bg-[rgba(255,255,255,0.03)] shadow-[0_24px_60px_rgba(0,0,0,0.24)]">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(245,241,232,0.08)] px-4 py-3 text-[11px] uppercase tracking-[0.24em] text-[rgba(245,241,232,0.52)]">
                    <span>TinyFish probe wall</span>
                    <span>
                      {probePanels.length > 0
                        ? `${liveProbeCount} live · ${activeProbeCount} active`
                        : "preview unavailable"}
                    </span>
                  </div>
                  {probePanels.length > 0 ? (
                    <div className="grid gap-4 p-4 xl:grid-cols-2">
                      {probePanels.map((panel) => (
                        <article
                          key={panel.id}
                          className="overflow-hidden rounded-[24px] border border-[rgba(245,241,232,0.12)] bg-[rgba(255,255,255,0.03)]"
                        >
                            <div className="flex items-start justify-between gap-3 border-b border-[rgba(245,241,232,0.08)] px-4 py-3">
                              <div className="min-w-0">
                                <p className="font-mono text-[10px] uppercase tracking-[0.26em] text-[rgba(245,241,232,0.5)]">
                                  Probe
                                </p>
                              <h3 className="mt-1 truncate text-sm font-semibold text-[var(--panel)]">
                                {panel.label}
                              </h3>
                              </div>
                              <div className="flex items-center gap-2">
                                {panel.streamingUrl ? (
                                  <a
                                    href={panel.streamingUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 rounded-full border border-[rgba(245,241,232,0.12)] px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-[rgba(245,241,232,0.7)] transition hover:bg-[rgba(255,255,255,0.04)]"
                                  >
                                    Open stream
                                    <ArrowUpRight className="size-3" />
                                  </a>
                                ) : null}
                                <StatusBadge
                                  label={panel.status}
                                  tone={probeStatusTone(panel.status)}
                                />
                              </div>
                          </div>

                          <div className="relative border-b border-[rgba(245,241,232,0.08)]">
                            {panel.streamingUrl ? (
                              <iframe
                                src={panel.streamingUrl}
                                title={`${panel.label} live browser stream`}
                                className="h-[240px] w-full bg-[rgba(0,0,0,0.18)]"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="flex h-[240px] flex-col items-center justify-center gap-3 px-6 text-center">
                                <motion.div
                                  animate={{ rotate: 360 }}
                                  transition={{
                                    repeat: Number.POSITIVE_INFINITY,
                                    duration: 18,
                                    ease: "linear",
                                  }}
                                  className="flex size-16 items-center justify-center rounded-full border border-dashed border-[rgba(245,241,232,0.18)]"
                                >
                                  <Eye className="size-6 text-[var(--live)]" />
                                </motion.div>
                                <div className="max-w-[240px] space-y-1">
                                  <p className="text-sm font-medium text-[var(--panel)]">
                                    Waiting for a stream URL.
                                  </p>
                                  <p className="text-xs leading-5 text-[rgba(245,241,232,0.68)]">
                                    This probe is still emitting activity, so the card stays visible
                                    while the browser session spins up.
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="space-y-2 px-4 py-3">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[rgba(245,241,232,0.46)]">
                                Recent activity
                              </p>
                              <p className="text-[10px] uppercase tracking-[0.2em] text-[rgba(245,241,232,0.34)]">
                                {formatTimestamp(panel.updatedAt)}
                              </p>
                            </div>
                            {panel.activity.length > 0 ? (
                              <ul className="space-y-2">
                                {panel.activity.map((entry) => (
                                  <li
                                    key={entry.id}
                                    className="flex gap-2 text-xs leading-5 text-[rgba(245,241,232,0.76)]"
                                  >
                                    <span
                                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${toneDot(entry.tone)}`}
                                    />
                                    <span>{entry.label}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p className="text-xs leading-5 text-[rgba(245,241,232,0.58)]">
                                No probe-specific activity yet.
                              </p>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="flex h-[360px] flex-col items-center justify-center gap-4 px-6 text-center">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Number.POSITIVE_INFINITY, duration: 18, ease: "linear" }}
                        className="flex size-24 items-center justify-center rounded-full border border-dashed border-[rgba(245,241,232,0.18)]"
                      >
                        <Eye className="size-8 text-[var(--live)]" />
                      </motion.div>
                      <div className="max-w-xs space-y-2">
                        <p className="font-medium text-[var(--panel)]">
                          Live previews appear as probes report their own stream URLs.
                        </p>
                        <p className="text-sm leading-6 text-[rgba(245,241,232,0.68)]">
                          In mock mode, the investigation still streams activity and ranked results so
                          the rest of the workflow remains testable.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <MetricCard
                    label="Candidates"
                    value={String(visibleCandidates.length).padStart(2, "0")}
                    detail={
                      officialBenchmark
                        ? "Suspicious leads after separating the benchmark listing."
                        : "Ranked by counterfeit and seller-fraud risk."
                    }
                  />
                  <MetricCard
                    label="Selected"
                    value={String(selectedCandidates.length).padStart(2, "0")}
                    detail="Listings added to the seller case so far."
                  />
                  <MetricCard
                    label="Highest risk"
                    value={`${visibleCandidates[0]?.counterfeitRisk ?? 0}`}
                    detail="Current top counterfeit score."
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
          <section
            className="space-y-5"
          >
            <Surface>
              <SectionHeader
                eyebrow="Official benchmark"
                title={
                  brandFingerprint ? brandFingerprint.brandName : "Seed the investigation"
                }
                description={
                  brandFingerprint
                    ? "The real product facts land first, then the workflow compares Lazada candidates against the cleanest benchmark it can find."
                    : "Paste one official product listing to infer the brand, reference price, and what the counterfeit search should care about."
                }
              />
              {brandFingerprint ? (
                <div className="space-y-4">
                  <div className="rounded-[28px] border border-[rgba(25,140,138,0.22)] bg-[linear-gradient(180deg,rgba(25,140,138,0.08),rgba(255,255,255,0.68))] p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[rgba(22,19,18,0.5)]">
                          {officialBenchmark ? "Marketplace benchmark" : "Official product"}
                        </p>
                        <h3 className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                          {officialBenchmark
                            ? officialBenchmark.title
                            : `${brandFingerprint.brandName} ${brandFingerprint.productName}`}
                        </h3>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-[rgba(22,19,18,0.72)]">
                          {officialBenchmark
                            ? `Sold by ${officialBenchmark.sellerName} on ${officialBenchmark.marketplace}. This is the cleanest local price anchor, so nearby Lazada results can be judged against it instead of a mismatched currency reference.`
                            : "TinyFish extracted the official product facts from the supplied brand page. Once a trustworthy marketplace benchmark appears, the suspicious list uses that as the local comparison anchor."}
                        </p>
                      </div>
                      <StatusBadge
                        label={officialBenchmark ? "benchmark" : "official facts"}
                        tone="live"
                      />
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <PacketMetric
                        label="Reference price"
                        value={formatCurrency(
                          officialBenchmark?.price ?? brandFingerprint.referencePrice,
                          officialBenchmark?.currency ?? brandFingerprint.currency,
                        )}
                      />
                      <PacketMetric
                        label={officialBenchmark ? "Benchmark seller" : "Authorized channel"}
                        value={
                          officialBenchmark?.sellerName ??
                          brandFingerprint.authorizedChannels[0] ??
                          "Official store"
                        }
                      />
                      <PacketMetric
                        label={officialBenchmark ? "Link type" : "Official source"}
                        value={officialBenchmark ? "Direct listing" : "Brand website"}
                      />
                    </div>
                    {officialBenchmark ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        {officialBenchmark.signalTags.map((signal) => (
                          <span
                            key={signal}
                            className="rounded-full border border-[rgba(25,140,138,0.22)] bg-[rgba(255,255,255,0.56)] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-[rgba(22,19,18,0.6)]"
                          >
                            {signal.replace(/_/g, " ")}
                          </span>
                        ))}
                        <a
                          href={officialBenchmark.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-2 rounded-full border border-[rgba(25,140,138,0.24)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition hover:bg-[rgba(255,255,255,0.5)]"
                        >
                          Open benchmark listing
                          <ArrowUpRight className="size-4" />
                        </a>
                      </div>
                    ) : null}
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <DataPanel label="Brand cues" items={brandFingerprint.claims} />
                    <DataPanel
                      label="Visual motifs"
                      items={brandFingerprint.visualMotifs}
                      accent="warning"
                    />
                  </div>
                  <div className="grid gap-3 md:grid-cols-3">
                    <StatTile
                      label="Reference price"
                      value={formatCurrency(brandFingerprint.referencePrice, brandFingerprint.currency)}
                    />
                    <StatTile label="Authorized domains" value={String(brandFingerprint.authorizedDomains.length)} />
                    <StatTile label="Known products" value={String(brandFingerprint.knownProducts.length)} />
                  </div>
                </div>
              ) : (
                <EmptyState
                  icon={<Sparkles className="size-5" />}
                  title="No fingerprint yet"
                  description="The left side becomes your case file as soon as the investigation starts streaming."
                />
              )}
            </Surface>

            <Surface>
              <SectionHeader
                eyebrow="Ranked candidates"
                title="Counterfeit and seller-fraud leads"
                description={
                  officialBenchmark
                    ? "The official benchmark is parked above, so this list stays focused on suspicious marketplace leads."
                    : "Every card makes the evidence visible instead of hiding it behind opaque scores."
                }
              />
              <div className="space-y-3">
                {visibleCandidates.length === 0 ? (
                  <EmptyState
                    icon={<ShieldAlert className="size-5" />}
                    title="No suspicious listings yet"
                    description="Run an investigation to populate this panel with ranked listing candidates."
                  />
                ) : (
                  visibleCandidates.map((candidate, index) => {
                    const isSelected = selectedCandidateIds.includes(candidate.id);
                    const isFeaturedCounterfeit =
                      candidate.id === featuredCounterfeitCandidate?.id &&
                      candidate.counterfeitRisk >= 80;
                    const candidateCallout = describeCandidateCallout(
                      candidate,
                      brandFingerprint,
                      officialBenchmark,
                    );
                    return (
                      <motion.article
                        key={candidate.id}
                        layout
                        className={`rounded-[28px] border p-4 transition ${
                          isFeaturedCounterfeit
                            ? "border-[rgba(198,93,58,0.38)] bg-[linear-gradient(180deg,rgba(198,93,58,0.12),rgba(255,255,255,0.66))] shadow-[0_18px_48px_rgba(198,93,58,0.14)]"
                            : candidateCallout.tone === "warning"
                              ? "border-[rgba(184,137,45,0.32)] bg-[rgba(184,137,45,0.08)]"
                              : isSelected
                                ? "border-[rgba(25,140,138,0.28)] bg-[rgba(25,140,138,0.08)]"
                            : "border-[color:var(--border)] bg-[rgba(255,255,255,0.5)]"
                        }`}
                      >
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-[rgba(22,19,18,0.06)] px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-[rgba(22,19,18,0.6)]">
                                Lead {index + 1}
                              </span>
                              <StatusBadge label={candidate.marketplace} tone="neutral" />
                              <StatusBadge
                                label={isFeaturedCounterfeit ? "Obvious counterfeit" : candidateCallout.label}
                                tone={isFeaturedCounterfeit ? "risk" : candidateCallout.tone}
                              />
                              <StatusBadge label={`Match ${formatPercent(candidate.confidence)}`} tone="live" />
                            </div>
                              <div className="space-y-2">
                                <h3 className="text-lg font-semibold leading-7 text-[var(--ink)]">
                                  {candidate.title}
                                </h3>
                                <p className="max-w-3xl text-sm leading-6 text-[rgba(22,19,18,0.68)]">
                                  Sold by {candidate.sellerName} at{" "}
                                  {formatCurrency(candidate.price, candidate.currency)}
                                  {brandFingerprint
                                    ? `, ${describeCandidatePriceGap(
                                        candidate,
                                        brandFingerprint,
                                        officialBenchmark,
                                      )}`
                                    : ""}
                                </p>
                              </div>
                            <div className="grid gap-3 sm:grid-cols-3">
                              <StatTile
                                label="Counterfeit risk"
                                value={`${candidate.counterfeitRisk}`}
                              />
                              <StatTile
                                label="Seller fraud risk"
                                value={`${candidate.sellerFraudRisk}`}
                              />
                              <StatTile label="Confidence" value={formatPercent(candidate.confidence)} />
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {candidate.signalTags.map((signal) => (
                                <span
                                  key={signal}
                                  className="rounded-full border border-[color:var(--border)] px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-[rgba(22,19,18,0.58)]"
                                >
                                  {signal.replace(/_/g, " ")}
                                </span>
                              ))}
                            </div>
                            <ul className="space-y-2 text-sm leading-6 text-[rgba(22,19,18,0.76)]">
                              {candidate.reasoning.map((reason) => (
                                <li key={reason} className="flex gap-2">
                                  <span
                                    className={`mt-[10px] size-1.5 shrink-0 rounded-full ${
                                      candidateCallout.tone === "risk"
                                        ? "bg-[var(--risk)]"
                                        : candidateCallout.tone === "warning"
                                          ? "bg-[var(--warning)]"
                                          : "bg-[var(--live)]"
                                    }`}
                                  />
                                  <span>{capitalize(reason)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="flex w-full flex-col gap-3 lg:w-[248px]">
                            <RiskMeter
                              label="Counterfeit risk"
                              score={candidate.counterfeitRisk}
                              accent="risk"
                            />
                            <RiskMeter
                              label="Seller fraud risk"
                              score={candidate.sellerFraudRisk}
                              accent="warning"
                            />
                            <ListingLinkButton
                              candidate={candidate}
                              brandFingerprint={brandFingerprint}
                            />
                            <button
                              type="button"
                              onClick={() => toggleCandidate(candidate.id)}
                              className={`inline-flex items-center justify-center rounded-[18px] px-3 py-2 text-sm font-semibold transition ${
                                isSelected
                                  ? "bg-[var(--ink)] text-[var(--panel)]"
                                  : "bg-[var(--live)] text-[var(--panel)]"
                              }`}
                            >
                              {isSelected ? "Selected for packet" : "Add to case"}
                            </button>
                          </div>
                        </div>
                        {isFeaturedCounterfeit ? (
                          <div className="mt-4 rounded-[22px] border border-[rgba(198,93,58,0.18)] bg-[rgba(198,93,58,0.08)] px-4 py-3 text-sm leading-6 text-[rgba(22,19,18,0.78)]">
                            This is the strongest counterfeit-looking lead in the set, so it stays
                            visually showcased for quick review and packet selection.
                          </div>
                        ) : null}
                      </motion.article>
                    );
                  })
                )}
              </div>
              </Surface>

              <Surface>
                <SectionHeader
                  eyebrow="Seller case"
                  title="Package the highest-priority listings into one dossier"
                  description="Use the selected candidates to pivot from isolated listings to the seller pattern behind them."
                />

                <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
                  <div className="space-y-3">
                    <div className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.5)] p-4">
                      <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[rgba(22,19,18,0.52)]">
                        Selection
                      </p>
                      <div className="mt-3 space-y-2">
                        {selectedCandidates.length === 0 ? (
                          <p className="text-sm leading-6 text-[rgba(22,19,18,0.68)]">
                            Pick one or more candidates above to build the seller case.
                          </p>
                        ) : (
                          selectedCandidates.map((candidate) => (
                            <div
                              key={candidate.id}
                              className="rounded-[20px] border border-[rgba(25,140,138,0.18)] bg-[rgba(25,140,138,0.06)] px-3 py-2"
                            >
                              <p className="text-sm font-medium text-[var(--ink)]">{candidate.title}</p>
                              <p className="text-xs text-[rgba(22,19,18,0.58)]">{candidate.sellerName}</p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={!brandFingerprint || selectedCandidates.length === 0 || isBuildingCase}
                      onClick={handleBuildCase}
                      className="inline-flex w-full items-center justify-center gap-2 rounded-[20px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-[var(--panel)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isBuildingCase ? (
                        <>
                          <LoaderCircle className="size-4 animate-spin" />
                          Building dossier
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="size-4" />
                          Build seller case
                        </>
                      )}
                    </button>
                  </div>

                  <div className="rounded-[28px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.42)] p-4">
                    {caseDossier ? (
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                              Primary seller
                            </p>
                            <h3 className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                              {caseDossier.primarySeller?.sellerName ?? "Case cluster"}
                            </h3>
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <CompactMetric
                              label="Counterfeit"
                              value={String(caseDossier.riskSummary.counterfeitRisk)}
                            />
                            <CompactMetric
                              label="Fraud"
                              value={String(caseDossier.riskSummary.sellerFraudRisk)}
                            />
                            <CompactMetric
                              label="Confidence"
                              value={formatPercent(caseDossier.riskSummary.confidence)}
                            />
                          </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-2">
                          <DataPanel label="Findings" items={caseDossier.findings} />
                          <DataPanel
                            label="Recommended actions"
                            items={caseDossier.recommendedActions}
                            accent="live"
                          />
                        </div>
                      </div>
                    ) : (
                      <EmptyState
                        icon={<FileText className="size-5" />}
                        title="No dossier yet"
                        description="Once you build the seller case, this panel becomes the bridge between raw leads and exportable reporting."
                      />
                    )}
                  </div>
                </div>
              </Surface>

              <Surface>
                <SectionHeader
                  eyebrow="Report packets"
                  title="Generate marketplace and authority-ready outputs"
                  description="The same case file can serve a takedown workflow and a seller-centric escalation path."
                />

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleGenerateReports}
                    disabled={!caseDossier || isBuildingReport}
                    className="inline-flex items-center justify-center gap-2 rounded-[20px] bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-[var(--panel)] transition hover:translate-y-[-1px] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBuildingReport ? (
                      <>
                        <LoaderCircle className="size-4 animate-spin" />
                        Writing packets
                      </>
                    ) : (
                      <>
                        <Sparkles className="size-4" />
                        Generate reports
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={exportMarkdown}
                    disabled={!caseDossier}
                    className="inline-flex items-center justify-center gap-2 rounded-[20px] border border-[color:var(--border)] px-4 py-3 text-sm font-medium text-[var(--ink)] transition hover:bg-[rgba(22,19,18,0.04)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Download className="size-4" />
                    Export Markdown
                  </button>
                  <button
                    type="button"
                    onClick={exportJson}
                    disabled={!caseDossier}
                    className="inline-flex items-center justify-center gap-2 rounded-[20px] border border-[color:var(--border)] px-4 py-3 text-sm font-medium text-[var(--ink)] transition hover:bg-[rgba(22,19,18,0.04)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Download className="size-4" />
                    Export JSON
                  </button>
                </div>

                {reports ? (
                  <div className="mt-5 overflow-hidden rounded-[30px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.5)]">
                    <div className="flex flex-wrap items-center gap-2 border-b border-[color:var(--border)] px-4 py-4">
                      <TabButton
                        isActive={activeReportTab === "marketplace"}
                        onClick={() => setActiveReportTab("marketplace")}
                        label="Marketplace packet"
                      />
                      <TabButton
                        isActive={activeReportTab === "authority"}
                        onClick={() => setActiveReportTab("authority")}
                        label="Authority packet"
                      />
                      <div className="ml-auto rounded-full border border-[color:var(--border)] px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.52)]">
                        {activePacket?.caseId}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 border-b border-[color:var(--border)] px-4 py-3 text-[11px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.54)]">
                      <span className="rounded-full border border-[color:var(--border)] px-3 py-1">
                        1. Summary
                      </span>
                      <span className="rounded-full border border-[color:var(--border)] px-3 py-1">
                        2. Evidence
                      </span>
                      <span className="rounded-full border border-[color:var(--border)] px-3 py-1">
                        3. Targets
                      </span>
                    </div>
                    <div className="space-y-5 p-5">
                      <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
                        <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                          <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                            Key summary
                          </p>
                          <h3 className="mt-3 text-2xl font-semibold text-[var(--ink)]">
                            {activePacket?.subject}
                          </h3>
                          <p className="mt-2 text-sm leading-6 text-[rgba(22,19,18,0.68)]">
                            {activePacket?.summary}
                          </p>
                          <div className="mt-5 grid gap-3 sm:grid-cols-3">
                            <PacketMetric
                              label="Packet type"
                              value={activeReportTab === "marketplace" ? "Marketplace" : "Authority"}
                            />
                            <PacketMetric
                              label="Evidence items"
                              value={String(activePacket?.evidence.length ?? 0)}
                            />
                            <PacketMetric
                              label="Priority items"
                              value={
                                activeReportTab === "marketplace"
                                  ? String(reports.marketplacePacket.prioritizedListings.length)
                                  : String(prioritizedSellerProfiles.length)
                              }
                            />
                          </div>
                        </article>

                        <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                          <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                            Evidence
                          </p>
                          <div className="mt-3 space-y-3">
                            {(activePacket?.evidence ?? []).map((item, itemIndex) => (
                              <div
                                key={`${item}-${itemIndex}`}
                                className="rounded-[18px] border border-[rgba(22,19,18,0.08)] bg-[rgba(255,255,255,0.58)] px-3 py-3"
                              >
                                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[rgba(22,19,18,0.44)]">
                                  Evidence {String(itemIndex + 1).padStart(2, "0")}
                                </p>
                                <p className="mt-1 text-sm leading-6 text-[rgba(22,19,18,0.78)]">
                                  {capitalize(item)}
                                </p>
                              </div>
                            ))}
                          </div>
                        </article>
                      </div>

                      {activeReportTab === "marketplace" ? (
                        <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
                          <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                            <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                              Prioritized listings
                            </p>
                            <div className="mt-4 space-y-3">
                              {reports.marketplacePacket.prioritizedListings.map((listing, listingIndex) => {
                                const candidate = sortedCandidates.find(
                                  (entry) => entry.id === listing.candidateId,
                                );
                                return (
                                  <div
                                    key={listing.candidateId}
                                    className="rounded-[22px] border border-[rgba(22,19,18,0.08)] bg-[rgba(255,255,255,0.58)] p-4"
                                  >
                                    <div className="flex items-start justify-between gap-3">
                                      <div className="min-w-0">
                                        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.44)]">
                                          Target {String(listingIndex + 1).padStart(2, "0")}
                                        </p>
                                        <h4 className="mt-2 text-base font-semibold leading-6 text-[var(--ink)]">
                                          {listing.title}
                                        </h4>
                                        <p className="mt-1 text-sm leading-6 text-[rgba(22,19,18,0.68)]">
                                          {listing.marketplace} · {listing.sellerName}
                                        </p>
                                      </div>
                                      <StatusBadge
                                        label={`Risk ${Math.max(
                                          listing.counterfeitRisk,
                                          listing.sellerFraudRisk,
                                        )}`}
                                        tone={listing.counterfeitRisk >= 75 ? "risk" : "warning"}
                                      />
                                    </div>
                                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                                      <PacketMetric
                                        label="Counterfeit"
                                        value={`${listing.counterfeitRisk}`}
                                      />
                                      <PacketMetric
                                        label="Fraud"
                                        value={`${listing.sellerFraudRisk}`}
                                      />
                                      <PacketMetric
                                        label="Link type"
                                        value={
                                          getLinkMeta(candidate?.source ?? "mock", listing.url).label
                                        }
                                      />
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                      <a
                                        href={listing.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition hover:bg-[rgba(22,19,18,0.04)]"
                                      >
                                        {getLinkMeta(candidate?.source ?? "mock", listing.url).label}
                                        <ArrowUpRight className="size-4" />
                                      </a>
                                      {candidate?.source === "mock" ? (
                                        <span className="text-xs leading-5 text-[rgba(22,19,18,0.56)]">
                                          Synthetic mock evidence, not a direct live listing.
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </article>

                          <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                            <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                              Takedown targets
                            </p>
                            <div className="mt-4 space-y-3">
                              {reports.marketplacePacket.takedownTargets.map((target, targetIndex) => {
                                const candidate = sortedCandidates.find((entry) => entry.url === target);
                                return (
                                  <div
                                    key={target}
                                    className="rounded-[22px] border border-[rgba(22,19,18,0.08)] bg-[rgba(255,255,255,0.58)] p-4"
                                  >
                                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.44)]">
                                      Target {String(targetIndex + 1).padStart(2, "0")}
                                    </p>
                                    <p className="mt-2 text-sm font-semibold text-[var(--ink)]">
                                      {candidate?.title ?? "Target listing"}
                                    </p>
                                    <p className="mt-1 text-sm leading-6 text-[rgba(22,19,18,0.68)]">
                                      {candidate?.sellerName ?? "Seller"} ·{" "}
                                      {getLinkMeta(candidate?.source ?? "mock", target).label}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          </article>
                        </div>
                      ) : (
                        <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
                          <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                            <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                              Allegations
                            </p>
                            <div className="mt-4 space-y-3">
                              {reports.authorityPacket.allegations.map((item, itemIndex) => (
                                <div
                                  key={item}
                                  className="rounded-[22px] border border-[rgba(198,93,58,0.14)] bg-[rgba(198,93,58,0.06)] p-4"
                                >
                                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[rgba(198,93,58,0.7)]">
                                    Allegation {String(itemIndex + 1).padStart(2, "0")}
                                  </p>
                                  <p className="mt-2 text-sm leading-6 text-[rgba(22,19,18,0.78)]">
                                    {item}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </article>

                          <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                            <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                              Requests and priority sellers
                            </p>
                            <div className="mt-4 space-y-4">
                              <div className="space-y-3">
                                {reports.authorityPacket.requestedActions.map((item, itemIndex) => (
                                  <div
                                    key={item}
                                    className="rounded-[22px] border border-[rgba(25,140,138,0.14)] bg-[rgba(25,140,138,0.06)] p-4"
                                  >
                                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[rgba(25,140,138,0.7)]">
                                      Request {String(itemIndex + 1).padStart(2, "0")}
                                    </p>
                                    <p className="mt-2 text-sm leading-6 text-[rgba(22,19,18,0.78)]">
                                      {item}
                                    </p>
                                  </div>
                                ))}
                              </div>

                              <div className="space-y-3 rounded-[22px] border border-[rgba(22,19,18,0.08)] bg-[rgba(255,255,255,0.58)] p-4">
                                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.44)]">
                                  Priority sellers
                                </p>
                                {prioritizedSellerProfiles.length === 0 ? (
                                  <p className="text-sm leading-6 text-[rgba(22,19,18,0.68)]">
                                    Seller priorities will appear once the case includes listings.
                                  </p>
                                ) : (
                                  prioritizedSellerProfiles.slice(0, 3).map((seller, sellerIndex) => (
                                    <div
                                      key={seller.id}
                                      className="flex items-start justify-between gap-3 rounded-[18px] border border-[rgba(22,19,18,0.06)] bg-[rgba(255,255,255,0.72)] px-3 py-3"
                                    >
                                      <div>
                                        <p className="text-sm font-semibold text-[var(--ink)]">
                                          {seller.sellerName}
                                        </p>
                                        <p className="mt-1 text-xs leading-5 text-[rgba(22,19,18,0.58)]">
                                          {seller.marketplace} · {seller.location}
                                        </p>
                                      </div>
                                      <StatusBadge
                                        label={`#${sellerIndex + 1}`}
                                        tone={seller.sellerFraudRisk >= 70 ? "risk" : "warning"}
                                      />
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          </article>
                        </div>
                      )}

                      <article className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-5">
                        <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[rgba(22,19,18,0.52)]">
                          Narrative
                        </p>
                        <div className="prose prose-sm mt-3 max-w-none prose-headings:font-serif prose-p:text-[rgba(22,19,18,0.8)] prose-p:leading-7">
                          <ReactMarkdown>{activePacket?.narrative ?? ""}</ReactMarkdown>
                        </div>
                      </article>
                    </div>
                  </div>
                ) : (
                  <div className="mt-5">
                    <EmptyState
                      icon={<ShieldCheck className="size-5" />}
                      title="Reports not generated yet"
                      description="Generate the packets once the seller case looks right. The report tabs stay in this panel for quick export and review."
                    />
                  </div>
                )}
              </Surface>
            </section>

            <aside
              className="space-y-5 xl:sticky xl:top-4 xl:self-start"
            >
              <Surface dark>
                <div className="flex items-center justify-between gap-3">
                  <SectionHeader
                    eyebrow="Process detail"
                    title="Activity timeline"
                    description="Visible when you need it, collapsible when you want to stay in the report."
                    invert
                  />
                  <button
                    type="button"
                    onClick={() => setActivityOpen((open) => !open)}
                    className="inline-flex items-center gap-2 rounded-full border border-[rgba(245,241,232,0.14)] px-3 py-1 text-[11px] uppercase tracking-[0.24em] text-[rgba(245,241,232,0.68)] transition hover:bg-[rgba(255,255,255,0.04)]"
                  >
                    {activityOpen ? "Collapse" : "Expand"}
                    <ChevronDown className={`size-4 transition ${activityOpen ? "" : "-rotate-90"}`} />
                  </button>
                </div>

                <AnimatePresence initial={false}>
                  {activityOpen ? (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-4 space-y-3">
                        {activity.length === 0 ? (
                          <DarkEmptyState text="Run an investigation to populate the activity trail." />
                        ) : (
                          activity.map((entry, index) => (
                            <div key={entry.id} className="flex gap-3">
                              <div className="flex flex-col items-center">
                                <span className={`mt-1 size-2.5 rounded-full ${toneDot(entry.tone)}`} />
                                {index < activity.length - 1 ? (
                                  <span className="mt-2 h-full w-px bg-[rgba(245,241,232,0.12)]" />
                                ) : null}
                              </div>
                              <div className="pb-4">
                                <p className="text-sm leading-6 text-[rgba(245,241,232,0.9)]">
                                  {entry.label}
                                </p>
                                <p className="mt-1 text-[11px] uppercase tracking-[0.22em] text-[rgba(245,241,232,0.46)]">
                                  {formatTimestamp(entry.timestamp)}
                                </p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </Surface>

              <Surface dark>
                <SectionHeader
                  eyebrow="Evidence stack"
                  title="What pushed the model toward risk"
                  description="These are the concrete snippets and seller signals the analyst can cite."
                  invert
                />
                <div className="mt-4 space-y-3">
                  {evidenceFeed.length === 0 ? (
                    <DarkEmptyState text="Evidence cards will populate after the first candidates arrive." />
                  ) : (
                    evidenceFeed.map((evidence, index) => (
                      <div
                        key={`${evidence}-${index}`}
                        className="rounded-[22px] border border-[rgba(245,241,232,0.1)] bg-[rgba(255,255,255,0.04)] p-4"
                      >
                        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[rgba(245,241,232,0.46)]">
                          Evidence {String(index + 1).padStart(2, "0")}
                        </p>
                        <p className="mt-3 text-sm leading-6 text-[rgba(245,241,232,0.88)]">
                          {capitalize(evidence)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </Surface>

              <Surface>
                <SectionHeader
                  eyebrow="Quick export checks"
                  title="What this v1 already packages"
                  description="The clone stays intentionally thin: TinyFish for browser work, deterministic scoring plus optional OpenAI reasoning for the final narrative."
                />
                <ul className="mt-4 space-y-3 text-sm leading-6 text-[rgba(22,19,18,0.74)]">
                  <li className="flex gap-3">
                    <span className="mt-1 size-2 rounded-full bg-[var(--live)]" />
                    Marketplace packet with prioritized listings, seller names, URLs, and evidence.
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1 size-2 rounded-full bg-[var(--warning)]" />
                    Authority packet with seller-pattern framing and requested next actions.
                  </li>
                  <li className="flex gap-3">
                    <span className="mt-1 size-2 rounded-full bg-[var(--risk)]" />
                    Graceful mock fallback when `TINYFISH_API_KEY` or `OPENAI_API_KEY` are missing.
                  </li>
                </ul>
              </Surface>

              {lastError ? (
                <Surface>
                  <div className="flex items-start gap-3 rounded-[24px] border border-[rgba(198,93,58,0.18)] bg-[rgba(198,93,58,0.08)] p-4">
                    <AlertTriangle className="mt-1 size-5 shrink-0 text-[var(--risk)]" />
                    <div>
                      <p className="font-semibold text-[var(--ink)]">Last issue</p>
                      <p className="mt-1 text-sm leading-6 text-[rgba(22,19,18,0.72)]">{lastError}</p>
                    </div>
                  </div>
                </Surface>
              ) : null}
            </aside>
          </div>
        </div>
    </main>
  );
}

function getLinkMeta(
  source: ListingCandidate["source"],
  url: string,
) {
  const mode = classifyLink(url);
  if (source === "mock") {
    return {
      label: mode === "search" ? "Open mock search" : "Open mock evidence",
      note: "Synthetic mock URL, not a live listing.",
    };
  }

  if (mode === "search") {
    return {
      label: "Open marketplace search",
      note: "Search results, not a direct product listing.",
    };
  }

  return {
    label: "Open listing",
    note: "Direct product listing.",
  };
}

function classifyLink(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const search = `${parsed.search}${parsed.hash}`.toLowerCase();

    if (path.includes("/search") || path.includes("/results") || path.includes("/browse")) {
      return "search" as const;
    }

    if (/[?&](q|query|keyword|search)=/.test(search) || search.includes("search=")) {
      return "search" as const;
    }

    return "listing" as const;
  } catch {
    return "listing" as const;
  }
}

function findOfficialBenchmarkCandidate(
  candidates: ListingCandidate[],
  brandFingerprint: BrandFingerprint,
) {
  const brandToken = brandFingerprint.brandName.trim().toLowerCase();

  return candidates.find((candidate) => {
    if (classifyLink(candidate.url) !== "listing") {
      return false;
    }

    const seller = candidate.sellerName.toLowerCase();
    const title = candidate.title.toLowerCase();
    const tags = candidate.signalTags.join(" ").toLowerCase();
    const host = (() => {
      try {
        return new URL(candidate.url).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    const hasBrandSeller = seller.includes(brandToken);
    const hasAuthorizedDomain = brandFingerprint.authorizedDomains.some((domain) => {
      const normalized = domain.toLowerCase();
      return host === normalized || host.endsWith(`.${normalized}`);
    });
    const hasTrustedBadge = /lazmall|brand store|official_store|mall/.test(tags);
    const hasCounterfeitSignal = /h[àa]ng nguy[êe]n a|1:1|replica|copy|fake|super\s*fake/.test(
      `${title} ${tags}`,
    );
    const hasSuspiciousAuthenticityClaim =
      /(ch[íi]nh h[ãa]ng|authentic|genuine|original)/.test(`${title} ${tags}`) &&
      !hasAuthorizedDomain &&
      !hasBrandSeller;
    return (
      candidate.counterfeitRisk <= 28 &&
      candidate.sellerFraudRisk <= 35 &&
      (hasAuthorizedDomain || hasBrandSeller || (hasTrustedBadge && hasBrandSeller)) &&
      !hasCounterfeitSignal &&
      !hasSuspiciousAuthenticityClaim
    );
  });
}

function describeCandidateCallout(
  candidate: ListingCandidate,
  brandFingerprint: BrandFingerprint | null,
  officialBenchmark: ListingCandidate | null,
) {
  const tags = candidate.signalTags.join(" ").toLowerCase();
  const priceAnchor = getPriceAnchor(candidate, brandFingerprint, officialBenchmark);
  const priceDelta =
    priceAnchor && priceAnchor.value > 0
      ? (priceAnchor.value - candidate.price) / priceAnchor.value
      : 0;

  if (
    candidate.counterfeitRisk >= 80 ||
    /h[àa]ng nguy[êe]n a|replica|1:1|copy/.test(tags)
  ) {
    return { label: "Counterfeit example", tone: "risk" as const };
  }

  if (
    candidate.counterfeitRisk >= 60 ||
    priceDelta >= 0.3 ||
    /ch[íi]nh h[ãa]ng|authentic|genuine|original/.test(`${candidate.title} ${tags}`)
  ) {
    return { label: "Suspicious underpriced", tone: "warning" as const };
  }

  return { label: "Watchlist", tone: "neutral" as const };
}

function getPriceAnchor(
  candidate: ListingCandidate,
  brandFingerprint: BrandFingerprint | null,
  officialBenchmark: ListingCandidate | null,
) {
  if (
    officialBenchmark &&
    officialBenchmark.id !== candidate.id &&
    officialBenchmark.currency === candidate.currency
  ) {
    return {
      value: officialBenchmark.price,
      label: "benchmark",
    };
  }

  if (brandFingerprint && brandFingerprint.currency === candidate.currency) {
    return {
      value: brandFingerprint.referencePrice,
      label: "reference",
    };
  }

  return null;
}

function describeCandidatePriceGap(
  candidate: ListingCandidate,
  brandFingerprint: BrandFingerprint | null,
  officialBenchmark: ListingCandidate | null,
) {
  const anchor = getPriceAnchor(candidate, brandFingerprint, officialBenchmark);
  if (!anchor || anchor.value <= 0) {
    return "local benchmark still forming";
  }

  const delta = Math.round(((anchor.value - candidate.price) / anchor.value) * 100);
  if (delta > 0) {
    return `${delta}% below ${anchor.label}`;
  }
  if (delta < 0) {
    return `${Math.abs(delta)}% above ${anchor.label}`;
  }
  return `at the ${anchor.label} price`;
}

function ListingLinkButton({
  candidate,
  brandFingerprint,
}: {
  candidate: ListingCandidate;
  brandFingerprint: BrandFingerprint | null;
}) {
  const linkMeta = getLinkMeta(candidate.source, candidate.url);
  return (
    <div className="rounded-[18px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.46)]">
        Listing link
      </p>
      <a
        href={candidate.url}
        target="_blank"
        rel="noreferrer"
        title={linkMeta.note}
        aria-label={`${linkMeta.label}: ${candidate.title}`}
        className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[16px] border border-[color:var(--border)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition hover:bg-[rgba(22,19,18,0.04)]"
      >
        {linkMeta.label}
        <ArrowUpRight className="size-4" />
      </a>
      <p className="mt-2 text-xs leading-5 text-[rgba(22,19,18,0.58)]">
        {linkMeta.note}
        {brandFingerprint && candidate.source === "mock"
          ? ` Built against ${brandFingerprint.brandName}.`
          : ""}
      </p>
    </div>
  );
}

function PacketMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[18px] border border-[rgba(22,19,18,0.08)] bg-[rgba(255,255,255,0.58)] px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[rgba(22,19,18,0.46)]">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-[var(--ink)]">{value}</p>
    </div>
  );
}

function Surface({
  children,
  dark = false,
}: {
  children: React.ReactNode;
  dark?: boolean;
}) {
  return (
    <section
      className={`rounded-[30px] border p-5 shadow-[var(--shadow)] sm:p-6 ${
        dark
          ? "border-[rgba(245,241,232,0.1)] bg-[var(--rail)] text-[rgba(245,241,232,0.92)]"
          : "border-[color:var(--border-strong)] bg-[rgba(251,248,243,0.88)]"
      }`}
    >
      {children}
    </section>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
  invert = false,
}: {
  eyebrow: string;
  title: string;
  description: string;
  invert?: boolean;
}) {
  return (
    <div>
      <p
        className={`font-mono text-[11px] uppercase tracking-[0.28em] ${
          invert ? "text-[rgba(245,241,232,0.48)]" : "text-[rgba(22,19,18,0.46)]"
        }`}
      >
        {eyebrow}
      </p>
      <h2
        className={`mt-2 font-serif text-3xl leading-tight ${
          invert ? "text-[var(--panel)]" : "text-[var(--ink)]"
        }`}
      >
        {title}
      </h2>
      <p
        className={`mt-2 max-w-3xl text-sm leading-7 ${
          invert ? "text-[rgba(245,241,232,0.68)]" : "text-[rgba(22,19,18,0.68)]"
        }`}
      >
        {description}
      </p>
    </div>
  );
}

function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: "neutral" | "live" | "warning" | "risk" | "success";
}) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] ${toneBadge(
        tone,
      )}`}
    >
      {label}
    </span>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-[24px] border border-[rgba(245,241,232,0.1)] bg-[rgba(255,255,255,0.04)] p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-[rgba(245,241,232,0.46)]">
        {label}
      </p>
      <p className="mt-3 font-serif text-4xl text-[var(--panel)]">{value}</p>
      <p className="mt-2 text-sm leading-6 text-[rgba(245,241,232,0.66)]">{detail}</p>
    </div>
  );
}

function DataPanel({
  label,
  items,
  accent = "neutral",
}: {
  label: string;
  items: string[];
  accent?: "neutral" | "live" | "warning";
}) {
  return (
    <div className="rounded-[24px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-[rgba(22,19,18,0.52)]">
        {label}
      </p>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-3 text-sm leading-6 text-[rgba(22,19,18,0.76)]">
            <span className={`mt-2 size-2 shrink-0 rounded-full ${panelDot(accent)}`} />
            <span>{capitalize(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatTile({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[22px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[rgba(22,19,18,0.48)]">
        {label}
      </p>
      <p className="mt-3 text-2xl font-semibold text-[var(--ink)]">{value}</p>
    </div>
  );
}

function RiskMeter({
  label,
  score,
  accent,
}: {
  label: string;
  score: number;
  accent: "risk" | "warning";
}) {
  return (
    <div className="rounded-[20px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-[rgba(22,19,18,0.58)]">
          {label}
        </p>
        <span className="text-sm font-semibold text-[var(--ink)]">{score}/100</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-[rgba(22,19,18,0.08)]">
        <div
          className={`h-full rounded-full ${accent === "risk" ? "bg-[var(--risk)]" : "bg-[var(--warning)]"}`}
          style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
        />
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-[28px] border border-dashed border-[color:var(--border-strong)] bg-[rgba(255,255,255,0.35)] p-8 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[rgba(25,140,138,0.08)] text-[var(--live)]">
        {icon}
      </div>
      <h3 className="mt-4 text-lg font-semibold text-[var(--ink)]">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[rgba(22,19,18,0.68)]">
        {description}
      </p>
    </div>
  );
}

function DarkEmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-[22px] border border-dashed border-[rgba(245,241,232,0.14)] bg-[rgba(255,255,255,0.03)] p-4 text-sm leading-6 text-[rgba(245,241,232,0.64)]">
      {text}
    </div>
  );
}

function CompactMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-[18px] border border-[color:var(--border)] bg-[rgba(255,255,255,0.45)] px-3 py-2 text-center">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[rgba(22,19,18,0.48)]">
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold text-[var(--ink)]">{value}</p>
    </div>
  );
}

function TabButton({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-medium transition ${
        isActive
          ? "bg-[var(--ink)] text-[var(--panel)]"
          : "border border-[color:var(--border)] text-[rgba(22,19,18,0.68)] hover:bg-[rgba(22,19,18,0.04)]"
      }`}
    >
      {label}
    </button>
  );
}

function toneBadge(tone: "neutral" | "live" | "warning" | "risk" | "success") {
  switch (tone) {
    case "live":
      return "bg-[rgba(25,140,138,0.12)] text-[var(--live)]";
    case "warning":
      return "bg-[rgba(184,137,45,0.14)] text-[var(--warning)]";
    case "risk":
      return "bg-[rgba(198,93,58,0.14)] text-[var(--risk)]";
    case "success":
      return "bg-[rgba(34,139,94,0.12)] text-[rgb(34,139,94)]";
    default:
      return "bg-[rgba(22,19,18,0.06)] text-[rgba(22,19,18,0.62)]";
  }
}

function toneDot(tone: "neutral" | "live" | "warning" | "risk" | "success") {
  switch (tone) {
    case "live":
      return "bg-[var(--live)]";
    case "warning":
      return "bg-[var(--warning)]";
    case "risk":
      return "bg-[var(--risk)]";
    case "success":
      return "bg-[rgb(34,139,94)]";
    default:
      return "bg-[rgba(245,241,232,0.46)]";
  }
}

function panelDot(accent: "neutral" | "live" | "warning") {
  switch (accent) {
    case "live":
      return "bg-[var(--live)]";
    case "warning":
      return "bg-[var(--warning)]";
    default:
      return "bg-[rgba(22,19,18,0.42)]";
  }
}

function statusLabel(status: "idle" | "running" | "complete" | "error") {
  if (status === "running") {
    return "investigating";
  }
  if (status === "complete") {
    return "completed";
  }
  if (status === "error") {
    return "attention";
  }
  return "ready";
}

function statusTone(status: "idle" | "running" | "complete" | "error") {
  if (status === "running") {
    return "live" as const;
  }
  if (status === "complete") {
    return "success" as const;
  }
  if (status === "error") {
    return "risk" as const;
  }
  return "neutral" as const;
}

function probeStatusTone(status: ProbeStatus) {
  switch (status) {
    case "live":
      return "live" as const;
    case "working":
      return "warning" as const;
    case "complete":
      return "success" as const;
    case "error":
      return "risk" as const;
    default:
      return "neutral" as const;
  }
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatPercent(value: number) {
  const normalized = value <= 1 ? value * 100 : value;
  return `${Math.round(normalized)}%`;
}

function formatCurrency(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

function formatTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function pushActivity(
  setActivity: React.Dispatch<React.SetStateAction<ActivityItem[]>>,
  label: string,
  tone: ActivityItem["tone"],
) {
  setActivity((current) => [
    ...current,
    {
      id: crypto.randomUUID(),
      label,
      tone,
      timestamp: new Date().toISOString(),
    },
  ]);
}

function shouldTrackProbeEvent(streamEvent: InvestigationEvent) {
  return Boolean(streamEvent.probeLabel?.trim() || streamEvent.streamingUrl);
}

function syncProbePanels(current: ProbePanel[], streamEvent: InvestigationEvent) {
  const timestamp = streamEvent.timestamp ?? new Date().toISOString();
  const label = (streamEvent.probeLabel ?? "").trim() || fallbackProbeLabel(current, streamEvent);
  const normalizedLabel = label.toLowerCase();
  const existingIndex = current.findIndex((panel) => panel.label.toLowerCase() === normalizedLabel);
  const urlIndex =
    existingIndex === -1 && streamEvent.streamingUrl
      ? current.findIndex((panel) => panel.streamingUrl === streamEvent.streamingUrl)
      : -1;
  const panelIndex = existingIndex !== -1 ? existingIndex : urlIndex;
  const existingPanel = panelIndex !== -1 ? current[panelIndex] : null;
  const nextEntry = getProbeActivityEntry(streamEvent, timestamp);

  const nextPanel: ProbePanel = {
    id: existingPanel?.id ?? crypto.randomUUID(),
    label: existingPanel?.label && !streamEvent.probeLabel ? existingPanel.label : label,
    status: getProbeStatus(streamEvent, existingPanel?.status),
    streamingUrl: streamEvent.streamingUrl ?? existingPanel?.streamingUrl ?? null,
    activity: existingPanel?.activity ?? [],
    updatedAt: timestamp,
  };

  if (nextEntry) {
    nextPanel.activity = [nextEntry, ...nextPanel.activity].slice(0, 3);
  }

  const remaining = current.filter((_, index) => index !== panelIndex);
  return [nextPanel, ...remaining].slice(0, 5);
}

function fallbackProbeLabel(current: ProbePanel[], streamEvent: InvestigationEvent) {
  if (current[0]?.label) {
    return current[0].label;
  }

  if (streamEvent.streamingUrl) {
    return `Probe ${current.length + 1}`;
  }

  return "Probe";
}

function getProbeActivityEntry(streamEvent: InvestigationEvent, timestamp: string) {
  if (streamEvent.type === "heartbeat" && !streamEvent.message) {
    return null;
  }

  const message = streamEvent.message?.toLowerCase() ?? "";
  const label =
    streamEvent.message ??
    (streamEvent.type === "streaming_url"
      ? "Live browser stream attached."
      : streamEvent.type === "complete"
        ? "Probe completed."
        : streamEvent.type === "candidate_found"
          ? "New candidate evidence arrived."
          : streamEvent.type === "fingerprint"
            ? "Official fingerprint captured."
            : streamEvent.type === "started"
              ? "Probe started."
              : "Probe updated.");

  return {
    id: `${streamEvent.type}-${streamEvent.timestamp}-${streamEvent.probeLabel ?? "probe"}-${crypto.randomUUID()}`,
    label,
    tone:
      message.includes("failed") ||
      message.includes("cancelled") ||
      message.includes("timed out") ||
      message.includes("could not be queued")
        ? "risk"
        : streamEvent.type === "complete"
        ? "success"
        : streamEvent.type === "candidate_found" || streamEvent.type === "streaming_url"
          ? "live"
          : streamEvent.type === "fingerprint" ||
              streamEvent.type === "started" ||
              streamEvent.type === "progress"
            ? "warning"
            : "neutral",
    timestamp,
  } satisfies ActivityItem;
}

function getProbeStatus(streamEvent: InvestigationEvent, currentStatus: ProbeStatus | undefined) {
  const message = streamEvent.message?.toLowerCase() ?? "";

  if (streamEvent.type === "complete") {
    return "complete";
  }

  if (
    message.includes("failed") ||
    message.includes("cancelled") ||
    message.includes("timed out") ||
    message.includes("could not be queued")
  ) {
    return "error";
  }

  if (streamEvent.type === "candidate_found" || message.includes("completed without usable")) {
    return "complete";
  }

  if (streamEvent.type === "streaming_url") {
    return "live";
  }

  if (
    streamEvent.type === "progress" ||
    streamEvent.type === "started" ||
    streamEvent.type === "fingerprint"
  ) {
    return currentStatus === "live" || currentStatus === "complete" ? currentStatus : "working";
  }

  return currentStatus ?? "waiting";
}

function buildSellerProfiles(candidates: ListingCandidate[]) {
  const grouped = new Map<string, SellerProfile>();

  for (const candidate of candidates) {
    const current = grouped.get(candidate.sellerId);
    if (current) {
      grouped.set(candidate.sellerId, {
        ...current,
        linkedListingIds: Array.from(new Set([...current.linkedListingIds, candidate.id])),
        counterfeitRisk: Math.max(current.counterfeitRisk, candidate.counterfeitRisk),
        sellerFraudRisk: Math.max(current.sellerFraudRisk, candidate.sellerFraudRisk),
      });
      continue;
    }

    grouped.set(candidate.sellerId, {
      id: candidate.sellerId,
      sellerName: candidate.sellerName,
      marketplace: candidate.marketplace,
      storefrontUrl: candidate.url,
      location: "Unknown",
      rating: 4.1,
      reviewCount: 18,
      accountAgeDays: 90,
      responseTimeHours: 24,
      transactionVolume: 450,
      redFlags: candidate.signalTags,
      linkedListingIds: [candidate.id],
      counterfeitRisk: candidate.counterfeitRisk,
      sellerFraudRisk: candidate.sellerFraudRisk,
      summary: `${candidate.sellerName} surfaced through the initial listing sweep.`,
    });
  }

  return Array.from(grouped.values());
}

async function consumeEventStream(
  response: Response,
  onEvent: (streamEvent: InvestigationEvent) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const line = frame
        .split("\n")
        .find((entry) => entry.startsWith("data:"))
        ?.replace(/^data:\s*/, "");

      if (!line) {
        continue;
      }

      const streamEvent = JSON.parse(line) as InvestigationEvent;
      onEvent(streamEvent);
    }
  }
}

function downloadFile(filename: string, content: string, contentType: string) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildMarkdownExport({
  officialUrl,
  brandFingerprint,
  candidates,
  dossier,
  reports,
}: {
  officialUrl: string;
  brandFingerprint: BrandFingerprint | null;
  candidates: ListingCandidate[];
  dossier: CaseDossier | null;
  reports: ReportResponse | null;
}) {
  const lines = [
    "# Tiny Detective Export",
    "",
    `- Official URL: ${officialUrl}`,
    `- Brand: ${brandFingerprint?.brandName ?? "Unknown"}`,
    `- Candidates: ${candidates.length}`,
    "",
    "## Ranked Candidates",
    "",
    ...candidates.flatMap((candidate, index) => [
      `### ${index + 1}. ${candidate.title}`,
      `- Seller: ${candidate.sellerName}`,
      `- URL: ${candidate.url}`,
      `- Counterfeit Risk: ${candidate.counterfeitRisk}`,
      `- Seller Fraud Risk: ${candidate.sellerFraudRisk}`,
      `- Reasoning: ${candidate.reasoning.join("; ")}`,
      "",
    ]),
  ];

  if (dossier) {
    lines.push(
      "## Seller Case",
      "",
      ...dossier.findings.map((finding) => `- ${finding}`),
      "",
      ...dossier.recommendedActions.map((action) => `- ${action}`),
      "",
    );
  }

  if (reports) {
    lines.push(
      "## Marketplace Packet",
      "",
      reports.marketplacePacket.summary,
      "",
      reports.marketplacePacket.narrative,
      "",
      "## Authority Packet",
      "",
      reports.authorityPacket.summary,
      "",
      reports.authorityPacket.narrative,
      "",
    );
  }

  return lines.join("\n");
}
