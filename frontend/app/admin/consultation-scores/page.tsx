"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
const STORAGE_KEY = "tra_admin_token";

type AdminIndicator = {
  n: number;
  name: string;
  allowed_scores: number[];
  auto_score: number;
  confidence: string;
  auto_argument: string;
  final_score: number | null;
  effective_score: number;
  argument: string;
  overridden: boolean;
};

type AdminMunicipalityScore = {
  municipality_key: string;
  municipality_name: string;
  has_score: boolean;
  total: number;
  tier: string;
  computed_at: string | null;
  reviewed_at: string | null;
  indicators: AdminIndicator[];
};

type AdminScoresResponse = {
  ok?: boolean;
  municipalities?: AdminMunicipalityScore[];
  municipality?: AdminMunicipalityScore | null;
  error?: string;
  message?: string;
};

type IndicatorPatch =
  | { overridden: false }
  | { overridden: true; final_score: number; argument: string };

type AdminRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

function buildApiUrl(pathname: string): string {
  return new URL(pathname, `${API_BASE.replace(/\/+$/, "")}/`).toString();
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "Pa datë";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pa datë";
  return parsed.toISOString().slice(0, 10);
}

function tierClassName(tier: string): string {
  const normalized = String(tier || "").toLowerCase();
  if (normalized === "excellent") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (normalized === "good") return "border-teal-200 bg-teal-50 text-teal-800";
  if (normalized === "moderate") return "border-amber-200 bg-amber-50 text-amber-800";
  if (normalized === "weak") return "border-orange-200 bg-orange-50 text-orange-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function scoreLabel(indicator: AdminIndicator, score: number): string {
  if (score === 0) return "0 - no verified evidence";
  if (score === 5) return "5 - partial/minimal evidence";
  if (score === 10) {
    return indicator.allowed_scores.includes(5)
      ? "10 - present, not fully verified"
      : "10 - partial/verifiable evidence";
  }
  if (score === 20) return "20 - fully verified";
  return String(score);
}

function isSameDraft(
  indicator: AdminIndicator,
  overridden: boolean,
  finalScore: string,
  argument: string,
): boolean {
  if (overridden !== indicator.overridden) return false;
  if (!overridden) return true;
  const originalScore = String(indicator.final_score ?? indicator.effective_score ?? indicator.auto_score);
  return String(finalScore) === originalScore && argument.trim() === String(indicator.argument || "").trim();
}

function IndicatorReviewControl({
  municipalityKey,
  hasScore,
  indicator,
  savingKey,
  onSave,
}: {
  municipalityKey: string;
  hasScore: boolean;
  indicator: AdminIndicator;
  savingKey: string | null;
  onSave: (municipalityKey: string, indicatorNumber: number, patch: IndicatorPatch) => Promise<void>;
}) {
  const [overridden, setOverridden] = useState(indicator.overridden);
  const [finalScore, setFinalScore] = useState(
    String(indicator.final_score ?? indicator.effective_score ?? indicator.auto_score),
  );
  const [argument, setArgument] = useState(indicator.overridden ? indicator.argument : "");

  const currentSavingKey = `${municipalityKey}:${indicator.n}`;
  const isSaving = savingKey === currentSavingKey;
  const isClean = isSameDraft(indicator, overridden, finalScore, argument);
  const canSave = hasScore && !isSaving && (!isClean || overridden !== indicator.overridden);

  async function handleSave() {
    if (!hasScore) return;
    if (!overridden) {
      await onSave(municipalityKey, indicator.n, { overridden: false });
      return;
    }

    await onSave(municipalityKey, indicator.n, {
      overridden: true,
      final_score: Number(finalScore),
      argument,
    });
  }

  async function handleRevert() {
    if (!hasScore || isSaving) return;
    await onSave(municipalityKey, indicator.n, { overridden: false });
  }

  return (
    <article
      className={`rounded-2xl border p-4 ${
        indicator.overridden ? "border-konsultime/40 bg-konsultime-light/35" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Indicator {indicator.n}
          </p>
          <h3 className="mt-1 text-base font-semibold text-slate-950">{indicator.name}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-900">
            Effective {indicator.effective_score}/20
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">
            {indicator.confidence}
          </span>
          {indicator.overridden ? (
            <span className="rounded-full border border-konsultime/40 bg-white px-3 py-1 text-xs font-semibold text-konsultime-dark">
              Override
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Auto proposal
        </p>
        <p className="mt-2 text-sm font-semibold text-slate-900">
          Stored auto score: {indicator.auto_score}/20
        </p>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          {indicator.auto_argument || "Auto argument unavailable."}
        </p>
      </div>

      {!hasScore ? (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No saved score row exists yet. Run B2 compute before reviewing this municipality.
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
        <label className="flex items-center gap-3 rounded-2xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">
          <input
            type="checkbox"
            checked={overridden}
            disabled={!hasScore || isSaving}
            onChange={(event) => {
              const checked = event.target.checked;
              setOverridden(checked);
              if (checked && !argument.trim()) setArgument(indicator.argument || "");
            }}
            className="h-4 w-4 rounded border-slate-300"
          />
          Use reviewer override
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Final score
          <select
            value={finalScore}
            disabled={!hasScore || !overridden || isSaving}
            onChange={(event) => setFinalScore(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium normal-case tracking-normal text-slate-900 outline-none transition focus:border-konsultime focus:ring-2 focus:ring-konsultime/15 disabled:bg-slate-100 disabled:text-slate-500"
          >
            {indicator.allowed_scores.map((score) => (
              <option key={score} value={score}>
                {scoreLabel(indicator, score)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        Reviewer argument
        <textarea
          value={argument}
          disabled={!hasScore || !overridden || isSaving}
          onChange={(event) => setArgument(event.target.value)}
          rows={4}
          className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm normal-case leading-7 tracking-normal text-slate-900 outline-none transition focus:border-konsultime focus:ring-2 focus:ring-konsultime/15 disabled:bg-slate-100 disabled:text-slate-500"
          placeholder="Explain the evidence and reviewer decision."
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void handleSave()}
          className="rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? "Saving..." : overridden ? "Save override" : "Save auto state"}
        </button>
        <button
          type="button"
          disabled={!hasScore || isSaving || (!indicator.overridden && !overridden)}
          onClick={() => void handleRevert()}
          className="rounded-2xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Revert to auto
        </button>
      </div>
    </article>
  );
}

function MunicipalityReviewCard({
  item,
  savingKey,
  onSave,
}: {
  item: AdminMunicipalityScore;
  savingKey: string | null;
  onSave: (municipalityKey: string, indicatorNumber: number, patch: IndicatorPatch) => Promise<void>;
}) {
  const overriddenCount = item.indicators.filter((indicator) => indicator.overridden).length;

  return (
    <details className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" open={overriddenCount > 0}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${tierClassName(item.tier)}`}>
                {item.tier}
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {item.municipality_key}
              </span>
              {!item.has_score ? (
                <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
                  Compute needed
                </span>
              ) : null}
              {overriddenCount ? (
                <span className="rounded-full border border-konsultime/40 bg-konsultime-light px-3 py-1 text-xs font-semibold text-konsultime-dark">
                  {overriddenCount} overridden
                </span>
              ) : null}
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
              {item.municipality_name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Computed {formatDate(item.computed_at)} · Reviewed {formatDate(item.reviewed_at)}
            </p>
          </div>

          <div className="text-left lg:text-right">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Total
            </p>
            <p className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
              {Number(item.total || 0)}
              <span className="text-base font-semibold text-slate-400">/100</span>
            </p>
          </div>
        </div>
      </summary>

      <div className="mt-5 grid gap-4">
        {item.indicators.map((indicator) => (
          <IndicatorReviewControl
            key={`${indicator.n}:${indicator.overridden}:${indicator.final_score ?? ""}:${
              indicator.effective_score
            }:${indicator.argument}`}
            municipalityKey={item.municipality_key}
            hasScore={item.has_score}
            indicator={indicator}
            savingKey={savingKey}
            onSave={onSave}
          />
        ))}
      </div>
    </details>
  );
}

export default function AdminConsultationScoresPage() {
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<AdminMunicipalityScore[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const filteredItems = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.municipality_key.includes(needle) ||
        item.municipality_name.toLowerCase().includes(needle),
    );
  }, [filter, items]);

  const adminFetch = useCallback(async function adminFetch(
    pathname: string,
    adminToken: string,
    init: AdminRequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${adminToken}`);
    headers.set("Accept", "application/json");
    const response = await fetch(buildApiUrl(pathname), {
      ...init,
      headers,
      cache: "no-store",
    });

    if (response.status === 401) {
      clearStoredToken();
      setToken(null);
      setItems([]);
      setError("Unauthorized. Please enter a valid admin token.");
      throw new Error("unauthorized");
    }

    return response;
  }, []);

  const loadScores = useCallback(async function loadScores(
    adminToken: string,
    options: { initial?: boolean } = {},
  ) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch("/api/admin/consultation-scores", adminToken);
      const payload = (await response.json().catch(() => null)) as AdminScoresResponse | null;
      if (!response.ok || !payload?.ok || !Array.isArray(payload.municipalities)) {
        throw new Error(payload?.message || payload?.error || `Request failed with HTTP ${response.status}`);
      }
      setItems(payload.municipalities);
      setToken(adminToken);
      if (!options.initial) setNotice("Review data refreshed.");
      return true;
    } catch (err) {
      if (err instanceof Error && err.message === "unauthorized") return false;
      setError(err instanceof Error ? err.message : "Failed to load consultation score review data.");
      return false;
    } finally {
      setLoading(false);
      setAuthReady(true);
    }
  }, [adminFetch]);

  useEffect(() => {
    setMounted(true);
    const storedToken = readStoredToken();
    if (!storedToken) {
      setAuthReady(true);
      return;
    }
    void loadScores(storedToken, { initial: true });
  }, [loadScores]);

  async function handleTokenSubmit(event: FormEvent) {
    event.preventDefault();
    const submittedToken = String(tokenInputRef.current?.value || "").trim();
    if (!submittedToken) {
      setError("Admin token is required.");
      return;
    }

    const ok = await loadScores(submittedToken, { initial: true });
    if (ok) {
      storeToken(submittedToken);
      if (tokenInputRef.current) tokenInputRef.current.value = "";
    } else {
      clearStoredToken();
      if (tokenInputRef.current) tokenInputRef.current.value = "";
    }
  }

  function handleLogout() {
    clearStoredToken();
    setToken(null);
    setItems([]);
    setError(null);
    setNotice(null);
  }

  async function handleSaveIndicator(
    municipalityKey: string,
    indicatorNumber: number,
    patch: IndicatorPatch,
  ) {
    if (!token) return;
    setSavingKey(`${municipalityKey}:${indicatorNumber}`);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch(`/api/admin/consultation-scores/${municipalityKey}`, token, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          indicators: {
            [String(indicatorNumber)]: patch,
          },
        }),
      });
      const payload = (await response.json().catch(() => null)) as AdminScoresResponse | null;
      if (!response.ok || !payload?.ok || !payload.municipality) {
        throw new Error(payload?.message || payload?.error || `Request failed with HTTP ${response.status}`);
      }

      setItems((current) =>
        current.map((item) =>
          item.municipality_key === payload.municipality?.municipality_key
            ? payload.municipality
            : item,
        ),
      );
      setNotice(`${payload.municipality.municipality_name} indicator ${indicatorNumber} saved.`);
    } catch (err) {
      if (err instanceof Error && err.message === "unauthorized") return;
      setError(err instanceof Error ? err.message : "Failed to save reviewer override.");
    } finally {
      setSavingKey(null);
    }
  }

  if (!mounted || !authReady) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8 pb-12 sm:px-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
          <div className="animate-pulse">
            <div className="h-4 w-32 rounded bg-slate-200" />
            <div className="mt-4 h-10 w-72 rounded bg-slate-200" />
            <div className="mt-6 h-40 w-full rounded bg-slate-200" />
          </div>
        </section>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8 pb-12 sm:px-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Admin</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
            Consultation score review
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
            Enter the admin token to review automated consultation matrix scores and save
            reviewer overrides.
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
              disabled={loading}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Checking token..." : "Open review"}
            </button>
          </form>

          {error ? (
            <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 pb-12 sm:px-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-soft sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
              Admin
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              Consultation matrix review
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600">
              Review automated scores, set per-indicator overrides with plain-text arguments, or
              revert an indicator back to the current auto proposal.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void loadScores(token)}
              disabled={loading}
              className="rounded-2xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
            >
              Log out
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-end sm:justify-between">
          <label className="block w-full max-w-md text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Filter
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm normal-case tracking-normal text-slate-900 outline-none transition focus:border-konsultime focus:ring-2 focus:ring-konsultime/15"
              placeholder="Search municipality"
            />
          </label>
          <Link
            href="/konsultime/radar"
            className="rounded-2xl border border-konsultime/30 px-4 py-3 text-sm font-semibold text-konsultime-dark transition hover:bg-konsultime-light"
          >
            View public radar
          </Link>
        </div>

        {error ? (
          <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </p>
        ) : null}

        <div className="mt-6 grid gap-4">
          {filteredItems.map((item) => (
            <MunicipalityReviewCard
              key={item.municipality_key}
              item={item}
              savingKey={savingKey}
              onSave={handleSaveIndicator}
            />
          ))}
        </div>

        {!loading && filteredItems.length === 0 ? (
          <p className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
            No municipalities matched the current filter.
          </p>
        ) : null}
      </section>
    </main>
  );
}
