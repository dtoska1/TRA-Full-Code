import Link from "next/link";

const CATEGORY_TABS = [
  { value: "Vendime", label: "Vendime" },
  { value: "Prokurime", label: "Prokurime" },
  { value: "Konsultime publike", label: "Konsultime" },
] as const;

type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  published_at: string | null;
};

type FeedResponse = {
  ok: boolean;
  total: number;
  items: FeedItem[];
};

function normalizeCategory(input: string | null | undefined): (typeof CATEGORY_TABS)[number]["value"] {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "prokurime") return "Prokurime";
  if (raw === "konsultime publike" || raw === "konsultime-publike") return "Konsultime publike";
  return "Vendime";
}

function formatDate(value: string | null): string {
  if (!value) return "Pa date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

async function getMunicipalityFeed(municipality: string, category: string): Promise<{
  data: FeedResponse | null;
  error: string | null;
}> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/feed`);
  url.searchParams.set("municipality", municipality);
  url.searchParams.set("category", category);
  url.searchParams.set("limit", "20");

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
      error: error instanceof Error ? error.message : "Failed to load municipality feed",
    };
  }
}

export default async function MunicipalityPage({
  params,
  searchParams,
}: {
  params: { municipality: string };
  searchParams?: { category?: string };
}) {
  const municipality = String(params.municipality || "").trim().toLowerCase();
  const selectedCategory = normalizeCategory(searchParams?.category);
  const { data, error } = await getMunicipalityFeed(municipality, selectedCategory);

  return (
    <main className="mx-auto w-full max-w-5xl p-4 pb-10 sm:p-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Municipality Feed</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{municipality}</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          {CATEGORY_TABS.map((tab) => {
            const isActive = tab.value === selectedCategory;
            return (
              <Link
                key={tab.value}
                href={`/municipality/${encodeURIComponent(municipality)}?category=${encodeURIComponent(tab.value)}`}
                className={
                  isActive
                    ? "rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white"
                    : "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
                }
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-sm text-slate-600">Total: {data?.total || 0}</p>
        <ul className="mt-4 space-y-3">
          {(data?.items || []).map((item) => (
            <li key={item.id} className="rounded-xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500">{formatDate(item.published_at)}</p>
              {item.source_url ? (
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 block text-sm font-medium text-blue-700 underline"
                >
                  {item.title}
                </a>
              ) : (
                <p className="mt-1 text-sm font-medium text-slate-900">{item.title}</p>
              )}
            </li>
          ))}
        </ul>
        {(data?.items || []).length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No published items for this category yet.</p>
        ) : null}
      </section>
    </main>
  );
}
