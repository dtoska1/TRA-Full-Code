"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const STORAGE_KEY = "tra_admin_token";

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

type AuthCheckResult =
  | { ok: true }
  | { ok: false; reason: "unauthorized" | "error"; message: string };

function buildApiUrl(pathname: string): string {
  return new URL(pathname, `${API_BASE.replace(/\/+$/, "")}/`).toString();
}

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

function clearStoredToken() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage access failures.
  }
}

function storeToken(token: string) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Ignore storage access failures.
  }
}

function readStoredToken(): string {
  try {
    return String(window.sessionStorage.getItem(STORAGE_KEY) || "").trim();
  } catch {
    return "";
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
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewCards, setOverviewCards] = useState<FeedOverviewCard[]>([]);
  const [healthState, setHealthState] = useState<HealthState>({ status: "idle" });

  const healthColumns = useMemo(() => {
    if (healthState.status !== "ready") return [];
    return healthState.columns;
  }, [healthState]);

  const adminFetch = useCallback(async (pathname: string, adminToken: string): Promise<Response> => {
    const response = await fetch(buildApiUrl(pathname), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (response.status === 401) {
      clearStoredToken();
      setToken(null);
      setAuthError("Unauthorized. Please enter a valid admin token.");
      setHealthState({ status: "idle" });
      throw new Error("unauthorized");
    }

    return response;
  }, []);

  const validateToken = useCallback(async (candidateToken: string): Promise<AuthCheckResult> => {
    try {
      const response = await adminFetch("/api/admin/coverage", candidateToken);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        return {
          ok: false,
          reason: "error",
          message: payload?.message || payload?.error || `Request failed with HTTP ${response.status}`,
        };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof Error && error.message === "unauthorized") {
        return {
          ok: false,
          reason: "unauthorized",
          message: "Unauthorized. Please enter a valid admin token.",
        };
      }
      return {
        ok: false,
        reason: "error",
        message: error instanceof Error ? error.message : "Failed to verify token.",
      };
    }
  }, [adminFetch]);

  async function loadOverview() {
    setOverviewLoading(true);
    setOverviewError(null);

    try {
      const cards = await Promise.all(
        OVERVIEW_CATEGORIES.map(async (category) => {
          const url = new URL(buildApiUrl("/api/feed"));
          url.searchParams.set("category", category.key);
          url.searchParams.set("limit", "1");
          const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
              Accept: "application/json",
            },
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
    if (!token) return;
    setHealthState({ status: "loading" });

    try {
      const response = await adminFetch("/api/scrape/dashboard", token);
      if (response.status === 404) {
        setHealthState({
          status: "unavailable",
          message: "Endpoint not available.",
        });
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
      if (error instanceof Error && error.message === "unauthorized") {
        return;
      }
      setHealthState({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to load health data.",
      });
    }
  }, [adminFetch, token]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    async function hydrateToken() {
      const storedToken = readStoredToken();
      if (!storedToken) {
        setToken(null);
        setAuthReady(true);
        return;
      }

      const validation = await validateToken(storedToken);
      if (!validation.ok) {
        clearStoredToken();
        setToken(null);
        setAuthError(validation.message);
        setAuthReady(true);
        return;
      }

      setToken(storedToken);
      setAuthReady(true);
    }

    void hydrateToken();
  }, [mounted, validateToken]);

  useEffect(() => {
    if (!mounted || !token) return;
    void loadOverview();
  }, [mounted, token]);

  useEffect(() => {
    if (!token || activeTab !== "health" || healthState.status !== "idle") return;
    void loadHealth();
  }, [token, activeTab, healthState.status, loadHealth]);

  async function handleTokenSubmit(event: FormEvent) {
    event.preventDefault();
    const submittedToken = String(tokenInputRef.current?.value || "").trim();
    if (!submittedToken) {
      setAuthError("Admin token is required.");
      return;
    }

    setAuthLoading(true);
    setAuthError(null);

    const validation = await validateToken(submittedToken);
    if (!validation.ok) {
      clearStoredToken();
      setToken(null);
      setAuthError(validation.message);
      setAuthLoading(false);
      if (tokenInputRef.current) tokenInputRef.current.value = "";
      return;
    }

    storeToken(submittedToken);
    setToken(submittedToken);
    setActiveTab("overview");
    setHealthState({ status: "idle" });
    setAuthLoading(false);
    if (tokenInputRef.current) tokenInputRef.current.value = "";
  }

  function handleLogout() {
    clearStoredToken();
    setToken(null);
    setActiveTab("overview");
    setAuthError(null);
    setOverviewCards([]);
    setOverviewError(null);
    setHealthState({ status: "idle" });
  }

  if (!mounted || !authReady) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8 pb-12 sm:px-6">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
          <div className="animate-pulse">
            <div className="h-4 w-32 rounded bg-slate-200" />
            <div className="mt-4 h-10 w-72 rounded bg-slate-200" />
            <div className="mt-3 h-4 w-full max-w-2xl rounded bg-slate-200" />
            <div className="mt-8 h-12 w-full rounded bg-slate-200" />
          </div>
        </section>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8 pb-12 sm:px-6">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Admin</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">Operations panel</h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
            Enter the admin token to access overview counts, operational health, and links to
            operator tools.
          </p>

          <form onSubmit={handleTokenSubmit} className="mt-8 space-y-4">
            <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Admin token
              <input
                ref={tokenInputRef}
                type="password"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                placeholder="Enter ADMIN_TOKEN"
                autoComplete="off"
                required
              />
            </label>

            <button
              type="submit"
              disabled={authLoading}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {authLoading ? "Checking token..." : "Open admin panel"}
            </button>
          </form>

          {authError ? (
            <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {authError}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

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

            <button
              type="button"
              onClick={handleLogout}
              className="mt-8 w-full rounded-2xl border border-white/15 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/10 hover:text-white"
            >
              Log out
            </button>
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

                <div className="mt-8 grid gap-4 lg:grid-cols-2">
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
                      <p className="px-4 py-4 text-sm text-slate-500">No rows returned by the endpoint.</p>
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
