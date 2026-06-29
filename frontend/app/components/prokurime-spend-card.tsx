"use client";

import { useEffect, useMemo, useState } from "react";
import { VERTICAL_THEMES } from "../lib/verticals";

type MunicipalityOption = {
  name_key: string;
  name_sq: string;
};

type ProkurimeBucket = {
  cpv_code: string;
  label: string;
  amount: number;
  count: number;
};

type ProkurimePieResponse = {
  ok: boolean;
  municipality: string;
  year: number;
  currency: "ALL";
  total_amount: number;
  buckets: ProkurimeBucket[];
  message?: string;
};

const PIE_COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#6366f1", "#94a3b8"];
const CPV_CODE_RE = /\b\d{8}-\d\b/;

function normalizeMunicipality(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function formatAmount(value: number): string {
  const numeric = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("sq-AL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function formatShare(amount: number, totalAmount: number): string {
  const fraction = totalAmount > 0 ? amount / totalAmount : 0;
  return new Intl.NumberFormat("sq-AL", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(fraction);
}

function stripCpvCodes(value: string): string {
  return String(value || "")
    .replace(new RegExp(`${CPV_CODE_RE.source}\\s*[-:;,]*\\s*`, "gi"), "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ", ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^,\s*/, "")
    .replace(/,\s*$/, "");
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = String(hex || "").replace("#", "").trim();
  if (normalized.length !== 6) return `rgba(15, 23, 42, ${alpha})`;
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function formatBucketDisplay(
  bucket: ProkurimeBucket
): { title: string; secondary: string; isOther: boolean } {
  const rawCode = String(bucket.cpv_code || "").trim();
  const rawLabel = String(bucket.label || "").trim();
  const isOther = rawCode.toLowerCase() === "other" || rawLabel.toLowerCase() === "other";

  if (isOther) {
    return {
      title: "Kategori të tjera më të vogla",
      secondary: rawLabel ? `Etiketa burimore: ${rawLabel}` : "Kategori të tjera",
      isOther: true,
    };
  }

  const cpvCodes = Array.from(new Set(`${rawCode} ${rawLabel}`.match(new RegExp(CPV_CODE_RE.source, "gi")) || []));
  const preferredLabel = rawLabel && rawLabel !== rawCode ? rawLabel : rawCode || rawLabel;
  if (!preferredLabel || preferredLabel.toUpperCase() === "UNKNOWN") {
    return {
      title: "E panjohur",
      secondary: cpvCodes.length ? `Kodi CPV: ${cpvCodes.join(", ")}` : "Kodi CPV mungon",
      isOther: false,
    };
  }
  const cleanedLabel = stripCpvCodes(preferredLabel);
  const title = cleanedLabel || preferredLabel || "Pa kategori";

  if (preferredLabel && title !== preferredLabel) {
    return {
      title,
      secondary: `Etiketa burimore: ${preferredLabel}`,
      isOther: false,
    };
  }

  return {
    title,
    secondary: cpvCodes.length ? `Kodi CPV: ${cpvCodes.join(", ")}` : "Kodi CPV mungon",
    isOther: false,
  };
}

export default function ProkurimeSpendCard({
  municipalities,
  eyebrow = "Shpenzime Prokurimi",
  title = "Ku shkojnë paratë publike?",
  description = "Shiko si shpërndahet vlera e prokurimeve sipas kategorive kryesore për bashkinë dhe vitin që zgjedh.",
  className = "",
}: {
  municipalities: MunicipalityOption[];
  eyebrow?: string;
  title?: string;
  description?: string;
  className?: string;
}) {
  const theme = VERTICAL_THEMES.prokurime;
  const normalizedMunicipalities = useMemo(
    () =>
      municipalities
        .map((item) => ({
          name_key: normalizeMunicipality(item.name_key),
          name_sq: String(item.name_sq || "").trim(),
        }))
        .filter((item) => item.name_key && item.name_sq),
    [municipalities]
  );

  const municipalitySet = useMemo(
    () => new Set(normalizedMunicipalities.map((item) => item.name_key)),
    [normalizedMunicipalities]
  );

  const fallbackMunicipality = useMemo(() => {
    if (municipalitySet.has("tirane")) return "tirane";
    if (municipalitySet.has("durres")) return "durres";
    return normalizedMunicipalities[0]?.name_key || "tirane";
  }, [municipalitySet, normalizedMunicipalities]);

  const [selectedMunicipality, setSelectedMunicipality] = useState(fallbackMunicipality);
  const [selectedYear, setSelectedYear] = useState("");
  const [data, setData] = useState<ProkurimePieResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setSelectedMunicipality(fallbackMunicipality);
  }, [fallbackMunicipality]);

  useEffect(() => {
    if (!selectedMunicipality) return;
    const controller = new AbortController();
    const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
    const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/dashboard/prokurime/pie`);
    url.searchParams.set("municipality", selectedMunicipality);
    url.searchParams.set("top", "5");
    if (selectedYear) {
      url.searchParams.set("year", selectedYear);
    }

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(url.toString(), {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = (await response.json()) as ProkurimePieResponse;
        if (!response.ok || !json?.ok) {
          throw new Error(json?.message || `Backend returned HTTP ${response.status}`);
        }
        setData(json);
        if (!selectedYear && Number.isInteger(json.year)) {
          setSelectedYear(String(json.year));
        }
      } catch (fetchErr) {
        if ((fetchErr as { name?: string })?.name === "AbortError") return;
        setData(null);
        setError(fetchErr instanceof Error ? fetchErr.message : "Failed to load procurement spend");
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => controller.abort();
  }, [selectedMunicipality, selectedYear]);

  const yearUpperBound = Math.max(2026, data?.year || 2026);
  const yearOptions = useMemo(() => {
    const values = [];
    for (let year = yearUpperBound; year >= 2000; year -= 1) {
      values.push(year);
    }
    return values;
  }, [yearUpperBound]);

  const hasSpendData = Number(data?.total_amount || 0) > 0;
  const totalAmount = Number(data?.total_amount || 0);
  const buckets = useMemo(() => {
    return Array.isArray(data?.buckets) ? data.buckets : [];
  }, [data?.buckets]);
  const listRows = useMemo(() => {
    if (!hasSpendData) return [];
    return buckets.filter((bucket) => Number(bucket.amount || 0) > 0);
  }, [buckets, hasSpendData]);

  const pieSlices = useMemo(() => {
    if (!listRows.length) return [];

    const radius = 72;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;

    return listRows.map((bucket, index) => {
      const amount = Number(bucket.amount || 0);
      const fraction = totalAmount > 0 ? amount / totalAmount : 0;
      const length = Math.max(0, fraction * circumference);
      const currentOffset = offset;
      offset += length;
      return {
        key: `${bucket.cpv_code}-${index}`,
        amount,
        color: PIE_COLORS[index % PIE_COLORS.length],
        dasharray: `${length} ${Math.max(0, circumference - length)}`,
        dashoffset: -currentOffset,
      };
    });
  }, [listRows, totalAmount]);

  return (
    <section
      className={`w-full rounded-[32px] border bg-white p-6 shadow-soft sm:p-8 ${theme.accentBorderClass} ${className}`.trim()}
    >
      <div className="flex items-center gap-3">
        <span className={`h-3 w-3 rounded-full ${theme.accentClass}`} aria-hidden="true" />
        <p className={`text-xs font-semibold uppercase tracking-[0.24em] ${theme.accentTextClass}`}>
          {eyebrow}
        </p>
      </div>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
        {title}
      </h2>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">{description}</p>

      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Bashkia
          <select
            value={selectedMunicipality}
            onChange={(event) => setSelectedMunicipality(normalizeMunicipality(event.target.value))}
            className="mt-2 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-prokurime focus:ring-2 focus:ring-prokurime/15"
            aria-label="Bashkia"
          >
            {normalizedMunicipalities.map((item) => (
              <option key={item.name_key} value={item.name_key}>
                {item.name_sq}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Viti
          <select
            value={selectedYear}
            onChange={(event) => setSelectedYear(String(event.target.value || "").trim())}
            className="mt-2 w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-prokurime focus:ring-2 focus:ring-prokurime/15"
            aria-label="Viti"
          >
            <option value="">Viti i fundit</option>
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error ? (
        <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {loading ? <p className="mt-5 text-sm text-slate-600">Duke ngarkuar të dhënat...</p> : null}

      {!mounted ? (
        <div className="mt-6 animate-pulse" aria-hidden="true">
          <div className="h-4 w-48 rounded bg-slate-200" />
          <div className="mt-2 h-10 w-56 rounded bg-slate-200" />
          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
            <div className="mx-auto h-[180px] w-[180px] rounded-full bg-slate-200" />
            <div className="space-y-2">
              <div className="h-4 w-36 rounded bg-slate-200" />
              <div className="h-14 w-full rounded bg-slate-200" />
              <div className="h-14 w-full rounded bg-slate-200" />
              <div className="h-14 w-full rounded bg-slate-200" />
            </div>
          </div>
        </div>
      ) : !loading && !error ? (
        <div className="mt-6">
          <div className={`rounded-[24px] border bg-prokurime-light/60 p-5 ${theme.accentBorderClass}`}>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Shpenzime totale të prokurimit
            </p>
            <p className={`mt-3 text-4xl font-semibold leading-none ${theme.accentTextClass}`}>
              {formatAmount(totalAmount)} {data?.currency || "ALL"}
            </p>
          </div>

          {hasSpendData ? (
            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
              <div className="mx-auto rounded-[24px] border border-slate-200 bg-slate-50 p-4">
                <svg
                  viewBox="0 0 180 180"
                  width="180"
                  height="180"
                  role="img"
                  aria-label="Grafiku i kategorive kryesore"
                >
                  <circle cx="90" cy="90" r="72" fill="none" stroke="#dbeafe" strokeWidth="18" />
                  {pieSlices.map((slice, index) => (
                    <circle
                      key={slice.key}
                      cx="90"
                      cy="90"
                      r="72"
                      fill="none"
                      stroke={slice.color}
                      strokeWidth="18"
                      strokeDasharray={slice.dasharray}
                      strokeDashoffset={slice.dashoffset}
                      transform="rotate(-90 90 90)"
                      strokeLinecap="butt"
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseLeave={() => setActiveIndex(null)}
                      style={{
                        cursor: "pointer",
                        opacity: activeIndex === null || activeIndex === index ? 1 : 0.4,
                        strokeWidth: activeIndex === index ? 22 : 18,
                        transition: "opacity 160ms ease, stroke-width 160ms ease",
                      }}
                    />
                  ))}
                </svg>
              </div>

              <div>
                <h3 className={`text-sm font-semibold uppercase tracking-[0.22em] ${theme.accentTextClass}`}>
                  Ku shkon shpenzimi i prokurimeve
                </h3>
                <p className="mt-3 text-sm leading-7 text-slate-600">
                  Këto kategori tregojnë ku është përqendruar pjesa më e madhe e vlerës së
                  prokurimeve për këtë bashki në vitin e zgjedhur.
                </p>
                <ul className="mt-4 space-y-3">
                  {listRows.map((bucket, index) => {
                    const display = formatBucketDisplay(bucket);
                    const color = PIE_COLORS[index % PIE_COLORS.length];
                    const isActive = activeIndex === index;
                    return (
                      <li
                        key={`${bucket.cpv_code}-${index}`}
                        className="rounded-[22px] border border-slate-200 bg-white p-4 transition-colors"
                        onMouseEnter={() => setActiveIndex(index)}
                        onMouseLeave={() => setActiveIndex(null)}
                        style={
                          isActive
                            ? {
                                borderColor: color,
                                backgroundColor: hexToRgba(color, 0.08),
                              }
                            : undefined
                        }
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <span
                              aria-hidden="true"
                              className="mt-1 h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <p className="text-sm font-semibold text-slate-800">{display.title}</p>
                          </div>
                          <p className="text-right text-sm font-semibold text-slate-900">
                            {formatAmount(bucket.amount)} ALL ({formatShare(bucket.amount, totalAmount)})
                          </p>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">{display.secondary}</p>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          ) : (
            <p className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Nuk ka të dhëna për këtë vit.
            </p>
          )}

          <p className="mt-5 text-xs text-slate-500">Burimi: app.gov.al</p>
        </div>
      ) : null}
    </section>
  );
}
