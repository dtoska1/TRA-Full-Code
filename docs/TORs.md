
# Transparency Radar Albania — Terms of Reference (TORs)

## Duration

ASAP (milestone-based; “best possible” public-ready v1, then iterative improvements after launch)

## Objective

Deliver a working, public-ready v1 transparency platform that covers all 61 Albanian municipalities end-to-end.

## Scope (in)

### Data ingestion

- Scrape municipal sites for documents (vendime, prokurime, konsultime, etc.)
- Store document metadata + source URL + timestamps + snapshots/PDFs when present
- Maintain a stateful registry for sources (last seen, error states, cooldowns, etc.)

### Storage & indexing

- PostgreSQL as the canonical source of truth
- Meilisearch indexing for fast search and good UX
- Redis for caching/rate limiting/queues

### API

- Read-only public endpoints for:
  - municipality list + detail
  - public feed
  - item detail + attachments
  - basic health endpoints

### Public site

- News-website style
- Mobile-first and SEO-first
- Browse + search + filter
- 61 municipalities supported from day 1

## Non-goals (v1)

- Full auth/roles/admin portal (unless minimal is required)
- Payments, subscriptions
- Complex analytics dashboards
- Multilingual support beyond what’s needed for v1

## Constraints

- No secrets committed to git
- Reproducible local environment via Docker Compose (deps bound to 127.0.0.1)
- Scrapers must be robust (Playwright-first)
- Keep schema migrations and scripts deterministic and reviewable

## Deliverables

- Repo with working Docker Compose (db + redis + search + app services where relevant)
- Database schema + seed scripts
- Source registry + scraper runner design
- API + public site MVP
- Deployment notes for production launch

## Definition of Done (v1)

A new machine can clone repo, set `.env`, run compose, run DB scripts + seed, and see:

- Exactly **61** municipalities loaded
- At least one municipality scraping flow working end-to-end
- Public feed accessible via API
- Public website renders feed + search (Meilisearch)

Recommended local defaults (this repo):

- Postgres: `localhost:5433`
- API: `http://localhost:5050`
