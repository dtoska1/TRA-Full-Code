import Link from "next/link";
import MunicipalityFeedCta from "./components/municipality-feed-cta";
import ProkurimeSpendCard from "./components/prokurime-spend-card";

const SEARCH_CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"] as const;
const SORT_OPTIONS = ["newest", "oldest"] as const;

type QueryMap = Record<string, string | string[] | undefined>;

type SearchItem = {
  id: string;
  title: string;
  summary: string | null;
  municipality_name: string | null;
  municipality_name_key: string | null;
  category: string | null;
  published_at: string | null;
  collected_at: string | null;
  source_url: string | null;
  source_host: string | null;
  attachment_count: number;
  primary_attachment_id: string | null;
  primary_attachment_public_url: string | null;
};

type SearchResponse = {
  ok: boolean;
  q: string;
  page: number;
  limit: number;
  total: number;
  items: SearchItem[];
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

type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  municipality_name: string | null;
  published_at: string | null;
  collected_at: string | null;
};

type FeedResponse = {
  ok: boolean;
  total: number;
  items: FeedItem[];
};

function firstValue(params: QueryMap, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function normalizeCategory(value: string): string {
  const cleaned = value.trim();
  if (SEARCH_CATEGORIES.includes(cleaned as (typeof SEARCH_CATEGORIES)[number])) return cleaned;
  return "";
}

function normalizeSort(value: string): "newest" | "oldest" {
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "oldest") return "oldest";
  return "newest";
}

function normalizeYear(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return "";
  if (!/^\d{4}$/.test(cleaned)) return "";
  const year = Number.parseInt(cleaned, 10);
  if (year < 2000 || year > 2100) return "";
  return String(year);
}

function formatDate(value: string | null): string {
  if (!value) return "Pa date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
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

async function searchPublishedItems(filters: {
  q: string;
  category: string;
  municipality: string;
  year: string;
  sort: "newest" | "oldest";
}): Promise<{ data: SearchResponse | null; error: string | null }> {
  if (!filters.q.trim()) {
    return { data: null, error: null };
  }

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/search`);
  url.searchParams.set("q", filters.q.trim());
  url.searchParams.set("limit", "20");
  url.searchParams.set("sort", filters.sort);
  if (filters.category) url.searchParams.set("category", filters.category);
  if (filters.municipality) url.searchParams.set("municipality", filters.municipality);
  if (filters.year) url.searchParams.set("year", filters.year);

  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      return { data: null, error: `Search returned HTTP ${response.status}` };
    }
    const json = (await response.json()) as SearchResponse;
    return { data: json, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Search request failed",
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
        name_key: String(item.name_key || "").trim().toLowerCase(),
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

async function getLatestItems(): Promise<{ items: FeedItem[]; error: string | null }> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/feed`);
  url.searchParams.set("limit", "10");
  url.searchParams.set("sort", "newest");

  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      return { items: [], error: `Feed returned HTTP ${response.status}` };
    }
    const json = (await response.json()) as FeedResponse;
    return { items: json?.items || [], error: null };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : "Feed request failed",
    };
  }
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}) {
  const params = await searchParams;
  const q = firstValue(params, "q").trim();
  const category = normalizeCategory(firstValue(params, "category"));
  const municipality = firstValue(params, "municipality").trim().toLowerCase();
  const year = normalizeYear(firstValue(params, "year"));
  const sort = normalizeSort(firstValue(params, "sort"));
  const selectedFeedCategory = (category ||
    "Vendime") as "Vendime" | "Prokurime" | "Konsultime publike";
  const { data, error } = await searchPublishedItems({
    q,
    category,
    municipality,
    year,
    sort,
  });
  const { items: municipalities } = await getMunicipalityOptions();
  const { items: latestItems } = await getLatestItems();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 pb-10 sm:p-6">
      <ProkurimeSpendCard municipalities={municipalities} />

      <section className="w-full rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Transparency Radar Albania
        </p>
        <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-900">
          Kërko Dokumente Bashkiake
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Shfleto Vendime, Prokurime dhe Konsultime nga të gjitha bashkitë.
        </p>

        <form method="GET" className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="Kërko titull ose përmbledhje"
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            name="municipality"
            defaultValue={municipality}
            placeholder="Bashkia (p.sh. tirane)"
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            name="category"
            defaultValue={category}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Të gjitha kategoritë</option>
            {SEARCH_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input
            type="number"
            name="year"
            min={2000}
            max={2100}
            defaultValue={year}
            placeholder="Viti (opsional)"
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            name="sort"
            defaultValue={sort}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            {SORT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value === "newest" ? "Më të rejat" : "Më të vjetrat"}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
          >
            Kërko
          </button>
        </form>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link
            href="/status"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-slate-50 px-5 py-3 text-base font-medium text-slate-700"
          >
            Statusi Publik
          </Link>
          {municipalities.length > 0 ? (
            <MunicipalityFeedCta
              municipalities={municipalities}
              defaultMunicipality={municipality}
              selectedCategory={selectedFeedCategory}
            />
          ) : (
            <Link
              href="/municipality/tirane?category=Vendime"
              className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-slate-50 px-5 py-3 text-base font-medium text-slate-700"
            >
              Njoftimet e Bashkisë
            </Link>
          )}
          <Link
            href="/coverage"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-slate-50 px-5 py-3 text-base font-medium text-slate-700"
          >
            Admin Coverage
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Të fundit</h2>
        {latestItems.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">Nuk ka të dhëna.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {latestItems.map((item) => (
              <li key={item.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span>{formatDate(item.published_at || item.collected_at)}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5">{item.category}</span>
                  <span>{item.municipality_name || ""}</span>
                </div>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {item.source_url ? (
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-700 underline"
                    >
                      {item.title}
                    </a>
                  ) : (
                    item.title
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-900">Rreth Platformës</h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700">
          <p>
            <strong>Qasje e përmirësuar në informacionin publik.</strong> Qytetarët, organizatat e shoqërisë civile dhe gazetarët mund të përdorin një platformë të vetme për të ndjekur vendimet bashkiake, të dhënat e prokurimit dhe konsultimet në të gjithë Shqipërinë.
          </p>
          <p>
            <strong>Demokraci dixhitale në veprim.</strong> Transparency Radar Albania shndërron informacionin e fragmentuar publik në të dhëna të aksesueshme dhe të veprueshme, që mbështesin pjesëmarrjen në qeverisjen lokale dhe llogaridhënien.
          </p>
        </div>
      </section>

      {error ? (
        <section className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </section>
      ) : null}

      {q ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-600">Rezultate: {data?.total || 0}</p>
          <ul className="mt-4 space-y-3">
            {(data?.items || []).map((item) => {
              const publicFileUrl = toAbsoluteApiUrl(item.primary_attachment_public_url);
              return (
                <li key={item.id} className="rounded-xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span>{formatDate(item.published_at || item.collected_at)}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">{item.category || "Unknown"}</span>
                    <span>{item.municipality_name || item.municipality_name_key || "Unknown municipality"}</span>
                    <span>{item.source_host || "source unavailable"}</span>
                  </div>
                  <p className="mt-2 text-base font-semibold text-slate-900">{item.title}</p>
                  {item.summary ? <p className="mt-1 text-sm text-slate-600">{item.summary}</p> : null}
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
            <p className="mt-4 text-sm text-slate-500">Nuk u gjetën rezultate për këtë kërkim.</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
