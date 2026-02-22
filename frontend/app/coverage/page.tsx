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

export default function CoveragePage() {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CoverageResponse | null>(null);

  const sortedItems = useMemo(() => {
    if (!data?.items) return [];
    return [...data.items].sort((a, b) => {
      const muni = a.name_key.localeCompare(b.name_key);
      if (muni !== 0) return muni;
      return a.category.localeCompare(b.category);
    });
  }, [data]);

  async function handleLoad(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setData(null);

    try {
      const url = `${apiBase.replace(/\/+$/, "")}/api/admin/coverage`;
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
      };
      if (!response.ok || !json?.ok) {
        setError(json?.message || `Request failed with HTTP ${response.status}`);
        return;
      }
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load coverage");
    } finally {
      setLoading(false);
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
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-600">
                <th className="py-2 pr-3 font-semibold">name_key</th>
                <th className="py-2 pr-3 font-semibold">category</th>
                <th className="py-2 pr-3 font-semibold">registry_url_set</th>
                <th className="py-2 pr-3 font-semibold">registry_url</th>
                <th className="py-2 pr-3 font-semibold">verification_status</th>
                <th className="py-2 pr-3 font-semibold">last_error_type</th>
                <th className="py-2 pr-3 font-semibold">cooldown_until_utc</th>
                <th className="py-2 pr-3 font-semibold">last_checked_utc</th>
                <th className="py-2 pr-3 font-semibold">published_count</th>
                <th className="py-2 pr-3 font-semibold">draft_count</th>
                <th className="py-2 pr-3 font-semibold">latest_published_date</th>
                <th className="py-2 pr-3 font-semibold">latest_collected_at</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item) => (
                <tr key={`${item.municipality_id}-${item.category}`} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3 font-medium text-slate-900">{item.name_key}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.category}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.registry_url_set ? "yes" : "no"}</td>
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
                  <td className="py-2 pr-3 text-slate-700">{item.verification_status || "-"}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.last_error_type || "-"}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatValue(item.cooldown_until_utc)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatValue(item.last_checked_utc)}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.published_count}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.draft_count}</td>
                  <td className="py-2 pr-3 text-slate-700">{item.latest_published_date || "-"}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatValue(item.latest_collected_at)}</td>
                </tr>
              ))}
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
