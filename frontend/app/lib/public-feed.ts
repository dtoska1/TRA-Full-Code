import { SupportedCategory } from "./verticals";

export type QueryMap = Record<string, string | string[] | undefined>;

export type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  municipality_name: string | null;
  municipality_name_key?: string | null;
  published_at: string | null;
  collected_at: string | null;
  attachment_count: number;
  primary_attachment_id: string | null;
  primary_attachment_public_url: string | null;
};

export type FeedResponse = {
  ok: boolean;
  page: number;
  limit: number;
  total: number;
  items: FeedItem[];
};

export type SearchItem = {
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

export type SearchResponse = {
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

export type MunicipalityOption = {
  name_key: string;
  name_sq: string;
};

type MunicipalitiesResponse = {
  ok: boolean;
  total: number;
  items: MunicipalityApiItem[];
};

export const FEED_PAGE_SIZE = 30;

export function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
}

export function firstValue(params: QueryMap, key: string): string {
  const value = params[key];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

export function normalizeCategory(value: string): SupportedCategory {
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "prokurime") return "Prokurime";
  if (cleaned === "konsultime publike" || cleaned === "konsultime-publike") {
    return "Konsultime publike";
  }
  return "Vendime";
}

export function normalizeMunicipality(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function normalizeSort(input: string | null | undefined): "newest" | "oldest" {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "oldest") return "oldest";
  return "newest";
}

export function normalizeYear(input: string | null | undefined): string {
  const raw = String(input || "").trim();
  if (!raw || !/^\d{4}$/.test(raw)) return "";
  const year = Number.parseInt(raw, 10);
  if (year < 2000 || year > 2100) return "";
  return String(year);
}

export function normalizePage(input: string | null | undefined): number {
  const raw = String(input || "").trim();
  if (!raw) return 1;
  const page = Number.parseInt(raw, 10);
  if (!Number.isFinite(page) || page < 1) return 1;
  return page;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Pa datë";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

export function sourceHostFromUrl(urlValue: string | null | undefined): string {
  const raw = String(urlValue || "").trim();
  if (!raw) return "Burim i padisponueshëm";
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "Burim i padisponueshëm";
  }
}

export function toAbsoluteApiUrl(relativePath: string | null): string | null {
  if (!relativePath) return null;
  const apiBaseUrl = getApiBaseUrl();
  try {
    return new URL(relativePath, `${apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return null;
  }
}

export async function getMunicipalityOptions(): Promise<{
  items: MunicipalityOption[];
  error: string | null;
}> {
  const apiBaseUrl = getApiBaseUrl();
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

export async function getFeed(options: {
  category?: SupportedCategory;
  municipality?: string;
  year?: string;
  sort?: "newest" | "oldest";
  page?: number;
  limit?: number;
}): Promise<{
  data: FeedResponse | null;
  error: string | null;
}> {
  const apiBaseUrl = getApiBaseUrl();
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/feed`);
  if (options.category) url.searchParams.set("category", options.category);
  url.searchParams.set("limit", String(options.limit || FEED_PAGE_SIZE));
  url.searchParams.set("sort", options.sort || "newest");
  url.searchParams.set("page", String(options.page || 1));
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
      error: error instanceof Error ? error.message : "Failed to load public feed",
    };
  }
}

export async function getFeedTotal(category: SupportedCategory): Promise<number> {
  const { data } = await getFeed({ category, limit: 1, page: 1, sort: "newest" });
  return Number(data?.total || 0);
}
