import Link from "next/link";
import MunicipalityFeedCta from "./components/municipality-feed-cta";
import ProkurimeSpendCard from "./components/prokurime-spend-card";
import TeFunditList from "./components/te-fundit-list";

const SEARCH_CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"] as const;

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

function categoryBadgeClass(category: string): string {
  if (category === "Prokurime") return "bg-amber-100 text-amber-800";
  if (category === "Konsultime publike") return "bg-green-100 text-green-800";
  return "bg-blue-100 text-blue-800";
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
  url.searchParams.set("limit", "20");
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

  const [{ data, error }, { items: municipalities }, { items: latestItems }] =
    await Promise.all([
      searchPublishedItems({ q, category, municipality, year, sort }),
      getMunicipalityOptions(),
      getLatestItems(),
    ]);

  return (
    <div className="min-h-screen bg-slate-50">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 pb-10 sm:p-6">

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

          {/* Left column: hero + Shpenzime Prokurimi */}
          <div className="flex flex-col gap-6 lg:col-span-2">

            {/* Hero + Search */}
            <section className="w-full rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
              <h1 className="font-serif text-4xl font-bold leading-tight text-slate-900 sm:text-5xl">
                Vendime. Prokurime. Konsultime.
              </h1>
              <p className="mt-2 text-base text-slate-600">
                Çdo bashki. Çdo vit. Çdo dokument publik — në një vend.
              </p>

              <form method="GET" className="mt-6 flex flex-col gap-3">
                <input type="hidden" name="sort" value="newest" />
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Kërko
                  <div className="flex gap-2">
                    <input
                      type="text"
                      name="q"
                      id="q"
                      defaultValue={q}
                      placeholder="Kërko titull ose përmbledhje"
                      className="flex-1 rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      type="submit"
                      className="rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                    >
                      Kërko
                    </button>
                  </div>
                </label>
                <div className="mt-2">
                  <input
                    type="number"
                    name="year"
                    id="year"
                    min={2000}
                    max={2100}
                    defaultValue={year}
                    placeholder="Filtro sipas vitit (opsional)"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-700"
                  />
                </div>
              </form>

              <div className="mt-4 flex flex-wrap gap-2">
                <a
                  href="/?category=Vendime"
                  className="rounded-full border border-blue-200 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50"
                >
                  Vendime
                </a>
                <a
                  href="/?category=Prokurime"
                  className="rounded-full border border-blue-200 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50"
                >
                  Prokurime
                </a>
                <a
                  href="/?category=Konsultime+publike"
                  className="rounded-full border border-blue-200 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50"
                >
                  Konsultime
                </a>
              </div>

              <nav
                aria-label="Navigim kryesor"
                className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200 pt-4"
              >
                <Link href="/status" className="text-sm text-blue-700 underline">
                  Statusi Publik
                </Link>
                <Link
                  href="/coverage"
                  className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-700"
                  title="Admin Coverage"
                >
                  🔒
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
                    className="text-sm text-blue-700 underline"
                  >
                    Njoftimet e Bashkisë
                  </Link>
                )}
              </nav>
            </section>

            {/* Shpenzime Prokurimi */}
            <section className="w-full rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
              <h2 className="border-l-4 border-blue-600 pl-3 text-lg font-semibold text-slate-900">
                Shpenzime Prokurimi
              </h2>
              <div className="mt-4">
                <ProkurimeSpendCard municipalities={municipalities} />
              </div>
            </section>

          </div>

          {/* Right column: Të fundit sidebar */}
          <div className="lg:col-span-1">
            <section className="w-full rounded-2xl border border-slate-200 bg-white p-5 lg:sticky lg:top-4">
              <h2 className="border-l-4 border-blue-600 pl-3 text-lg font-semibold text-slate-900">
                Të fundit
              </h2>
              <TeFunditList items={latestItems} />
            </section>
          </div>

        </div>

        {/* Rreth Platformës — full width */}
        <section className="w-full rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
          <h2 className="border-l-4 border-blue-600 pl-3 text-lg font-semibold text-slate-900">
            Rreth Platformës
          </h2>
          <div className="mt-4 space-y-3 text-sm text-slate-600">
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
          <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
            <h2 className="border-l-4 border-blue-600 pl-3 text-lg font-semibold text-slate-900">
              Rezultate kërkimi
            </h2>
            <p className="mt-3 text-sm text-slate-500">Rezultate: {data?.total || 0}</p>
            <ul className="mt-4 space-y-3">
              {(data?.items || []).map((item) => {
                const publicFileUrl = toAbsoluteApiUrl(item.primary_attachment_public_url);
                return (
                  <li key={item.id} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{formatDate(item.published_at || item.collected_at)}</span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${categoryBadgeClass(item.category || "")}`}
                      >
                        {item.category || "E panjohur"}
                      </span>
                      <span>{item.municipality_name || item.municipality_name_key || "Bashki e panjohur"}</span>
                      <span>{item.source_host || "burim i panjohur"}</span>
                    </div>
                    <p className="mt-2 text-base font-semibold text-slate-900">{item.title}</p>
                    {item.summary ? (
                      <p className="mt-1 text-sm text-slate-600">{item.summary}</p>
                    ) : null}
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
                          className="font-medium text-blue-700 underline"
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
    </div>
  );
}
