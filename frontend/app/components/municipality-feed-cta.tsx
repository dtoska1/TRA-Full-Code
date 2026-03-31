"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type MunicipalityOption = {
  name_key: string;
  name_sq: string;
};

type FeedCategory = "Vendime" | "Prokurime" | "Konsultime publike";

const STORAGE_KEY = "tra_last_municipality";

function normalizeMunicipality(value: string): string {
  return String(value || "").trim().toLowerCase();
}

export default function MunicipalityFeedCta({
  municipalities,
  defaultMunicipality,
  selectedCategory,
}: {
  municipalities: MunicipalityOption[];
  defaultMunicipality: string;
  selectedCategory: FeedCategory;
}) {
  const normalizedMunicipalities = useMemo(
    () =>
      municipalities.map((item) => ({
        name_key: normalizeMunicipality(item.name_key),
        name_sq: String(item.name_sq || "").trim(),
      })),
    [municipalities]
  );
  const municipalitySet = useMemo(
    () => new Set(normalizedMunicipalities.map((item) => item.name_key)),
    [normalizedMunicipalities]
  );

  const fallbackMunicipality = useMemo(() => {
    const defaultKey = normalizeMunicipality(defaultMunicipality);
    if (defaultKey && municipalitySet.has(defaultKey)) return defaultKey;
    if (municipalitySet.has("tirane")) return "tirane";
    return normalizedMunicipalities[0]?.name_key || "tirane";
  }, [defaultMunicipality, municipalitySet, normalizedMunicipalities]);

  const [selectedMunicipality, setSelectedMunicipality] = useState(fallbackMunicipality);

  useEffect(() => {
    setSelectedMunicipality(fallbackMunicipality);
  }, [fallbackMunicipality]);

  useEffect(() => {
    try {
      const stored = normalizeMunicipality(window.localStorage.getItem(STORAGE_KEY) || "");
      if (stored && municipalitySet.has(stored)) {
        setSelectedMunicipality(stored);
      }
    } catch {
      // Ignore storage errors and keep fallback value.
    }
  }, [municipalitySet]);

  function handleMunicipalityChange(value: string) {
    const normalized = normalizeMunicipality(value);
    setSelectedMunicipality(normalized);
    try {
      window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // Ignore storage errors.
    }
  }

  const targetMunicipality = selectedMunicipality || fallbackMunicipality;
  const href = `/municipality/${encodeURIComponent(targetMunicipality)}?category=${encodeURIComponent(
    selectedCategory
  )}`;

  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={targetMunicipality}
          onChange={(event) => handleMunicipalityChange(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800"
          aria-label="Select municipality feed"
        >
          {normalizedMunicipalities.map((item) => (
            <option key={item.name_key} value={item.name_key}>
              {item.name_sq}
            </option>
          ))}
        </select>
        <Link
          href={href}
          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700"
        >
          Njoftimet e Bashkisë
        </Link>
      </div>
    </div>
  );
}
