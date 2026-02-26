"use client";

import { FormEvent, useMemo, useState } from "react";

type CoverageItem = {
  municipality_id: string;
  name_key: string;
  name_sq: string;
  category: "Vendime" | "Prokurime" | "Konsultime publike";
  source_registry_id: string | null;
  registry_url: string | null;
  registry_url_set: boolean;
  checked_flag?: boolean;
  category_checked: boolean;
  is_nationwide_source?: boolean;
  registry_url_origin?: "municipality" | "nationwide";
  verification_status: string | null;
  last_error_type: string | null;
  cooldown_until_utc: string | null;
  last_checked_utc: string | null;
  published_count: number;
  draft_count: number;
  latest_published_date: string | null;
  latest_collected_at: string | null;
};

type CoverageResponse = {
  ok: boolean;
  generated_at_utc: string;
  total_municipalities: number;
  total_rows: number;
  categories: string[];
  items: CoverageItem[];
};

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

function formatValue(value: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString();
}

function rowKey(item: CoverageItem): string {
  return `${item.municipality_id}-${item.category}`;
}

function sanitizeYearInput(value: string): string {
  return String(value || "").replace(/[^\d]/g, "").slice(0, 4);
}

function isNationwideSource(item: CoverageItem): boolean {
  return item.is_nationwide_source === true || item.registry_url_origin === "nationwide";
}

function resolveCheckedFlag(item: CoverageItem): boolean {
  if (typeof item.checked_flag === "boolean") return item.checked_flag;
  return item.category_checked;
}

function resolveUrlSourceLabel(item: CoverageItem): string {
  if (isNationwideSource(item)) return "Nationwide source";
  return item.registry_url_set ? "Municipality URL set" : "Municipality URL missing";
}

export default function CoveragePage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [rowYear, setRowYear] = useState<Record<string, string>>({});
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowMessage, setRowMessage] = useState<Record<string, string>>({});

  const sortedItems = useMemo(() => {
    if (!data?.items) return [];
    return [...data.items].sort((a, b) => {
      const muni = a.name_key.localeCompare(b.name_key);
      if (muni !== 0) return muni;
      return a.category.localeCompare(b.category);
    });
  }, [data]);

  function buildUrl(pathname: string, params: Record<string, string | number | boolean | null>) {
    const url = new URL(`${apiBase.replace(/\/+$/, "")}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async function loadCoverage() {
    const url = buildUrl("/api/admin/coverage", {});
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const json = (await response.json()) as CoverageResponse & {
      message?: string;
      error?: string;
    };
    if (!response.ok || !json?.ok) {
      throw new Error(json?.message || json?.error || `Request failed with HTTP ${response.status}`);
    }
    setData(json);
  }

  async function postAdminAction(
    pathname: string,
    params: Record<string, string | number | boolean | null>
  ) {
    const url = buildUrl(pathname, params);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    const json = (await response.json()) as {
      ok?: boolean;
      message?: string;
      error?: string;
      published_updated?: number;
      checked?: boolean;
      inserted?: number;
      updated?: number;
      skipped?: number;
      next_offset?: number | null;
    };

    if (!response.ok || !json?.ok) {
      throw new Error(json?.message || json?.error || `Request failed with HTTP ${response.status}`);
    }
    return json;
  }

  async function handleLoad(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await loadCoverage();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load coverage");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function runRowAction(
    item: CoverageItem,
    action: "run_scrape" | "publish" | "mark_checked" | "mark_unchecked"
  ) {
    const key = rowKey(item);
    setRowBusy((prev) => ({ ...prev, [key]: true }));
    setRowMessage((prev) => ({ ...prev, [key]: "" }));
    setError(null);

    try {
      const yearText = String(rowYear[key] || "").trim();
      if (yearText && (!/^\d{4}$/.test(yearText) || Number(yearText) < 2000 || Number(yearText) > 2100)) {
        throw new Error("Year must be between 2000 and 2100.");
      }
      const year = yearText ? Number(yearText) : null;

      if (action === "run_scrape") {
        const result = await postAdminAction("/api/scrape/run", {
          municipality: item.name_key,
          category: item.category,
          year,
        });
        setRowMessage((prev) => ({
          ...prev,
          [key]: `Scrape ok: inserted=${Number(result.inserted || 0)} updated=${Number(
            result.updated || 0
          )} skipped=${Number(result.skipped || 0)} next_offset=${
            result.next_offset === null || result.next_offset === undefined
              ? "-"
              : String(result.next_offset)
          }`,
        }));
      } else if (action === "publish") {
        const result = await postAdminAction("/api/admin/publish", {
          municipality: item.name_key,
          category: item.category,
          year,
        });
        setRowMessage((prev) => ({
          ...prev,
          [key]: `Publish ok: published_updated=${Number(result.published_updated || 0)}`,
        }));
      } else {
        const checked = action === "mark_checked";
        const result = await postAdminAction("/api/admin/source/checked", {
          municipality: item.name_key,
          category: item.category,
          checked,
        });
        setRowMessage((prev) => ({
          ...prev,
          [key]: `Auto-publish updated: ${result.checked ? "ENABLED" : "DISABLED"}`,
        }));
      }

      await loadCoverage();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Action failed";
      setRowMessage((prev) => ({ ...prev, [key]: message }));
    } finally {
      setRowBusy((prev) => ({ ...prev, [key]: false }));
    }
  }

  function handleClearToken() {
    setToken("");
  }

  return (
    <main className="mx-auto w-full max-w-7xl p-4 pb-10 sm:p-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Admin Coverage</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Municipality x Category Coverage</h1>
        <p className="mt-2 text-sm text-slate-600">
          This page requires an admin token. Token is kept in memory only and is never persisted.
        </p>

        <form onSubmit={handleLoad} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
          <input
            type="url"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="API base URL"
            aria-label="API base URL"
            required
          />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="Admin token"
            aria-label="Admin token"
            required
          />
          <button
            type="submit"
            disabled={loading || !token.trim()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Loading..." : "Load coverage"}
          </button>
          <button
            type="button"
            onClick={handleClearToken}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
          >
            Clear token
          </button>
        </form>

        {error ? (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
      </section>

      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rows</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{data?.total_rows || 0}</p>
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Municipalities</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{data?.total_municipalities || 0}</p>
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Categories</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900">{data?.categories?.length || 0}</p>
        </article>
        <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Generated</p>
          <p className="mt-2 text-sm font-medium text-slate-900">
            {data?.generated_at_utc ? formatValue(data.generated_at_utc) : "-"}
          </p>
        </article>
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="mb-3 text-xs text-slate-600">
          Row actions use optional year. Leave year empty to run/publish without year filter.
        </p>
        <p className="mb-3 text-xs text-slate-600">
          Auto-publish controls whether new ingests publish automatically. Legacy 'Source reviewed'
          does not auto-publish.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-600">
                <th className="py-2 pr-3 font-semibold">name_key</th>
                <th className="py-2 pr-3 font-semibold">category</th>
                <th className="py-2 pr-3 font-semibold">URL source</th>
                <th className="py-2 pr-3 font-semibold">registry_url</th>
                <th className="py-2 pr-3 font-semibold">Auto-publish (per category)</th>
                <th className="py-2 pr-3 font-semibold">Source reviewed (legacy)</th>
                <th className="py-2 pr-3 font-semibold">last_error_type</th>
                <th className="py-2 pr-3 font-semibold">cooldown_until_utc</th>
                <th className="py-2 pr-3 font-semibold">last_checked_utc</th>
                <th className="py-2 pr-3 font-semibold">published_count</th>
                <th className="py-2 pr-3 font-semibold">draft_count</th>
                <th className="py-2 pr-3 font-semibold">latest_published_date</th>
                <th className="py-2 pr-3 font-semibold">latest_collected_at</th>
                <th className="py-2 pr-3 font-semibold">actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item) => {
                const key = rowKey(item);
                const busy = !!rowBusy[key];
                const yearValue = rowYear[key] || "";
                const actionMessage = rowMessage[key] || "";
                const checkedFlag = resolveCheckedFlag(item);
                return (
                  <tr key={key} className="border-b border-slate-100 align-top">
                    <td className="py-2 pr-3 font-medium text-slate-900">{item.name_key}</td>
                    <td className="py-2 pr-3 text-slate-700">{item.category}</td>
                    <td className="py-2 pr-3 text-slate-700">{resolveUrlSourceLabel(item)}</td>
                    <td className="py-2 pr-3">
                      {item.registry_url ? (
                        <a
                          href={item.registry_url}
                          target="_blank"
                          rel="noreferrer"
                          className="break-all text-blue-700 underline"
                        >
                          {item.registry_url}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">
                      {item.category_checked ? "ENABLED" : "DISABLED"}
                    </td>
                    <td className="py-2 pr-3 text-slate-700">{item.verification_status || "-"}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatValue(item.last_checked_utc)}</td>
                    <td className="py-2 pr-3 text-slate-700">{item.published_count}</td>
                    <td className="py-2 pr-3 text-slate-700">{item.draft_count}</td>
                    <td className="py-2 pr-3 text-slate-700">{item.latest_published_date || "-"}</td>
                    <td className="py-2 pr-3 text-slate-700">{formatValue(item.latest_collected_at)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex min-w-[360px] flex-col gap-2">
                        <div className="flex gap-2">
                          <input
                            value={yearValue}
                            onChange={(e) =>
                              setRowYear((prev) => ({
                                ...prev,
                                [key]: sanitizeYearInput(e.target.value),
                              }))
                            }
                            inputMode="numeric"
                            placeholder="Year (optional)"
                            className="w-28 rounded border border-slate-300 px-2 py-1 text-xs"
                          />
                          <button
                            type="button"
                            onClick={() => runRowAction(item, "run_scrape")}
                            disabled={busy || !token.trim()}
                            className="rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                          >
                            Run scrape
                          </button>
                          <button
                            type="button"
                            onClick={() => runRowAction(item, "publish")}
                            disabled={busy || !token.trim()}
                            className="rounded border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                          >
                            Publish drafts
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => runRowAction(item, "mark_checked")}
                            disabled={busy || !token.trim()}
                            className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700 disabled:opacity-60"
                          >
                            Enable auto-publish
                          </button>
                          <button
                            type="button"
                            onClick={() => runRowAction(item, "mark_unchecked")}
                            disabled={busy || !token.trim()}
                            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                          >
                            Disable auto-publish
                          </button>
                        </div>
                        {actionMessage ? (
                          <p className="text-[11px] text-slate-600">{actionMessage}</p>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sortedItems.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No coverage rows loaded yet.</p>
        ) : null}
      </section>
    </main>
  );
}
