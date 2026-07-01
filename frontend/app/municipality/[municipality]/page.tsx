import type { Metadata } from "next";
import Link from "next/link";
import { buildPageTitle } from "../../metadata";

const CATEGORY_TABS = [
  { value: "Vendime", label: "Vendime" },
  { value: "Prokurime", label: "Prokurime" },
  { value: "Konsultime publike", label: "Konsultime" },
] as const;

type QueryMap = Record<string, string | string[] | undefined>;

type FeedAttachment = {
  id: string;
  file_name: string | null;
  mime_type?: string | null;
  size_bytes?: number;
  created_at?: string | null;
  public_file_url: string | null;
};

type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  municipality_name: string;
  published_at: string | null;
  collected_at: string | null;
  attachment_count: number;
  attachments?: FeedAttachment[];
  primary_attachment_id: string | null;
  primary_attachment_public_url: string | null;
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

function normalizeCategory(input: string | null | undefined): (typeof CATEGORY_TABS)[number]["value"] {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "prokurime") return "Prokurime";
  if (raw === "konsultime publike" || raw === "konsultime-publike") return "Konsultime publike";
  return "Vendime";
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

function attachmentLabel(attachment: FeedAttachment, index: number): string {
  const fileName = String(attachment.file_name || "").trim();
  if (fileName) return fileName;
  return `Dokument ${index + 1}`;
}

async function getMunicipalityFeed(options: {
  municipality: string;
  category: string;
  year: string;
  sort: "newest" | "oldest";
}): Promise<{
  data: FeedResponse | null;
  error: string | null;
}> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/feed`);
  url.searchParams.set("municipality", options.municipality);
  url.searchParams.set("category", options.category);
  url.searchParams.set("limit", "30");
  url.searchParams.set("sort", options.sort);
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
      error: error instanceof Error ? error.message : "Failed to load municipality feed",
    };
  }
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ municipality: string }>;
  searchParams: Promise<QueryMap>;
}): Promise<Metadata> {
  const routeParams = await params;
  const query = await searchParams;
  const municipality = String(routeParams.municipality || "").trim().toLowerCase();
  const category = normalizeCategory(firstValue(query, "category"));
  const year = normalizeYear(firstValue(query, "year"));

  const titleCore = year
    ? `${municipality} ${category} ${year}`
    : `${municipality} ${category}`;
  const canonicalQuery = new URLSearchParams();
  canonicalQuery.set("category", category);
  if (year) canonicalQuery.set("year", year);
  const canonical = `/municipality/${encodeURIComponent(municipality)}?${canonicalQuery.toString()}`;

  return {
    title: buildPageTitle(titleCore),
    description: `Published ${category} documents for ${municipality}${year ? ` in ${year}` : ""}.`,
    alternates: {
      canonical,
    },
    openGraph: {
      title: buildPageTitle(titleCore),
      description: `Published ${category} documents for ${municipality}${year ? ` in ${year}` : ""}.`,
      url: canonical,
    },
  };
}

export default async function MunicipalityPage({
  params,
  searchParams,
}: {
  params: Promise<{ municipality: string }>;
  searchParams: Promise<QueryMap>;
}) {
  const routeParams = await params;
  const query = await searchParams;

  const municipality = String(routeParams.municipality || "").trim().toLowerCase();
  const selectedCategory = normalizeCategory(firstValue(query, "category"));
  const selectedYear = normalizeYear(firstValue(query, "year"));
  const selectedSort = normalizeSort(firstValue(query, "sort"));
  const { data, error } = await getMunicipalityFeed({
    municipality,
    category: selectedCategory,
    year: selectedYear,
    sort: selectedSort,
  });

  return (
    <main className="mx-auto w-full max-w-5xl p-4 pb-10 sm:p-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Njoftimet e Bashkisë
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{municipality}</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          {CATEGORY_TABS.map((tab) => {
            const isActive = tab.value === selectedCategory;
            const tabQuery = new URLSearchParams();
            tabQuery.set("category", tab.value);
            if (selectedYear) tabQuery.set("year", selectedYear);
            tabQuery.set("sort", selectedSort);
            return (
              <Link
                key={tab.value}
                href={`/municipality/${encodeURIComponent(municipality)}?${tabQuery.toString()}`}
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

        <form method="GET" className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="category" value={selectedCategory} />
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
            href={`/municipality/${encodeURIComponent(municipality)}?category=${encodeURIComponent(
              selectedCategory
            )}&sort=newest`}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
          >
            Pastro vitin
          </Link>
        </form>

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
            const attachmentLinks = (item.attachments || [])
              .map((attachment, index) => ({
                ...attachment,
                label: attachmentLabel(attachment, index),
                href: toAbsoluteApiUrl(attachment.public_file_url),
              }))
              .filter((attachment) => attachment.href);
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
                  {publicFileUrl && attachmentLinks.length === 0 ? (
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
                {attachmentLinks.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                      Dokumentet
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {attachmentLinks.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={attachment.href || undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          {attachment.label}
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
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
