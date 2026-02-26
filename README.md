
# Transparency Radar Albania

Full-stack transparency platform for Albania: scrapers + API + database + public site to collect and publish municipal documents across all **61 municipalities**.

## About / Outcomes

- **Improved access to public information:** Citizens, CSOs, and journalists get a centralized, user-friendly platform aggregating municipal decisions, procurement data, and consultations, reducing fragmentation and increasing transparency.
- **Digital democracy impact:** The platform transforms fragmented public information into accessible, actionable data; strengthens civic participation by enabling monitoring of municipal decisions, engagement in consultations, and accountability advocacy; and enhances transparency through aggregation and plain-language summaries understandable to diverse audiences.
- Internal reference video: `https://www.youtube.com/watch?v=sV1i2h5rkPA`

## Repo layout

- `backend/` – Node/Express API + scrapers
- `docs/` – project context & requirements
- `docker-compose.yml` – local Postgres + Redis + Meilisearch (**localhost-only**)
- `00x_*.sql` – DB init/hardening/views/seed scripts (run in order)

## Quick start (local dev)

### Security hygiene

- Never commit `.env` files (only commit `.env.example` templates).
- If `ADMIN_TOKEN` is ever exposed, rotate it immediately and restart services that use it.

### 1) Start infrastructure (Postgres/Redis/Meili)

From repo root:

- `docker compose up -d`
- `docker ps` should show: `tra_postgres`, `tra_redis`, `tra_meili`

Ports (default in this repo):

- Postgres: `localhost:5433` → container `5432`
- Redis: `localhost:6379`
- Meilisearch: `http://localhost:7700`

### 2) Initialize DB schema + views + triggers

From repo root (PowerShell-friendly, stop on error):

```powershell
Get-Content -Raw -Encoding UTF8 .\001_init.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
Get-Content -Raw -Encoding UTF8 .\002_hardening.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
Get-Content -Raw -Encoding UTF8 .\003_views_and_keys.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
Get-Content -Raw -Encoding UTF8 .\004_name_key_trigger.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
Get-Content -Raw -Encoding UTF8 .\014_municipality_key_aliases.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
```

> Note (Windows/PowerShell): `< file.sql` redirection is not reliable. Use `Get-Content -Raw ... | docker exec -i ...` instead.

### 3) Seed municipalities (must be 61)

```powershell
Get-Content -Raw -Encoding UTF8 .\005_seed_municipalities.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
docker exec -it tra_postgres psql -U tra -d tra -c "SELECT count(*) FROM municipalities;"
```

Expected: `count = 61`

⚠️ `schema_verification_check.sql` inserts test rows into `municipalities`. Run it only on a scratch DB if you want the municipality set to remain exactly 61.

### 4) Seed source_registry (must be 61 primary rows)

`/api/scrape/run` requires a PRIMARY `source_registry` row per municipality. Seed it like this:

```powershell
Get-Content -Raw -Encoding UTF8 .\006_seed_source_registry.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
docker exec -it tra_postgres psql -U tra -d tra -c "SELECT count(*) FROM source_registry WHERE is_primary = TRUE;"
```

Expected: `count = 61`

### 5) Configure backend env

Backend expects `.env` in `backend/` (untracked). Start from the template:

- Copy `backend/.env.example` → `backend/.env`
- Fill placeholders:

Example (local-only values):

- `PORT=5050`
- `DATABASE_URL=postgres://tra:<POSTGRES_PASSWORD>@localhost:5433/tra`
- `REDIS_URL=redis://localhost:6379`
- `MEILI_HOST=http://localhost:7700`
- `MEILI_MASTER_KEY=<MEILI_MASTER_KEY>`
- `MANUAL_UPLOAD_MAX_BYTES=20971520`
- `PROKURIME_NATIONWIDE_SOURCE_URL=https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/`

> `POSTGRES_PASSWORD` should match what is set in `docker-compose.yml` for the Postgres service (or whatever password your existing DB volume was initialized with).

### 5.1) Canonical vendime.al registry (v1 ingestion)

Run migration `015_vendime_al_canonical_and_item_provenance.sql` so all 61 primary `source_registry` rows use vendime.al URLs:

```powershell
Get-Content -Raw -Encoding UTF8 .\015_vendime_al_canonical_and_item_provenance.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
```

The migration:
- Sets `source_registry.vendime_url` to `https://www.vendime.al/<name_key>/` by default.
- Applies explicit vendime.al slug overrides where needed (kept in the migration `overrides` CTE).
- Preserves `verification_status` values (no global `CHECKED` update).
- Adds minimal provenance columns on `items`: `source_origin`, `source_page_url`.

### 5.2) Category-scoped CHECKED flags (publish automation)

Run migration `018_source_registry_category_checked_flags.sql`:

```powershell
Get-Content -Raw -Encoding UTF8 .\018_source_registry_category_checked_flags.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
```

This adds per-category flags on `source_registry`:
- `vendime_checked`
- `prokurime_checked`
- `konsultime_checked`

No automatic backfill is performed by migration.

### 5.2.1) Optional admin-only CHECKED reset (only after Dion confirms)

If category flags were enabled too broadly and you want to reset only `Prokurime` and
`Konsultime publike` (while leaving `Vendime` unchanged), run:

```sql
-- Pre-check
SELECT
  COUNT(*) FILTER (WHERE is_primary = TRUE) AS primary_total,
  COUNT(*) FILTER (WHERE is_primary = TRUE AND vendime_checked = TRUE) AS vendime_true,
  COUNT(*) FILTER (WHERE is_primary = TRUE AND prokurime_checked = TRUE) AS prokurime_true,
  COUNT(*) FILTER (WHERE is_primary = TRUE AND konsultime_checked = TRUE) AS konsultime_true
FROM source_registry;

-- Reset only non-Vendime category flags
UPDATE source_registry
SET
  prokurime_checked = FALSE,
  konsultime_checked = FALSE,
  updated_at = now()
WHERE is_primary = TRUE;

-- Post-check
SELECT
  COUNT(*) FILTER (WHERE is_primary = TRUE) AS primary_total,
  COUNT(*) FILTER (WHERE is_primary = TRUE AND vendime_checked = TRUE) AS vendime_true,
  COUNT(*) FILTER (WHERE is_primary = TRUE AND prokurime_checked = TRUE) AS prokurime_true,
  COUNT(*) FILTER (WHERE is_primary = TRUE AND konsultime_checked = TRUE) AS konsultime_true
FROM source_registry;
```

Do not run this in production without explicit operator confirmation.

### 6) Run the backend API

```bash
cd backend
npm install
npm run dev
```

Health check:

- `http://localhost:5050/health`

### 6.1) Run the frontend status page

From repo root:

```bash
cd frontend
npm install
npm run dev
```

Open:

- `http://localhost:3000/status`
- `http://localhost:3000/coverage` (admin token required)

Frontend env:

- Copy `frontend/.env.example` to `frontend/.env.local` (optional for local dev).
- Default API base is `http://localhost:5050` via `NEXT_PUBLIC_API_BASE_URL`.

Coverage UI token handling:

- Token is entered manually in the browser.
- Token is kept in memory only (not saved in localStorage/sessionStorage).
- Use the **Clear token** button to drop it from memory.

### 7) Verify health/readiness checks

With backend running (`cd backend && npm run dev`), verify all dependencies:

```bash
curl http://localhost:5050/health
```

Expected (or equivalent explicit fields):

```json
{"ok":true,"db":"ok","redis":"ok","meili":"ok"}
```

Check DB failure behavior (clear error message):

```bash
docker stop tra_postgres
curl http://localhost:5050/health
docker start tra_postgres
```

Expected while Postgres is stopped: HTTP `503` and payload including `db: "error"` plus `errors.db` with the connection/timeout reason.

### 8) Verify public read API (v1 website feed)

List municipalities (should return `total: 61` and 61 items):

```powershell
curl.exe http://localhost:5050/api/municipalities
```

Feed page shape (`ok`, `page`, `limit`, `total`, `items`):

```powershell
curl.exe "http://localhost:5050/api/feed?page=1&limit=5"
```

Feed item linkage fields (additive):
- `attachment_count`
- `primary_attachment_id`
- `primary_attachment_public_url` (relative `/api/public/files/:id`)

Feed filtered by municipality key (example: `tirana`):

```powershell
curl.exe "http://localhost:5050/api/feed?municipality=tirane&limit=5"
```

Feed filtered by municipality + category (all supported categories):

```powershell
curl.exe "http://localhost:5050/api/feed?municipality=tirane&category=Vendime&limit=5"
curl.exe "http://localhost:5050/api/feed?municipality=tirane&category=Prokurime&limit=5"
curl.exe "http://localhost:5050/api/feed?municipality=tirane&category=Konsultime%20publike&limit=5"
```

Feed optional year + sort filters (additive):

```powershell
curl.exe "http://localhost:5050/api/feed?municipality=tirane&category=Vendime&year=2025&sort=newest&limit=5"
curl.exe "http://localhost:5050/api/feed?municipality=tirane&category=Vendime&year=2025&sort=oldest&limit=5"
```

Rules:
- `year` is optional. If provided, only rows with non-null `published_date` in that exact year are returned.
- `sort` is optional and supports `newest|oldest` (default `newest`).

Public search endpoint (`/api/search`) for published items:

```powershell
curl.exe "http://localhost:5050/api/search?q=vendim&limit=10"
curl.exe "http://localhost:5050/api/search?q=prokurim&municipality=tirane&category=Prokurime&year=2025&sort=newest&limit=10"
```

Search query params:
- `q` required, max 120 chars.
- `page` optional (default `1`).
- `limit` optional (default `20`, max `50`).
- `municipality`, `category`, `year`, `sort` optional filters.

Search response item fields include:
- `id`, `title`, `summary`
- `municipality_name`, `municipality_name_key`, `category`
- `published_at`, `collected_at`
- `source_url`, `source_host`
- `attachment_count`, `primary_attachment_id`, `primary_attachment_public_url`

## Sanity checks (quick)

From repo root (PowerShell):

```powershell
docker exec -it tra_postgres psql -U tra -d tra -c "SELECT count(*) FROM municipalities;"
docker exec -it tra_postgres psql -U tra -d tra -c "SELECT count(*) FROM source_registry WHERE is_primary = TRUE;"
```

Expected: both `count = 61`

With backend running:

```powershell
curl.exe "http://localhost:5050/api/feed?municipality=tirane&limit=5"
```

Expected: `ok: true` and `items` non-empty after you run the Tirane scraper.

## Municipality key aliases and normalization

Run the key-alias migration to preserve old municipality slugs:

```powershell
Get-Content -Raw -Encoding UTF8 .\014_municipality_key_aliases.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
```

Audit mojibake candidates (looks for `Ã`/`Â` in `name_sq`, or `[a-z]-[a-z]` in `name_key`):

```bash
cd backend
npm run audit:municipality-keys
```

After you correct `municipalities.name_sq`, use the commented SQL block in `014_municipality_key_aliases.sql` to regenerate clean `name_key` values while preserving legacy keys in `municipality_key_aliases`.

## Security checks

Backend API protections now include:

- Parameterized SQL queries (`$1`, `$2`, ...) for route-side DB access.
- Input validation on `/api/feed` (`page`, `limit`, `municipality`, `q`).
- Basic rate limiting on `/api/*` to reduce abuse bursts.
- Admin-token protection on `/api/scrape/*`, `/api/debug/*`, and `/api/admin/*`.
- Separate admin rate limiting on `/api/admin/*`.

Quick validation checks (should return HTTP 400 with `{"ok":false,"error":"bad_request","message":"..."}`):

```powershell
curl.exe -i "http://localhost:5050/api/feed?page=0"
curl.exe -i "http://localhost:5050/api/feed?limit=999"
curl.exe -i "http://localhost:5050/api/feed?municipality=tirane!!"
curl.exe -i "http://localhost:5050/api/feed?q=   "
curl.exe -i "http://localhost:5050/api/admin/coverage"
```

Admin coverage endpoint checks:

```powershell
curl.exe -i "http://localhost:5050/api/admin/coverage"
curl.exe -i "http://localhost:5050/api/admin/coverage" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Expected:
- without token: HTTP `401`
- with token: HTTP `200` and coverage payload

Coverage payload notes:
- Rows are `(municipality_id, category)` and should be `61 * 3 = 183` in a full local seed.
- `Prokurime` is modeled as a nationwide source in coverage (`registry_url_set=true` without requiring per-municipality `prokurime_url`).
- `last_error_type` and `cooldown_until_utc` are intentionally `null` in coverage rows because these fields are currently municipality-wide, not category-scoped.

Admin publish/check endpoints:

```powershell
curl.exe -i -X POST "http://localhost:5050/api/admin/source/checked?municipality=tirane&category=Vendime&checked=true"
curl.exe -i -X POST "http://localhost:5050/api/admin/source/checked?municipality=tirane&category=Vendime&checked=true" -H "Authorization: Bearer <ADMIN_TOKEN>"
curl.exe -i -X POST "http://localhost:5050/api/admin/publish?municipality=tirane&category=Vendime&year=2025" -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Expected:
- `/api/admin/source/checked` without token: HTTP `401`
- `/api/admin/source/checked` with token: HTTP `200` and `checked=true|false`
- `/api/admin/publish` with token: HTTP `200` and numeric `published_updated`

Admin manual item + file endpoints:

```powershell
curl.exe -i -X POST "http://localhost:5050/api/admin/items/manual" ^
  -H "Authorization: Bearer <ADMIN_TOKEN>" ^
  -H "Content-Type: application/json" ^
  --data "{\"municipality\":\"tirane\",\"category\":\"Vendime\",\"title\":\"Manual source URL item\",\"published_date\":\"2025-01-15\",\"source_url\":\"https://example.org/manual-item.pdf\"}"

curl.exe -i -X POST "http://localhost:5050/api/admin/items/manual" ^
  -H "Authorization: Bearer <ADMIN_TOKEN>" ^
  -F municipality=tirane ^
  -F "category=Vendime" ^
  -F "title=Manual PDF upload item" ^
  -F "published_date=2025-01-15" ^
  -F "file=@vendim-12.pdf;type=application/pdf"
```

File visibility behavior:
- `GET /api/public/files/:id` returns HTTP `404` unless the parent item is `published`.
- `GET /api/admin/files/:id` requires admin token and allows draft/published file retrieval.
- Public endpoint returns strict `404` for non-existent, invalid id, draft, or missing file cases.

Search indexing (script-first):

```bash
node backend/scripts/reindex_public_search.js
node backend/scripts/reindex_public_search.js --dry_run=true
node backend/scripts/reindex_public_search.js --reset=true --batch=500
```

Notes:
- Reindex script reads only `items.status='published'`.
- No admin reindex endpoint is used in v1 (script-first operation).
- Public file URLs in search/feed remain inaccessible until item status is `published`.

Public item detail endpoint:

```powershell
curl.exe -i "http://localhost:5050/api/items/<ITEM_ID>"
```

Expected:
- draft/missing/invalid UUID: HTTP `404`
- published item: HTTP `200` with `item`, `attachments`, `attachment_count`, `primary_attachment_id`, `primary_attachment_public_url`

Admin coverage attachment linkage fields (additive):
- `published_attachment_count`
- `draft_attachment_count`
- `latest_attachment_id`
- `latest_attachment_item_status`
- `latest_admin_file_url`
- `latest_public_file_url` (only when latest attachment item is published)

`POST /api/admin/publish` response now includes additive counters:
- `published_with_attachments`
- `attachments_now_public_count`

Frontend UX (PR6):
- `/` includes global search UI wired to `/api/search`.
- `/municipality/[municipality]` supports category tabs + `year` + `sort` filters.
- Municipality and filter context is reflected in page metadata (SEO).

### 9) Run one end-to-end scraper first (Tirane Vendime)

From `backend/`:

```bash
npm install
npm run scrape:tirane
```

Optional args:

```bash
node scripts/scrape_tirane.js --year=2026 --limit=50 --base=http://localhost:5050 --force-publish=true
```

Expected JSON fields include:

- `ok: true`
- `parsed_rows_total` and `parsed_rows_kept` (both >= 1 when source has rows)
- `inserted` and `skipped`
- `force_publish: true`

Verify feed is non-empty:

```powershell
curl.exe "http://localhost:5050/api/feed?page=1&limit=5"
```

Expected: `total > 0` and `items` is non-empty.

Idempotency check (run twice):

```bash
npm run scrape:tirane
npm run scrape:tirane
```

Expected: second run should not duplicate rows (`inserted` should usually be `0` unless new source items appeared).

Quick vendime parser smoke check (Mat):

```bash
cd backend
node scripts/smoke_scrape_vendime.js --only=mat --limitMunicipalities=1 --shuffle=false
```

Expected: output line for `mat` with `parsed_rows_kept > 0` (reported as the third numeric field).

### 10) Run all 61 Vendime ingestions safely (resumable)

Batch script (sequential, with guardrails + progress file):

- Script: `backend/scripts/run_all_vendime_batch.js`
- Progress file: `backend/tmp/run_all_vendime_progress.json`
- Defaults: `--year=2024 --limit=50 --batch=10 --sleep_ms=800 --resume=true --stop_on_error=true`

PowerShell example (from repo root):

```powershell
$env:ADMIN_TOKEN = "<ADMIN_TOKEN>"
node backend/scripts/run_all_vendime_batch.js --year=2024 --limit=10 --batch=5
```

Resume behavior:

- If a municipality is already `ok` in progress for the same `year+limit`, it is skipped.
- If a municipality is `error`, it is retried on the next run.
- Set `--resume=false` to ignore previous progress and run all municipalities again.
- If `--stop_on_error=true`, the script stops immediately on first failure and keeps progress on disk.

Vendime nationwide runner (single `next_offset` resume pointer):

```bash
node backend/scripts/run_vendime_nationwide.js --year=2025 --limit=80 --sleep_ms=1200 --max_runtime_ms=0 --resume=true
```

How it works:

- Calls `POST /api/scrape/run?category=Vendime&year=YYYY&offset=...&limit=...`.
- Uses `next_offset` from API response as the single authoritative resume pointer.
- Writes progress to `backend/tmp/vendime_progress_YYYY.json`.
- If HTTP `429` is returned, retries the same offset with exponential backoff.
- Supports compatibility alias `--start_offset=...` (same as `--offset=...`).
- When `--year` is provided, scrape responses include strict year-gating counters:
  - `skipped_missing_date`
  - `skipped_wrong_year`

Konsultime nationwide runner (single `next_offset` resume pointer):

```bash
node backend/scripts/run_konsultime_nationwide.js --year=2025 --limit=80 --sleep_ms=1200 --max_runtime_ms=0 --resume=true --max_timeouts=10
```

How it works:

- Calls `POST /api/scrape/run?category=Konsultime%20publike&year=YYYY&offset=...&limit=...`.
- Uses `next_offset` from API response as the authoritative resume pointer.
- Writes progress to `backend/tmp/konsultime_progress_YYYY.json`.
- If HTTP `429` is returned, retries the same offset with exponential backoff.
- Timeout-like failures (`HTTP 504`, timeout messages, or `ETIMEDOUT`/`ECONNRESET`/`EAI_AGAIN`) retry the same offset up to 3 times with fixed backoff: `5s`, `15s`, `45s`.
- If timeout retries are exhausted, the runner records timeout telemetry, advances `next_offset` by `+1` (skip one municipality), persists progress, and continues.
- Cloudflare/bot-block failures (`HTTP 403` / `HTTP_403`) are treated as soft-skips: runner records blocked telemetry, advances `next_offset` by `+1`, persists progress, and continues.
- `--max_timeouts` (default `10`) caps timeout skips per invocation; on cap hit, runner stops cleanly after persisting `next_offset`.
- Blocked skips do not count toward `--max_timeouts`.
- Supports compatibility alias `--start_offset=...` (same as `--offset=...`).
- Year-mode responses include strict counters:
  - `skipped_missing_date`
  - `skipped_wrong_year`
- Existing no-year source policy remains unchanged in `/api/scrape/run` for Konsultime.

Konsultime extraction notes (v1 improvements):
- Listing extraction now covers WordPress/category pagination, table/registry rows, and mixed HTML post listings.
- Mixed-page candidates are kept only when Konsultime-focused keywords match (`konsultim`, `degjes`, `projekt`, `draft`, `plan`, `strategji`, `buxhet`, `pba`, `pyetesor`, `anket`, `koment`).
- No-year policy remains authoritative in `/api/scrape/run`:
  - same-host HTML is allowed,
  - external PDFs are only allowed when the referrer/source page is municipality-host.
- Year mode remains strict: rows with missing date are counted in `skipped_missing_date`; out-of-year rows are counted in `skipped_wrong_year`.
- Optional debug mode:
  - call `/api/scrape/run?...&debug=true`
  - response adds `debug.used_url` and `debug.kept_titles_sample` (up to first 3 kept titles).
  - when fallback discovery is used, response also includes `debug.fallback_used_urls`.

Registry category batch runner (Vendime / Prokurime / Konsultime):

```bash
cd backend
npm run run:batch:registry -- --category="Konsultime publike" --year=2025 --limit=20 --batch=5
```

Shortcut for Konsultime:

```bash
cd backend
npm run run:batch:konsultime -- --year=2025 --limit=20 --batch=5
```

Manual localhost test with `curl.exe`:

```powershell
curl.exe -X POST "http://localhost:5050/api/scrape/run?municipality=belsh&category=Vendime&year=2024&limit=10" -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Accept: application/json"
```

Additional category smoke tests (`/api/scrape/run`):

```powershell
curl.exe -X POST "http://localhost:5050/api/scrape/run?municipality=tirane&category=Prokurime&year=2024&limit=10" -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Accept: application/json"
curl.exe -X POST "http://localhost:5050/api/scrape/run?municipality=tirane&category=Konsultime%20publike&year=2024&limit=10" -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Accept: application/json"
```

Prokurime v1 scope:

- Baseline source is APP annual export CSV discovered from APP export pages:
  - `https://www.app.gov.al/eksportimi-i-procedurave-te-publikuara/`
  - fallback: `https://www.app.gov.al/export-public-calls/`
- Municipality matching is conservative (`Bashkia <X>` / `Municipality of <X>`). Unclear rows are skipped and counted in `skipped_no_municipality_match`.

### Finish Prokurime baseline (nationwide, resumable)

Use the dedicated nationwide runner (local only; do not run in CI):

```bash
node backend/scripts/run_prokurime_nationwide.js --year=2024 --limit=500 --sleep_ms=1500 --max_runtime_ms=0 --resume=true
```

How it works:

- Calls `POST /api/scrape/run?category=Prokurime&year=YYYY&offset=...&limit=...` on `http://localhost:5050` by default with `Authorization: Bearer <ADMIN_TOKEN>`.
- Writes chunk progress to `backend/tmp/prokurime_progress_YYYY.json` after every chunk.
- Standardized runner flags:
  - `--year=YYYY`
  - `--limit=...`
  - `--sleep_ms=...`
  - `--max_runtime_ms=...` (`0` means no runtime cap)
  - `--resume=true|false`
- Compatibility alias kept: `--start_offset=...` (maps to initial offset override). You can also use `--offset=...`.
- Sleeps between successful chunks (`--sleep_ms`, default `1500`) to self-throttle nationwide runs.
- If the API returns HTTP `429`, the runner retries the same offset automatically with exponential backoff (capped at `60s`).
- Optional base URL override: set `API_BASE` (or `SMOKE_BASE_URL`) before running if your local API is not on the default host/port.
- Resume automatically: rerun the same command with `--resume=true` and it continues from `next_offset` in the progress file.
- If a chunk times out or is too heavy, reduce `--limit` (for example `--limit=200`) and rerun.
- The run completes when `next_offset` becomes `null`.

Progress schema (`backend/tmp/prokurime_progress_YYYY.json`):

```json
{
  "year": 2025,
  "mode": "nationwide",
  "next_offset": 1200,
  "total_seen": 0,
  "total_inserted": 0,
  "total_skipped": 0,
  "last_ok_utc": "2026-02-23T12:34:56.000Z",
  "last_error": {
    "type": "HTTP_429",
    "message": "Too many scrape requests, please try again later.",
    "at_utc": "2026-02-23T12:35:12.000Z"
  }
}
```

Offline parser test (fixtures only):

```bash
cd backend
npm run test:prokurime-app
```

Expected response counters for year-filtered runs:
- `skipped_missing_date`
- `skipped_wrong_year`
- `skipped_no_municipality_match` (Prokurime)

Category-scoped CHECKED backfill script (operator-run, explicit scope):

```bash
node backend/scripts/backfill_checked_scope.js --category=Vendime --dry_run=true
node backend/scripts/backfill_checked_scope.js --category=Vendime
```

Notes:
- Backfills only one selected category at a time (`Vendime`, `Prokurime`, `Konsultime publike`).
- Uses legacy `verification_status='CHECKED'` intent only for the selected category.
- Does not set all three category flags automatically.

## Next “must do” items for a public-ready v1

- Make ingestion robust across municipalities (Playwright-first, retries, cooldowns).
- Expand beyond Vendime → Prokurime + Konsultime.
- Index into Meilisearch (search UX).
- Add the public website (planned: Next.js + Tailwind) and connect it to the API.
- Production deploy notes (DNS/domain → hosting → monitoring).

## Vendime URL discovery workflow

From `backend/`:

```bash
npm run discover:vendime
```

Optional scope (single municipality by canonical `name_key`, or `all`):

```bash
npm run discover:vendime -- tirane
npm run discover:vendime -- all
```

This writes `backend/tmp/vendime_discovery.json` and prints ranked suggestions to stdout.
Discovery does not write to `source_registry`.

After manual review, set `confirmed: true` on records you want to apply (optionally set `selected_vendime_url`), then run:

```bash
npm run apply:vendime
```

`apply:vendime` only updates confirmed entries and only when `source_registry.vendime_url` is currently null/blank.
It sets:
- `vendime_url`
- `last_error_type = NULL`
- `homepage_status = 'OK'`
- `cooldown_until_utc = NULL`
- `updated_at = now()`

It does not set `verification_status` to `CHECKED`.

## Konsultime URL discovery workflow

From `backend/`:

```bash
npm run discover:konsultime
```

This writes `backend/tmp/konsultime_discovery.json` with a review-first shape:

```json
{
  "generated_at": "...",
  "candidates": [
    {
      "name_key": "tirane",
      "base_url": "https://tirana.al/",
      "best_url": "https://tirana.al/...",
      "score": 123,
      "evidence": ["..."],
      "confirmed": false
    }
  ]
}
```

Notes:
- Discovery only targets municipalities where `source_registry.konsultime_url` is null/blank.
- Discovery does not write to `source_registry`.
- Candidate pages are constrained to same-host HTML pages (document links are not chosen as `best_url`).

After review, set `confirmed: true` for rows to apply (optional override fields: `selected_konsultime_url` or `selected_url`), then run:

```bash
npm run apply:konsultime
```

`apply:konsultime` applies only confirmed rows and only when `source_registry.konsultime_url` is still null/blank.
It sets:
- `konsultime_url`
- `last_error_type = NULL`
- `cooldown_until_utc = NULL`
- `final_url = NULL`
- `homepage_status = 'OK'`
- `updated_at = now()`

It does not change `konsultime_checked`.
