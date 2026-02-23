# TRA v1 Implementation Plan (PR0–PR6, Locked)

## Summary
This plan executes the revised sequence exactly, with no scope drift:
1. Standardize runner behavior/progress.
2. Add Vendime nationwide baseline with one primary pagination pointer.
3. Complete controlled Vendime hybrid supplemental flow.
4. Add Konsultime nationwide + strict year mode.
5. Ship category-scoped publishing/admin workflow.
6. Ship hardened manual ingest fallback + split file access.
7. Finish public UX/search/SEO with script-first reindex.

## Public API / Interface Changes
`POST /api/scrape/run`:
- Extend Vendime to support nationwide pagination mode (no municipality selector), returning `next_offset`.
- Keep `offset` input and treat `next_offset` as the authoritative resume pointer.

`GET /api/feed`:
- Add strict `year` behavior: when `year` exists, only rows with non-null `published_date` matching that year are returned.
- Null-date rows are only eligible when `year` is omitted.

`POST /api/admin/publish`:
- Publish draft items by municipality/category/(optional year).

`POST /api/admin/source/checked`:
- Set category-specific checked state for one municipality/category.

`POST /api/admin/items/manual`:
- Create manual item from `source_url` or uploaded PDF (mutually exclusive), with manual provenance.

`GET /api/public/files/:id`:
- Return 404 unless parent item is published.
- Return 404 for nonexistent, draft, unauthorized visibility cases.

`GET /api/admin/files/:id`:
- Require `Authorization: Bearer ADMIN_TOKEN`.
- Allow retrieval of files for draft/published items for admin operations.

`GET /api/search`:
- Search published documents via Meilisearch.

No endpoint may expose internal storage paths.

## Data/Schema Changes
Add migration for category-scoped checked flags on `source_registry`:
- `vendime_checked BOOLEAN NOT NULL DEFAULT FALSE`
- `prokurime_checked BOOLEAN NOT NULL DEFAULT FALSE`
- `konsultime_checked BOOLEAN NOT NULL DEFAULT FALSE`

Backfill policy:
- No automatic “set all three”.
- Add explicit script `backend/scripts/backfill_checked_scope.js --category=<Vendime|Prokurime|Konsultime publike>` that backfills exactly one selected category at a time from legacy intent.
- Keep legacy `verification_status` for compatibility during transition.

## PR0 — Runner Standardization + Shared Progress Helper
Files:
- `backend/lib/runnerProgress.js`
- `backend/scripts/run_prokurime_nationwide.js`
- `backend/package.json`
- `README.md`

Implementation:
- Create shared helper: `loadProgress`, `saveProgress`, `shouldSleep`, `backoffOn429`.
- Standardize runner args: `--year --limit --sleep_ms --max_runtime_ms --resume`.
- Keep compatibility aliases where needed.
- Standardize progress schema keys and error envelope.

Acceptance:
- Prokurime behavior unchanged functionally.
- CI remains green.

Verification:
- `node --check backend/lib/runnerProgress.js`
- `node --check backend/scripts/run_prokurime_nationwide.js`
- Existing CI workflow passes.

## PR1 — Vendime Nationwide Baseline (Single Primary Pointer)
Files:
- `backend/index.js`
- `backend/scripts/run_vendime_nationwide.js`
- `backend/package.json`
- `README.md`

Implementation:
- Extend Vendime scrape path to nationwide mode with `offset` pagination.
- Runner uses one authoritative pointer: `next_offset`.
- Progress file: `backend/tmp/vendime_progress_YYYY.json`.
- Resume logic uses only `next_offset` as primary pagination state.
- Keep strict year gating and counters (`skipped_missing_date`, `skipped_wrong_year`).
- Preserve existing response fields; add aliases only if needed for consistency.

Acceptance:
- Nationwide Vendime run completes with `next_offset=null`.
- Resume restarts from single pointer without duplication/skips.
- No null `published_date` inserted in year mode.

Verification:
- Low-limit dry run + resume run against local backend.
- SQL checks documented in README.

## PR2 — Vendime Hybrid Supplemental (Controlled Rollout)
Files:
- `backend/index.js`
- `017_vendime_official_sources.sql` (or new additive migration for pilot flags)
- `README.md`

Implementation:
- Preserve baseline + official dual ingestion.
- Ensure precedence prefers official only when official candidate has usable date + document quality.
- Keep provenance per row (`source_origin`, `source_page_url`) and remove brittle hardcoded origin behavior.
- Keep pilot enablement scoped (e.g., Tirane, Durres) via registry data, not code constants.

Acceptance:
- Pilot municipalities show predictable baseline/official counters.
- No hardcoded origin regressions.

Verification:
- Targeted scrape runs for pilot municipalities.
- Dedupe/provenance SQL checks documented.

## PR3 — Konsultime Nationwide + Year Mode
Files:
- `backend/scripts/run_konsultime_nationwide.js`
- `backend/index.js`
- `backend/package.json`
- `README.md`

Implementation:
- Add nationwide Konsultime runner with same resume/backoff contract.
- Keep no-year source policy unchanged and strict.
- Enforce year mode gating: require date, skip missing/wrong-year with counters.
- Ensure `/api/feed?category=Konsultime&year=YYYY` returns dated-only results due to strict feed-year filter.

Acceptance:
- Nationwide runner resumable and stable.
- Policy counters visible and no no-year policy loosening.

Verification:
- `node --check backend/scripts/run_konsultime_nationwide.js`
- Feed/year checks with sample data.

## PR4 — Publishing Workflow + Coverage Admin Actions
Files:
- New migration for category-checked flags
- `backend/index.js`
- `backend/lib/coverageStatus.js`
- `frontend/app/coverage/page.tsx`
- `backend/scripts/ci_smoke.js`
- `README.md`

Implementation:
- Use category-scoped checked flags in publish eligibility rules.
- Add `POST /api/admin/publish`.
- Add `POST /api/admin/source/checked`.
- Add explicit category-targeted backfill script.
- Add separate admin rate limiter.
- Add coverage UI row actions: Run scrape now, Publish drafts (optional year), Mark CHECKED.

Acceptance:
- No manual SQL required for publish/check actions.
- Coverage reflects draft/published correctly.

Verification:
- CI smoke extends to new admin endpoints.
- Manual coverage action flow for at least one municipality/category.

## PR5 — Manual Ingest Fallback + Hardened Uploads
Files:
- `backend/index.js`
- `backend/.env.example`
- `frontend/app/admin/new-item/page.tsx`
- `.gitignore`
- `README.md`

Implementation:
- Add `POST /api/admin/items/manual`.
- Enforce `source_url XOR file`.
- Upload hardening:
  - Max size limit (env-configurable).
  - PDF magic-byte validation (`%PDF-`).
  - UUID filename generation.
- Store files under `backend/uploads` (gitignored).
- Add split file endpoints:
  - `/api/public/files/:id` strict 404 for all non-published.
  - `/api/admin/files/:id` admin-only.
- Never expose `storage_uri` or filesystem path in responses.

Acceptance:
- Manual items appear in feed when published.
- Public files endpoint never leaks draft existence.

Verification:
- Upload valid PDF, reject invalid/oversize files.
- Confirm 404 behavior for non-published on public endpoint.
- Confirm admin endpoint retrieves draft files with token.

## PR6 — UX Polish + Search + SEO + Script-First Reindex
Files:
- `backend/index.js`
- `backend/scripts/reindex_public_search.js`
- `frontend/app/page.tsx`
- `frontend/app/municipality/[municipality]/page.tsx`
- `frontend/app/layout.tsx` (and page metadata helpers)
- `README.md`

Implementation:
- Add search API and connect frontend global search.
- Add municipality filters: category tabs, year filter, sort newest/oldest.
- Show card metadata: date, municipality, category badge, source host, link.
- Add SEO metadata per municipality/category/year.
- Reindex capability via script first; defer admin reindex endpoint unless operationally necessary.

Acceptance:
- Mobile-first behavior stable.
- Search fast/relevant on published index.
- SEO metadata present for key pages.

Verification:
- Frontend build/lint.
- Search smoke checks using seeded/published data.
- Manual mobile and desktop UI checks.

## Test Matrix (Required Across PRs)
- Auth tests for all admin endpoints.
- Runner resume/backoff tests for 429 and timeout cases.
- Strict feed-year tests (null-date exclusion when `year` present).
- Publishing promotion tests (`published_updated` on rerun or admin publish).
- File endpoint visibility tests (`/api/public/files/:id` returns 404 unless published).
- Manual upload security checks (size, magic bytes, UUID naming).
- CI smoke remains green at each PR.

## Assumptions and Defaults
- `next_offset` is the single primary pagination pointer for Vendime nationwide progress/resume.
- Legacy `verification_status` remains temporarily, but category flags become source of truth for category publish automation.
- Reindex is script-driven in v1; endpoint postponed unless needed.
