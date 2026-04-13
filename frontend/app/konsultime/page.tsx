import type { Metadata } from "next";
import Link from "next/link";
import { buildOpenGraph, buildPageTitle } from "../metadata";

type QueryMap = Record<string, string | string[] | undefined>;

type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  municipality_name: string;
  published_at: string | null;
  collected_at: string | null;
  attachment_count: number;
  primary_attachment_id: string | null;
  primary_attachment_public_url: string | null;
};

type FeedResponse = {
  ok: boolean;
  total: number;
  items: FeedItem[];
};

type MunicipalityApiItem = {
  id: string;
  name_sq: string;
  name_key: string;
  county: string | null;
};

type MunicipalityOption = {
  name_key: string;
  name_sq: string;
};

type MunicipalitiesResponse = {
  ok: boolean;
  total: number;
  items: MunicipalityApiItem[];
};

function firstValue(params: QueryMap, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function normalizeMunicipality(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeSort(input: string | null | undefined): "newest" | "oldest" {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "oldest") return "oldest";
  return "newest";
}

function normalizeYear(input: string | null | undefined): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (!/^\d{4}$/.test(raw)) return "";
  const year = Number.parseInt(raw, 10);
  if (year < 2000 || year > 2100) return "";
  return String(year);
}

function formatDate(value: string | null): string {
  if (!value) return "Pa date";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function sourceHostFromUrl(urlValue: string | null): string {
  const raw = String(urlValue || "").trim();
  if (!raw) return "source unavailable";
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "source unavailable";
  }
}

function toAbsoluteApiUrl(relativePath: string | null): string | null {
  if (!relativePath) return null;
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  try {
    return new URL(relativePath, `${apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return null;
  }
}

async function getKonsultimeFeed(options: {
  municipality: string;
  year: string;
  sort: "newest" | "oldest";
}): Promise<{
  data: FeedResponse | null;
  error: string | null;
}> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/feed`);
  url.searchParams.set("category", "Konsultime publike");
  url.searchParams.set("limit", "30");
  url.searchParams.set("sort", options.sort);
  if (options.municipality) {
    url.searchParams.set("municipality", options.municipality);
  }
  if (options.year) {
    url.searchParams.set("year", options.year);
  }

  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      return { data: null, error: `Backend returned HTTP ${response.status}` };
    }
    const json = (await response.json()) as FeedResponse;
    return { data: json, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Failed to load konsultime feed",
    };
  }
}

async function getMunicipalityOptions(): Promise<{
  items: MunicipalityOption[];
  error: string | null;
}> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/municipalities`;

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { items: [], error: `Municipality list returned HTTP ${response.status}` };
    }

    const json = (await response.json()) as MunicipalitiesResponse;
    if (!json?.ok || !Array.isArray(json.items)) {
      return { items: [], error: "Municipality list returned invalid payload" };
    }

    const items = json.items
      .map((item) => ({
        name_key: normalizeMunicipality(item.name_key),
        name_sq: String(item.name_sq || "").trim(),
      }))
      .filter((item) => item.name_key && item.name_sq);

    return { items, error: null };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : "Municipality list request failed",
    };
  }
}

function buildMetadataCopy(municipality: string, year: string) {
  const segments = ["Konsultime Publike"];
  if (municipality) segments.push(municipality);
  if (year) segments.push(year);

  const titleCore = segments.join(" ");
  const description = municipality
    ? `Konsultimet publike të publikuara për ${municipality}${year ? ` në ${year}` : ""}.`
    : `Konsultimet publike nga të gjitha bashkitë${year ? ` në ${year}` : ""}.`;

  return { titleCore, description };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}): Promise<Metadata> {
  const query = await searchParams;
  const municipality = normalizeMunicipality(firstValue(query, "municipality"));
  const year = normalizeYear(firstValue(query, "year"));
  const sort = normalizeSort(firstValue(query, "sort"));

  const canonicalQuery = new URLSearchParams();
  if (municipality) canonicalQuery.set("municipality", municipality);
  if (year) canonicalQuery.set("year", year);
  if (sort !== "newest") canonicalQuery.set("sort", sort);

  const canonical = canonicalQuery.toString()
    ? `/konsultime?${canonicalQuery.toString()}`
    : "/konsultime";
  const { titleCore, description } = buildMetadataCopy(municipality, year);
  const title = buildPageTitle(titleCore);

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      ...buildOpenGraph({
        title,
        description,
      }),
      url: canonical,
    },
  };
}

export default async function KonsultimePage({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}) {
  const query = await searchParams;
  const selectedMunicipality = normalizeMunicipality(firstValue(query, "municipality"));
  const selectedYear = normalizeYear(firstValue(query, "year"));
  const selectedSort = normalizeSort(firstValue(query, "sort"));

  const [{ data, error }, { items: municipalities, error: municipalitiesError }] = await Promise.all([
    getKonsultimeFeed({
      municipality: selectedMunicipality,
      year: selectedYear,
      sort: selectedSort,
    }),
    getMunicipalityOptions(),
  ]);

  return (
    <main className="mx-auto w-full max-w-5xl p-4 pb-10 sm:p-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Konsultime Publike
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Konsultime Publike</h1>
        <p className="mt-2 text-sm text-slate-600">
          Konsultimet publike nga të gjitha bashkitë e Shqipërisë.
        </p>

        <form method="GET" className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs font-medium text-slate-600">
            Bashkia
            <select
              name="municipality"
              defaultValue={selectedMunicipality}
              className="mt-1 min-w-52 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
            >
              <option value="">Të gjitha bashkitë</option>
              {municipalities.map((item) => (
                <option key={item.name_key} value={item.name_key}>
                  {item.name_sq}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-600">
            Viti
            <input
              type="number"
              name="year"
              min={2000}
              max={2100}
              defaultValue={selectedYear}
              placeholder="YYYY"
              className="mt-1 w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
            />
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-600">
            Rendit
            <select
              name="sort"
              defaultValue={selectedSort}
              className="mt-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
            >
              <option value="newest">Më të rejat</option>
              <option value="oldest">Më të vjetrat</option>
            </select>
          </label>
          <button
            type="submit"
            className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
          >
            Apliko
          </button>
          <Link
            href="/konsultime?sort=newest"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
          >
            Pastro filtrat
          </Link>
        </form>

        {municipalitiesError ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {municipalitiesError}
          </p>
        ) : null}
        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">Gjithsej: {data?.total || 0}</p>
        <ul className="mt-4 space-y-3">
          {(data?.items || []).map((item) => {
            const publicFileUrl = toAbsoluteApiUrl(item.primary_attachment_public_url);
            return (
              <li key={item.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span>{formatDate(item.published_at || item.collected_at)}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5">{item.category}</span>
                  <span>{item.municipality_name}</span>
                  <span>{sourceHostFromUrl(item.source_url)}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">{item.title}</p>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  {item.source_url ? (
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-700 underline"
                    >
                      Burimi
                    </a>
                  ) : null}
                  {publicFileUrl ? (
                    <a
                      href={publicFileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-emerald-700 underline"
                    >
                      PDF Publik
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {(data?.items || []).length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">Nuk ka dokumente të publikuara për këto filtra.</p>
        ) : null}
      </section>
    </main>
  );
}
