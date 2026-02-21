
# Transparency Radar Albania

Full-stack transparency platform for Albania: scrapers + API + database + public site to collect and publish municipal documents across all **61 municipalities**.

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

Frontend env:

- Copy `frontend/.env.example` to `frontend/.env.local` (optional for local dev).
- Default API base is `http://localhost:5050` via `NEXT_PUBLIC_API_BASE_URL`.

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

Feed filtered by municipality key (example: `tirana`):

```powershell
curl.exe "http://localhost:5050/api/feed?municipality=tirane&limit=5"
```

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

Quick validation checks (should return HTTP 400 with `{"ok":false,"error":"bad_request","message":"..."}`):

```powershell
curl.exe -i "http://localhost:5050/api/feed?page=0"
curl.exe -i "http://localhost:5050/api/feed?limit=999"
curl.exe -i "http://localhost:5050/api/feed?municipality=tirane!!"
curl.exe -i "http://localhost:5050/api/feed?q=   "
```

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

Manual localhost test with `curl.exe`:

```powershell
curl.exe -X POST "http://localhost:5050/api/scrape/run?municipality=belsh&category=Vendime&year=2024&limit=10" -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Accept: application/json"
```

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
