# Tiny Detective

Tiny Detective is a premium `Next.js 16` clone of the hackathon concept from the `Lotushack2026` recording: a thin `TinyFish` investigation workspace for counterfeit discovery, seller-pattern analysis, and exportable marketplace or authority-ready reporting.

## What it does

- Accepts one official product URL as the investigation seed.
- Streams a TinyFish-style investigation over `POST /api/investigate`.
- Ranks suspicious listings by counterfeit risk and seller-fraud risk.
- Builds a seller-centric dossier over `POST /api/case`.
- Generates both a marketplace packet and an authority packet over `POST /api/report`.
- Falls back to a realistic mock investigation when API keys are missing, so the full UI remains testable locally.

## Run it

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment

Copy `.env.example` to `.env.local` and set whichever keys you have:

```bash
TINYFISH_API_KEY=
OPENAI_API_KEY=
```

Behavior:

- No `TINYFISH_API_KEY`: the app streams a mock investigation with Lazada-first sample results.
- `TINYFISH_API_KEY` present: the server attempts a live TinyFish run using `lite` first, then retries blocked runs with `stealth + proxy`.
- No `OPENAI_API_KEY`: report narratives fall back to deterministic copy.

## Useful scripts

```bash
npm run dev
npm run lint
npm run typecheck
npm run build
```

## Routes

- `/` investigation workspace
- `/api/investigate` streaming investigation endpoint
- `/api/case` dossier generation endpoint
- `/api/report` report packet endpoint
