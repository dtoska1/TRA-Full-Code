# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Transparency Radar Albania aggregates public documents (municipal decisions, procurement data, public consultations) from all 61 Albanian municipalities into a single searchable platform. It serves citizens, CSOs, and journalists.

## Development Commands

### Infrastructure (required before running backend)
```bash
docker compose up -d        # Start Postgres (port 5433), Redis (6379), Meilisearch (7700)
```

### Backend (Express API, port 5050)
```bash
cd backend
npm install
npm run dev                 # Development server with auto-reload
npm run start               # Production mode

# Scraping utilities
npm run scrape:tirane       # Run scraper for Tirana (smoke test)
npm run smoke:vendime       # Test vendime parser output
npm run sanity:registry     # Validate source_registry integrity
npm run audit:municipality-keys   # Check for encoding issues in municipality keys
npm run discover:vendime    # Find vendime URLs for municipalities
npm run apply:vendime       # Commit discovered vendime URLs to registry
npm run discover:konsultime # Find konsultime URLs
npm run apply:konsultime    # Commit discovered konsultime URLs
```

### Frontend (Next.js, port 3000)
```bash
cd frontend
npm install
npm run dev                 # Dev server
npm run build               # Production build
npm run lint                # ESLint
```

### Database migrations
Run SQL scripts in numeric order (001–020) against the Docker Postgres container:
```bash
Get-Content -Raw -Encoding UTF8 .\001_init.sql | docker exec -i tra_postgres psql -U tra -d tra
```
All migration scripts are in the repo root, named `00x_*.sql`.

## Architecture

### Data flow
```
External sites (vendime.al, app.gov.al, municipality sites)
  → Scrapers (cheerio / playwright)
  → PostgreSQL (items, prokurime_records, attachments)
  → Meilisearch (full-text index, synced on publish)
  → Redis (aggregation cache, rate-limit state)
  → Express API
  → Next.js frontend
```

### Backend (`backend/`)
- **`index.js`** (~4900 lines) — monolithic Express app containing all routes, middleware, and business logic. All API endpoints live here.
- **`scrapers/`** — Four scraper modules: `tiranaVendime.js`, `vendimeAl.js`, `prokurimeAppExport.js`, `genericDocuments.js`. Scrapers are invoked via `POST /api/scrape/run`.
- **`scripts/`** — 31 CLI scripts for batch scraping, URL discovery, re-indexing, and data repair. Run directly with `node scripts/<name>.js`.
- **`lib/`** — Shared utilities: `coverageStatus.js`, `vendimeStatus.js`, `prokurimeAuthorityMatch.js`, `runnerProgress.js`.

### Frontend (`frontend/`)
- Next.js 15 app router. All pages are in `app/`.
- Key pages: `/` (search + feed), `/municipality/[municipality]` (per-municipality view), `/status` (scraper status), `/coverage` (admin dashboard, token-protected), `/admin/new-item` (manual item creation).
- The frontend is purely a consumer of the backend API — no server-side DB access.

### Database schema (PostgreSQL)
- `municipalities` — 61 rows, one per Albanian municipality
- `source_registry` — One PRIMARY source per municipality + alternates; tracks scrape URLs and `*_checked` flags per category
- `items` — All scraped documents (category: Vendime | Prokurime | Konsultime)
- `attachments` — PDFs/files linked to items
- `prokurime_records` — Extracted spend rows from procurement CSVs
- `users`, `roles`, `user_roles`, `security_events` — Auth/audit tables (provisioned, partially used)

Municipality identity uses `name_key` (auto-generated from `name_sq` via trigger: lowercase, stripped diacritics, hyphens). URL slugs must match this key or a known alias in `municipality_key_aliases`.

### Search
Meilisearch indexes published items. Re-indexing is done via `node scripts/reindex_public_search.js`. Items must be published (`published_at IS NOT NULL`) to appear in search results.

### API auth model
- Public endpoints: `/api/feed`, `/api/search`, `/api/municipalities`, `/api/items/:id`, `/api/dashboard/*`, `/api/public/files/:id`
- Admin endpoints (`/api/scrape/run`, `/api/admin/*`): require `Authorization: Bearer <ADMIN_TOKEN>`
- The frontend coverage/admin pages pass the token from `localStorage` via JS fetch — no session cookies

## Environment Variables

**`backend/.env`** (copy from `.env.example`):
```
PORT=5050
DATABASE_URL=postgres://tra:PASSWORD@localhost:5433/tra
REDIS_URL=redis://localhost:6379
MEILI_HOST=http://localhost:7700
MEILI_MASTER_KEY=...
ADMIN_TOKEN=...
PUBLIC_ORIGINS=http://localhost:3000
NODE_ENV=development
```

**`frontend/.env.local`** (copy from `.env.example`):
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:5050
```

## Content Language

All user-facing copy is in Albanian (sq). Municipality names, category labels (Vendime, Prokurime, Konsultime Publike), and UI strings are Albanian. Keep this consistent when adding new UI text.

## Security rules (non-negotiable)

- Never read, print, or reference `.env` file contents
- Never log or return `ADMIN_TOKEN` in any output, response, or comment
- Never weaken or remove CORS middleware
- Never remove or bypass rate limiting on any route
- Never leak stack traces or internal paths in error responses to the client
- Destructive database operations (DROP, DELETE, TRUNCATE) require explicit human approval before running
- Preserve municipality identity fields (`name_key`, `municipality_id`) on all affected tables
- Preserve provenance fields on scraped items — do not drop or nullify origin URL, ingestion timestamp, or equivalent traceability fields

## Workflow constraints

- Prefer narrow, targeted changes over broad refactors
- Do not add new dependencies without explicit instruction
- Do not modify shared middleware, global config, or auth logic unless the task explicitly requires it
- Do not run migrations without confirmation
- All work happens on a feature branch — never commit directly to `main`
- Keep UI copy in Albanian (sq) — do not introduce English-language user-facing strings

## VPS Postgres topology — TWO containers, do not confuse (mapped 2026-07-18)

Two Postgres containers run on the VPS (root@13.140.168.152). They are NOT the same DB.

- **PRODUCTION → `tra_postgres` → host port 5433.**
  - Stack: `/opt/tra-full` (the current, post-rebuild deploy).
  - Backend `.env`: `DATABASE_URL=...@localhost:5433/tra`. App reads this; `radarvendor.com` serves it.
  - Holds ALL consultation-scoring work (overrides, `consultation_scores` table).
  - This is the ONLY canonical store. All tools, migrations, and queries must target 5433.

- **ORPHAN → `transparency-radar-postgres-1` → host port 5432.**
  - Stack: `/opt/transparency-radar/docker-compose.yml` (the OLD pre-rebuild repo path).
  - Created 2026-06-23, ~3 weeks before scoring work. Has NO `consultation_scores` table.
  - Leftover from before the rebuild moved to `/opt/tra-full`; old stack was never `compose down`ed.
  - NOT production. Nothing of value confirmed on it. Safe to ignore.

### Rules
- Any tool/query/migration MUST target 5433 (`tra_postgres`). Verify `DATABASE_URL` byte-for-byte against `/opt/tra-full/backend/.env` before running anything real.
- `docker exec tra_postgres psql` connects inside the container on 5432 (its internal port) — this is correct and reaches production. 5433 is the HOST-side mapping. A `-p 5433` inside `docker exec` will "connection refused" — testing artifact, ignore.
- Before retiring the orphan: read `/opt/transparency-radar/docker-compose.yml` to confirm nothing live depends on the old stack, then `compose down` that stack. Not urgent.

### Open thread
- Last session assumed Claude Code read the orphan (5432), explaining its "zero overrides / totals 30/20/30/0/0". But 5432 has no `consultation_scores` table, so those totals can't have come from a plain query against it. Claude Code's real connection target is UNCONFIRMED. Do not carry "CC read 5432" forward as fact — print CC's resolved `DATABASE_URL` and observe it before re-grounding migration 032.

### Migration 032 status
- Written/sampled against the WRONG store. Cannot run as-is. Re-ground all sampling against 5433, run migration-guard skill, back up 5433, THEN it's a run candidate.
