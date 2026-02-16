
# Transparency Radar Albania — Summary (v1)

## Goal

Build a public-ready v1 transparency platform for Albania: scrapers + API + database + public site.
Mobile-first, SEO-first, covering all 61 municipalities end-to-end so “launch” is basically domain + DNS.

## What “v1 public-ready” means

- Stable schema + seed for municipalities (exactly 61 canonical rows)
- Scrapers that can ingest documents reliably (Playwright-first; Cheerio/HTTP fallback)
- API that serves a canonical public feed + municipality pages
- Public site that lists/searches/filter documents (SEO-first)
- Storage for PDFs/snapshots (S3-compatible)
- Observability (logging + Sentry) and basic abuse protections (rate limit)
- Reproducible local/prod via Docker + Docker Compose

## Tech stack (target)

- Public site: Next.js (TypeScript) + Tailwind
- Backend API: NestJS (TypeScript) (migrating from Express/Node)
- DB: PostgreSQL (source of truth)
- Search: Meilisearch
- Cache/queues/rate limit: Redis
- Scraping: Playwright-first; Cheerio/HTTP fallback
- Object storage: S3-compatible (R2/S3/B2)
- Monitoring: Sentry + uptime/metrics
- Containers: Docker + Docker Compose

## Current state

- Docker Compose runs: Postgres + Redis + Meili (localhost-only)
- DB schema scripts exist (001_init, 002_hardening, 003_views_and_keys)
- `municipalities.name_key` auto-generation trigger exists (004)
- Municipality seed script exists (005_seed_municipalities.sql) and must ensure 61 rows

### Local dev defaults (this repo)

- Postgres mapped to `localhost:5433` (container 5432)
- Backend default port: `5050`
- Backend `.env` lives in `backend/.env` (untracked); template is `backend/.env.example`

## Primary next steps

1. Finalize and enforce `005_seed_municipalities.sql` (insert 61 canonical municipalities; verify count=61)
2. Verify feed view and invariants in DB
3. Solidify scraper registry + generic document extraction pipeline
4. API endpoints: municipalities, feed, item details, attachments
5. Public site: home feed + municipality listing + search UX
