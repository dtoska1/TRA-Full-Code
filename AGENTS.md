# Repository Agent Rules (Codex / AI Assistants)

This file is the **source of truth** for how Codex (and any AI assistants) should work in this repo.

## Core rules

- Prefer **small, reviewable diffs** over big refactors.
- Keep changes **testable** (add a quick verification step for every change).
- **Never commit secrets** (no real API keys, passwords, tokens, `.env`, etc).
  - Commit only `.env.example` templates with placeholders.
  - Real secrets live only in local untracked `.env` files and/or Codex Environment Secrets.
- Avoid destructive commands (force-deletes, history rewrites, DB drops). If a destructive action is required, **flag it clearly**.
- Keep `main` **stable and shippable**.

---

# Transparency Radar Albania — Project Context (Read Me First)

## 1) What we’re building

A national “Transparency Radar Albania” platform that consolidates:

- Municipal decisions (**Vendime**)
- Procurement notices (**Prokurime**)
- Public consultations (**Konsultime**)

…into one **news-website style**, **mobile-first**, **SEO-first** public experience covering **all 61 municipalities** end-to-end.

## 2) Repo & workflow (“insider mode”)

- GitHub owner: `dtoska1`
- Repo: `Transparency Radar Albania` (slug `Transparency-Radar-Albania`)
- Branches:
  - `main` = stable
  - `codex-code-changes` = working branch for Codex proposals

Workflow:

1. Codex proposes changes on `codex-code-changes`.
2. Dion reviews locally in VS Code.
3. Merge into `main` only when validated.

## 3) Canonical stack (target)

- Public site: Next.js (TypeScript) + Tailwind (SEO-first)
- Backend: current Node/Express (`/backend`), target NestJS (TypeScript)
- DB: PostgreSQL (source of truth)
- Search: Meilisearch
- Cache/queues/rate limit: Redis
- Scraping: Playwright-first; Cheerio/HTTP fallback
- Storage: S3-compatible (R2/S3/B2) for PDFs/snapshots
- Monitoring: Sentry + uptime/metrics
- Containers: Docker + Docker Compose

## 4) Local infrastructure (Windows + Docker Desktop)

This repo uses Docker Compose for local-only dependencies (bound to **127.0.0.1**):

- Postgres: `tra_postgres`
  - Host: `localhost`
  - Host port: **5433** (container 5432)
  - DB: `tra`, user: `tra`, password: set by compose
- Redis: `tra_redis` on `localhost:6379`
- Meilisearch: `tra_meili` on `localhost:7700`

> Postgres is mapped to **5433** because Windows is already using 5432 on this machine.
> If you change the port mapping, update `DATABASE_URL` accordingly.

Start:

- `docker compose up -d`
- `docker ps` should show: `tra_postgres`, `tra_redis`, `tra_meili`

## 5) Backend (host-run)

Backend lives in `/backend` and uses dotenv when run from the backend folder.

- Local env file: `backend/.env` (**untracked**)
- Template: `backend/.env.example` (**committed**)

Minimum env vars:

- `PORT=5050`
- `DATABASE_URL=postgres://tra:__SET_ME__@localhost:5433/tra`
- `REDIS_URL=redis://localhost:6379`
- `MEILI_HOST=http://localhost:7700`
- `MEILI_MASTER_KEY=__SET_ME__`

Run:

- `cd backend`
- `npm i`
- `npm run dev`

Health:

- `http://localhost:5050/health`

## 6) Database bootstrap & seeding

DB scripts live at repo root:

- `001_init.sql`
- `002_hardening.sql`
- `003_views_and_keys.sql`
- `004_name_key_trigger.sql` (auto-generates `municipalities.name_key`)
- `005_seed_municipalities.sql` (must insert **exactly 61** municipalities)

PowerShell-safe, stop on error:

- `Get-Content -Raw -Encoding UTF8 .\001_init.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1`
- (repeat for 002/003/004/005)

Verification queries:

- `SELECT count(*) FROM municipalities;`  → must be `61`
- `SELECT name_sq, county, name_key FROM municipalities ORDER BY name_sq LIMIT 10;`

⚠️ Note about test data:

- `schema_verification_check.sql` inserts “Bashkia Schema Test …” rows into `municipalities`.
  - Run it only on a scratch DB, or expect municipality counts to exceed 61.

## 7) What Codex should do by default

When asked to implement something:

1. Make the smallest safe change that moves the project forward.
2. Update docs if behavior/steps changed (README + `docs/*`).
3. Add a quick local verification step (SQL query, curl, or minimal script).
4. Keep secrets out of commits.
