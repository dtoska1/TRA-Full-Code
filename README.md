
# Transparency Radar Albania

Full-stack transparency platform for Albania: scrapers + API + database + public site to collect and publish municipal documents across all **61 municipalities**.

## Repo layout

- `backend/` – Node/Express API + scrapers
- `docs/` – project context & requirements
- `docker-compose.yml` – local Postgres + Redis + Meilisearch (**localhost-only**)
- `00x_*.sql` – DB init/hardening/views/seed scripts (run in order)

## Quick start (local dev)

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
```

> Note (Windows/PowerShell): `< file.sql` redirection is not reliable. Use `Get-Content -Raw ... | docker exec -i ...` instead.

### 3) Seed municipalities (must be 61)

```powershell
Get-Content -Raw -Encoding UTF8 .\005_seed_municipalities.sql | docker exec -i tra_postgres psql -U tra -d tra -v ON_ERROR_STOP=1
docker exec -it tra_postgres psql -U tra -d tra -c "SELECT count(*) FROM municipalities;"
```

Expected: `count = 61`

⚠️ `schema_verification_check.sql` inserts test rows into `municipalities`. Run it only on a scratch DB if you want the municipality set to remain exactly 61.

### 4) Configure backend env

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

### 5) Run the backend API

```bash
cd backend
npm install
npm run dev
```

Health check:

- `http://localhost:5050/health`

### 6) Verify health/readiness checks

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

### 7) Verify public read API (v1 website feed)

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

### 8) Run one end-to-end scraper first (Tirane Vendime)

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

## Next “must do” items for a public-ready v1

- Make ingestion robust across municipalities (Playwright-first, retries, cooldowns).
- Expand beyond Vendime → Prokurime + Konsultime.
- Index into Meilisearch (search UX).
- Add the public website (planned: Next.js + Tailwind) and connect it to the API.
- Production deploy notes (DNS/domain → hosting → monitoring).
