# E2E Review & Bug-Fix Plan (2026-05-15)

## Scope
- Ran static and production checks (`lint`, `typecheck`, `build`).
- Reviewed end-to-end flow for `/api/investigate` → `/api/case` → `/api/report` and UI state handling.

## Findings

### 1) Production build can fail when Google Fonts are unreachable
- **Severity:** High (release blocker in restricted-network environments)
- **Observed in check:** `npm run build`
- **Symptom:** Next.js build fails while fetching `Manrope`, `Newsreader`, and `IBM Plex Mono` via `next/font/google`.
- **Likely root cause:** `src/app/layout.tsx` imports remote Google fonts directly; build requires network reachability to fetch those assets.

**Fix plan**
1. Replace `next/font/google` usage with local font assets via `next/font/local`.
2. Commit woff2 files into repo (or use an approved internal asset source).
3. Keep existing CSS variable names (`--font-ui`, `--font-display`, `--font-mono`) to avoid downstream style regressions.
4. Re-run `npm run build` in CI to verify offline determinism.

---

### 2) API payload validation is overly permissive for nested structures
- **Severity:** High (runtime integrity/security risk)
- **Where:** `src/lib/investigation/pipeline.ts`
- **Symptom:** `caseRequestSchema` and `reportRequestSchema` use `z.custom<...>()` for complex objects.
- **Impact:** Unsafe payloads can pass parsing and later cause runtime exceptions, malformed dossier generation, or incorrect risk outputs.

**Fix plan**
1. Replace `z.custom<BrandFingerprint>()`, `z.custom<ListingCandidate>()`, `z.custom<SellerProfile>()`, and `z.custom<CaseDossier>()` with strict `z.object(...)` schemas.
2. Add `.strict()` to reject unknown keys where appropriate.
3. Add targeted unit tests for invalid nested payloads (missing required fields, wrong types, malformed arrays).
4. Confirm `400` responses for invalid payloads across `/api/case` and `/api/report`.

---

### 3) Case ID generation can produce low-quality IDs when `runId` is absent
- **Severity:** Medium
- **Where:** `buildSellerCentricCaseDossier` in `src/lib/investigation/pipeline.ts`
- **Symptom:** `caseId` is built as `case_${investigation.runId}`. If `runId` is missing/empty from client payload, ID degrades (e.g., `case_undefined`).
- **Impact:** Downstream confusion in exported packets and poor traceability.

**Fix plan**
1. Normalize run ID with fallback (`crypto.randomUUID()` or timestamp-based ID) when absent.
2. Add invariant check before dossier build.
3. Add test ensuring `caseId` is always non-empty and stable format (`case_<id>`).

---

### 4) Report generation silently swallows all OpenAI errors
- **Severity:** Medium
- **Where:** `generateReportNarrative` in `src/lib/investigation/pipeline.ts`
- **Symptom:** Catch block ignores all exception details and falls back to deterministic narrative.
- **Impact:** Operators cannot distinguish expected fallback vs real integration failures; troubleshooting is hard.

**Fix plan**
1. Log structured error metadata server-side (without leaking secrets).
2. Keep deterministic fallback for UX continuity.
3. Add observability fields (e.g., `narrativeSource: "openai" | "fallback"`) in API response.
4. Add test coverage for fallback branch.

---

## Recommended execution order
1. **Schema hardening (Finding #2)** — prevents bad data from entering pipeline.
2. **Case ID robustness (Finding #3)** — improves data quality.
3. **Error observability (Finding #4)** — improves supportability.
4. **Local fonts migration (Finding #1)** — removes environment-dependent build failures.

## Exit criteria
- `npm run lint` passes.
- `npm run typecheck` passes.
- `npm run build` passes in network-restricted CI.
- API contract tests verify invalid payload rejection and fallback behavior.
