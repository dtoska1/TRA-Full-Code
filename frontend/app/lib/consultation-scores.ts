import { getApiBaseUrl, normalizeMunicipality } from "./public-feed";

export type ConsultationScoreTier = "Excellent" | "Good" | "Moderate" | "Weak" | "Critical" | string;
export type ConsultationScoreConfidence = "high" | "medium" | "low" | string;
export type ConsultationScoreSort = "total_desc" | "total_asc" | "name_asc";

export type ConsultationScoreIndicator = {
  n: number;
  name: string;
  score: number;
  max: number;
  confidence: ConsultationScoreConfidence;
  argument: string;
};

export type ConsultationScoreMunicipality = {
  municipality_key: string;
  municipality_name: string;
  total: number;
  tier: ConsultationScoreTier;
  indicators: ConsultationScoreIndicator[];
  computed_at: string | null;
};

export type ConsultationScoresResponse = {
  ok: boolean;
  municipalities: ConsultationScoreMunicipality[];
};

export function normalizeConsultationScoreSort(value: string | null | undefined): ConsultationScoreSort {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "total_asc") return "total_asc";
  if (raw === "name_asc") return "name_asc";
  return "total_desc";
}

export function sortConsultationScores(
  items: ConsultationScoreMunicipality[],
  sort: ConsultationScoreSort,
): ConsultationScoreMunicipality[] {
  const sorted = [...items];
  if (sort === "total_asc") {
    return sorted.sort(
      (a, b) =>
        Number(a.total || 0) - Number(b.total || 0) ||
        String(a.municipality_name || "").localeCompare(String(b.municipality_name || ""), "sq"),
    );
  }
  if (sort === "name_asc") {
    return sorted.sort((a, b) =>
      String(a.municipality_name || "").localeCompare(String(b.municipality_name || ""), "sq"),
    );
  }
  return sorted.sort(
    (a, b) =>
      Number(b.total || 0) - Number(a.total || 0) ||
      String(a.municipality_name || "").localeCompare(String(b.municipality_name || ""), "sq"),
  );
}

export function formatScoreDate(value: string | null | undefined): string {
  if (!value) return "Pa datë";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Pa datë";
  return date.toISOString().slice(0, 10);
}

export async function getConsultationScores(options: {
  municipality?: string;
} = {}): Promise<{
  data: ConsultationScoresResponse | null;
  error: string | null;
}> {
  const apiBaseUrl = getApiBaseUrl();
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/consultation-scores`);
  const municipality = normalizeMunicipality(options.municipality);
  if (municipality) url.searchParams.set("municipality", municipality);

  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      return { data: null, error: `Backend returned HTTP ${response.status}` };
    }

    const json = (await response.json()) as ConsultationScoresResponse;
    if (!json?.ok || !Array.isArray(json.municipalities)) {
      return { data: null, error: "Backend returned invalid consultation score payload" };
    }

    return { data: json, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Failed to load consultation scores",
    };
  }
}
