"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminFetch } from "../lib/admin-auth";

const OVERVIEW_CATEGORIES = [
  { key: "Vendime", description: "Published municipal decisions." },
  { key: "Prokurime", description: "Published procurement notices." },
  { key: "Konsultime publike", description: "Published public consultation items." },
] as const;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "health", label: "Health" },
  { id: "coverage", label: "Coverage" },
  { id: "create-document", label: "Create Document" },
] as const;

type AdminTab = (typeof TABS)[number]["id"];

type FeedOverviewCard = {
  label: string;
  total: number;
  description: string;
};

type HealthRow = Record<string, unknown>;

type HealthState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; rows: HealthRow[]; columns: string[] }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickHealthRows(payload: unknown): HealthRow[] {
  if (!isRecord(payload)) return [];
  const candidates = [payload.items, payload.rows, payload.municipalities, payload.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.every((item) => isRecord(item))) {
      return candidate as HealthRow[];
    }
  }
  return [];
}

function pickHealthColumns(rows: HealthRow[]): string[] {
  if (!rows.length) return [];
  const preferred = [
    "municipality",
    "name_sq",
    "name_key",
    "status",
    "source",
    "source_domain",
    "source_url",
    "last_scrape",
    "last_scrape_at",
    "last_checked_utc",
    "items",
    "item_count",
  ];
  const available = new Set<string>();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => available.add(key));
  });
  const orderedPreferred = preferred.filter((key) => available.has(key));
  const extras = Array.from(available).filter((key) => !orderedPreferred.includes(key)).sort();
  return [...orderedPreferred, ...extras].slice(0, 8);
}

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewCards, setOverviewCards] = useState<FeedOverviewCard[]>([]);
  const [healthState, setHealthState] = useState<HealthState>({ status: "idle" });

  const healthColumns = useMemo(() => {
    if (healthState.status !== "ready") return [];
    return healthState.columns;
  }, [healthState]);

  async function loadOverview() {
    setOverviewLoading(true);
    setOverviewError(null);

    try {
      const cards = await Promise.all(
        OVERVIEW_CATEGORIES.map(async (category) => {
          const url = new URL("/api/feed", window.location.origin);
          url.searchParams.set("category", category.key);
          url.searchParams.set("limit", "1");
          const response = await fetch(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          if (!response.ok) {
            throw new Error(`Overview feed returned HTTP ${response.status} for ${category.key}.`);
          }
          const payload = (await response.json()) as { total?: number };
          return {
            label: category.key,
            total: Number(payload?.total || 0),
            description: category.description,
          };
        })
      );

      setOverviewCards(cards);
    } catch (error) {
      setOverviewCards([]);
      setOverviewError(error instanceof Error ? error.message : "Failed to load overview counts.");
    } finally {
      setOverviewLoading(false);
    }
  }

  const loadHealth = useCallback(async () => {
    setHealthState({ status: "loading" });

    try {
      const response = await adminFetch("/api/scrape/dashboard");
      if (response.status === 404) {
        setHealthState({ status: "unavailable", message: "Endpoint not available." });
        return;
      }

      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const message =
          isRecord(payload) && typeof payload.message === "string"
            ? payload.message
            : `Request failed with HTTP ${response.status}`;
        setHealthState({ status: "error", message });
        return;
      }

      const rows = pickHealthRows(payload);
      const columns = pickHealthColumns(rows);
      setHealthState({ status: "ready", rows, columns });
    } catch (error) {
      setHealthState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to load health data.",
      });
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    if (activeTab !== "health" || healthState.status !== "idle") return;
    void loadHealth();
  }, [activeTab, healthState.status, loadHealth]);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 pb-12 sm:px-6">
      <section className="rounded-[32px] border border-slate-200 bg-white shadow-soft">
        <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="border-b border-slate-200 bg-slate-950 px-5 py-6 text-white lg:border-b-0 lg:border-r lg:border-white/10">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
              Admin
            </p>
            <h1 className="mt-4 text-2xl font-semibold tracking-tight">Operations</h1>
            <p className="mt-3 text-sm leading-7 text-slate-300">
              Internal tools and quick links for monitoring and publishing workflows.
            </p>

            <nav aria-label="Admin tabs" className="mt-8 space-y-2">
              {TABS.map((tab) => {
                const isActive = tab.id === activeTab;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={
                      isActive
                        ? "w-full rounded-2xl bg-white px-4 py-3 text-left text-sm font-semibold text-slate-950"
                        : "w-full rounded-2xl px-4 py-3 text-left text-sm font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white"
                    }
                  >
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="px-5 py-6 sm:px-8 sm:py-8">
            {activeTab === "overview" ? (
              <section>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Overview
                    </p>
                    <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                      Publishing snapshot
                    </h2>
                    <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                      Public feed totals per category plus quick access to operator tools.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadOverview()}
                    className="rounded-2xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Refresh counts
                  </button>
                </div>

                {overviewError ? (
                  <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {overviewError}
                  </p>
                ) : null}

                <div className="mt-6 grid gap-4 sm:grid-cols-3">
                  {OVERVIEW_CATEGORIES.map((category, index) => {
                    const card = overviewCards[index];
                    return (
                      <article
                        key={category.key}
                        className="rounded-[24px] border border-slate-200 bg-slate-50 p-5"
                      >
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                          {category.key}
                        </p>
                        <p className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
                          {overviewLoading ? "..." : (card?.total || 0).toLocaleString("sq-AL")}
                        </p>
                        <p className="mt-3 text-sm leading-7 text-slate-600">
                          {card?.description || category.description}
                        </p>
                      </article>
                    );
                  })}
                </div>

                <div className="mt-8 grid gap-4 lg:grid-cols-3">
                  <article className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Coverage
                    </p>
                    <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
                      Municipality coverage view
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-slate-600">
                      Open the standalone coverage tool to inspect source readiness, publish state,
                      and run row-level admin actions.
                    </p>
                    <Link
                      href="/coverage"
                      className="mt-5 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      Open coverage
                    </Link>
                  </article>

                  <article className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Create Document
                    </p>
                    <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
                      Manual publishing tool
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-slate-600">
                      Open the manual item form to create a document from a file upload or source
                      URL without changing the standalone workflow.
                    </p>
                    <Link
                      href="/admin/new-item"
                      className="mt-5 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      Open create document
                    </Link>
                  </article>

                  <article className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                      Consultation Matrix
                    </p>
                    <h3 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
                      Reviewer overrides
                    </h3>
                    <p className="mt-3 text-sm leading-7 text-slate-600">
                      Review automated Konsultime scores, set rubric-based overrides, and revert
                      indicators back to auto evidence.
                    </p>
                    <Link
                      href="/admin/consultation-scores"
                      className="mt-5 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                    >
                      Open review
                    </Link>
                  </article>
                </div>
              </section>
            ) : null}

            {activeTab === "health" ? (
              <section>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Health
                    </p>
                    <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                      Scraper dashboard
                    </h2>
                    <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                      Attempts to load municipality-level health data from the backend when the
                      endpoint is available.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadHealth()}
                    className="rounded-2xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Refresh health
                  </button>
                </div>

                {healthState.status === "loading" ? (
                  <p className="mt-6 text-sm text-slate-600">Loading health data...</p>
                ) : null}

                {healthState.status === "unavailable" ? (
                  <p className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    {healthState.message}
                  </p>
                ) : null}

                {healthState.status === "error" ? (
                  <p className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {healthState.message}
                  </p>
                ) : null}

                {healthState.status === "ready" ? (
                  <div className="mt-6 overflow-x-auto rounded-[26px] border border-slate-200">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          {healthColumns.map((column) => (
                            <th key={column} className="px-4 py-3 font-semibold">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {healthState.rows.map((row, index) => (
                          <tr key={index} className="border-t border-slate-200 align-top">
                            {healthColumns.map((column) => (
                              <td key={column} className="px-4 py-3 text-slate-700">
                                <span className="break-words">{formatValue(row[column])}</span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {healthState.rows.length === 0 ? (
                      <p className="px-4 py-4 text-sm text-slate-500">
                        No rows returned by the endpoint.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            ) : null}

            {activeTab === "coverage" ? (
              <section>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Coverage
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Standalone coverage tool
                </h2>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                  Coverage stays in its existing route. Open it to review municipality/category
                  readiness, source URLs, publish actions, and scrape triggers.
                </p>
                <Link
                  href="/coverage"
                  className="mt-6 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Go to /coverage
                </Link>
              </section>
            ) : null}

            {activeTab === "create-document" ? (
              <section>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Create Document
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
                  Manual publishing route
                </h2>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
                  The existing manual document page remains unchanged. Open it to upload a PDF or
                  create a record from a source URL.
                </p>
                <Link
                  href="/admin/new-item"
                  className="mt-6 inline-flex rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Go to /admin/new-item
                </Link>
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
