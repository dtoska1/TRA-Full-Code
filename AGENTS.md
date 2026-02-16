
# Transparency Radar Albania — Codex Operating Guide (AGENTS.md)

This repo is a monorepo-style project for **Transparency Radar Albania**: scrapers + API + database + public site to collect and publish municipal transparency documents across **all 61 Albanian municipalities**.

Codex (and any other agent) should read this file first.

---

## 1) North-star goal

Ship a **public-ready v1** that is:

- **Mobile-first, SEO-first**, “news website” style.
- Covers **all 61 municipalities end-to-end** (scrape → store → search → public feed).
- So “launch” is basically **buy domain + DNS** (minimal tweaks).

---

## 2) Target architecture (best-possible stack)

**Public site (v1):**

- Next.js (TypeScript) + Tailwind
- SEO pages: municipality pages, category pages, item detail pages, RSS, sitemap

**Backend (API):**

- Source of truth: PostgreSQL
- Near-term: existing Node/Express code may exist
- Target: migrate to NestJS (TypeScript) when the v1 is stable

**Search + caching:**

- Meilisearch for fast, high-quality search UX
- Redis for caching, queues, and rate limits

**Scraping:**

- Playwright-first for robustness
- Cheerio/HTTP fallback for speed where possible
- Store PDFs/snapshots into S3-compatible object storage (Cloudflare R2 / AWS S3 / Backblaze B2)

**Ops:**

- Docker + Docker Compose for reproducible local/prod
- Monitoring: Sentry + uptime/metrics

---

## 3) Working rules (IMPORTANT)

### Safety / security

- **NEVER commit secrets** (.env, tokens, API keys, passwords).
- Keep `.env` ignored; keep `.env.example` committed with **blank values** only.
- Any credentials belong in:
  - local untracked `.env`, and/or
  - Codex “Environment → Secrets” (for agent runs).

### Change discipline

- Keep changes **small and reviewable**.
- Explain what changed and why.
- Ask before destructive operations:
  - force-deletes, history rewrites, dropping DBs, nuking volumes, etc.

### Data invariants (do not break)

If/when `source_registry` exists, preserve:

- `attempt_count` never decreases
- `hour_buckets_seen` append-only
- `first_seen_utc` write-once
- avoid duplicate items by stable dedupe rules

---

## 4) Repo & workflow expectations

### Branching

- Prefer feature work in `codex-code-changes` (or a short-lived feature branch).
- Merge into `main` via PR when stable.

### Local dev (typical)

1. Start infra:
   - `docker compose up -d`
2. Apply SQL scripts (PowerShell-friendly):
   - `Get-Content .\001_init.sql | docker exec -i tra_postgres psql -U tra -d tra`
   - `Get-Content .\002_hardening.sql | docker exec -i tra_postgres psql -U tra -d tra`
   - `Get-Content .\003_views_and_keys.sql | docker exec -i tra_postgres psql -U tra -d tra`
   - (optional) `Get-Content .\004_name_key_trigger.sql | docker exec -i tra_postgres psql -U tra -d tra`
3. Run backend:
   - from `backend/`: `npm install` then `npm run dev` (or `npm start`)

> NOTE: If `municipalities.name_key` is NOT NULL and auto-generated, ensure a trigger/function exists (see `004_name_key_trigger.sql` pattern).

---

## 5) “Must-have” product behavior

- A public feed view exists (e.g., `v_public_feed`) that powers the homepage.
- Municipality list is canonical and should end at **61 rows** in production.
- Search works (Meilisearch) and stays in sync with DB.
- Scrapers are robust, respectful (rate limits), and auditable (log source_url, snapshot refs, errors).

---

## 6) Files Codex should treat as truth

If present, always use these as primary guidance:

- `AGENTS.md` (this file)
- `docs/TORs.md`
- `docs/SUMMARY.md`
- `README.md` (if/when added)
- SQL migration scripts in repo root (001_*, 002_*, …)
