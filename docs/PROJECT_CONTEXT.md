
# Codex Context: Transparency Radar Albania

This repo is **Transparency Radar Albania**: a civic-tech platform to collect, store, and publish municipal transparency documents across **all 61 Albanian municipalities**.

## Product goal (v1)

- News-website style, mobile-first, SEO-first public site.
- End-to-end coverage for all 61 municipalities so “launch” is mostly domain + DNS.
- Core content types: municipal **decisions (vendime)**, **procurements (prokurime)**, **public consultations (konsultime)** (and similar).

## Canonical stack decisions

**Public site (planned / in-progress):**

- Next.js (TypeScript) + Tailwind, SEO-first.

**Backend (current / transitioning):**

- Current: Node.js/Express in `/backend`
- Target: NestJS (TypeScript), migrating from Express.

**Data + infra**

- PostgreSQL = source of truth
- Meilisearch = search UX
- Redis = caching/queues/rate limits
- Scraping: Playwright-first (robust), Cheerio/HTTP fallback optimization
- S3-compatible object storage for PDFs/snapshots (R2 / S3 / B2)
- Monitoring: Sentry + uptime/metrics
- Docker + Docker Compose for reproducible local/prod

## Local development (recommended)

We use Docker Compose for dependencies (Postgres + Redis + Meilisearch). Backend runs on the host for now.

Typical flow:

1. `docker compose up -d`
2. Apply SQL scripts in repo root: `001_init.sql`, `002_hardening.sql`, `003_views_and_keys.sql`, `004_name_key_trigger.sql`
3. Seed canonical municipalities: `005_seed_municipalities.sql` (must insert **61** rows)
4. In another terminal:
   - `cd backend`
   - `npm install`
   - `npm run dev`

### Postgres ports (this repo)

This repo maps Postgres as:

- `127.0.0.1:5433:5432`

So the backend should use:

- `DATABASE_URL=postgres://tra:<POSTGRES_PASSWORD>@localhost:5433/tra`

Verify mapping with:

- `docker port tra_postgres 5432`

### PowerShell-safe SQL execution

Use `-Raw` + `-Encoding UTF8` and stop on errors:

- `Get-Content -Raw -Encoding UTF8 .\001_init.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1`

(repeat for 002/003/004/005)

## Key DB invariants we care about

- `source_registry` is stateful; invariants like:
  - `attempt_count` never decreases
  - `first_seen_utc` write-once
  - `hour_buckets_seen` append-only
- `items` has dedup/uniqueness constraints; avoid inserting duplicates when `source_url` is missing.
- `municipalities.name_key` is required and auto-generated via trigger (`004_name_key_trigger.sql`).

## Seeding notes

- `005_seed_municipalities.sql` should result in:
  - `SELECT count(*) FROM municipalities;` → `61`

⚠️ `schema_verification_check.sql` inserts “Bashkia Schema Test …” rows into `municipalities`.
Run it only on a scratch DB if you want the canonical municipalities table to remain exactly 61.

## Project documents

- See `docs/SUMMARY.md`
- See `docs/TORs.md`

## What Codex should do by default

- Prefer small, safe diffs.
- Keep secrets out of git (never commit `.env`).
- When changing DB schema/migrations, include idempotent SQL and a verification query.
- When changing Docker compose, keep host ports bound to `127.0.0.1` for local safety.
