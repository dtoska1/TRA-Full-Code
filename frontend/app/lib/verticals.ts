export type VerticalKey = "vendime" | "prokurime" | "konsultime";
export type SupportedCategory = "Vendime" | "Prokurime" | "Konsultime publike";

export type VerticalTheme = {
  key: VerticalKey;
  category: SupportedCategory;
  label: string;
  shortLabel: string;
  href: string;
  accentClass: string;
  accentSoftClass: string;
  accentTextClass: string;
  accentBorderClass: string;
  accentRingClass: string;
  accentButtonClass: string;
  badgeClass: string;
  heroGlowClass: string;
};

export const VERTICAL_THEMES: Record<VerticalKey, VerticalTheme> = {
  vendime: {
    key: "vendime",
    category: "Vendime",
    label: "Vendime",
    shortLabel: "Vendime",
    href: "/vendime",
    accentClass: "bg-vendime",
    accentSoftClass: "bg-vendime-light",
    accentTextClass: "text-vendime-dark",
    accentBorderClass: "border-vendime/25",
    accentRingClass: "ring-vendime/15",
    accentButtonClass: "bg-vendime hover:bg-vendime-dark",
    badgeClass: "bg-vendime-light text-vendime-dark",
    heroGlowClass: "from-vendime-light/90 via-white to-white",
  },
  prokurime: {
    key: "prokurime",
    category: "Prokurime",
    label: "Prokurime",
    shortLabel: "Prokurime",
    href: "/prokurime",
    accentClass: "bg-prokurime",
    accentSoftClass: "bg-prokurime-light",
    accentTextClass: "text-prokurime-dark",
    accentBorderClass: "border-prokurime/25",
    accentRingClass: "ring-prokurime/15",
    accentButtonClass: "bg-prokurime hover:bg-prokurime-dark",
    badgeClass: "bg-prokurime-light text-prokurime-dark",
    heroGlowClass: "from-prokurime-light/90 via-white to-white",
  },
  konsultime: {
    key: "konsultime",
    category: "Konsultime publike",
    label: "Konsultime Publike",
    shortLabel: "Konsultime",
    href: "/konsultime",
    accentClass: "bg-konsultime",
    accentSoftClass: "bg-konsultime-light",
    accentTextClass: "text-konsultime-dark",
    accentBorderClass: "border-konsultime/25",
    accentRingClass: "ring-konsultime/15",
    accentButtonClass: "bg-konsultime hover:bg-konsultime-dark",
    badgeClass: "bg-konsultime-light text-konsultime-dark",
    heroGlowClass: "from-konsultime-light/90 via-white to-white",
  },
};

export const VERTICAL_LIST = [
  VERTICAL_THEMES.vendime,
  VERTICAL_THEMES.prokurime,
  VERTICAL_THEMES.konsultime,
];

export function getVerticalThemeByCategory(category: string | null | undefined): VerticalTheme {
  const normalized = String(category || "").trim().toLowerCase();
  if (normalized === "prokurime") return VERTICAL_THEMES.prokurime;
  if (normalized === "konsultime publike" || normalized === "konsultime-publike") {
    return VERTICAL_THEMES.konsultime;
  }
  return VERTICAL_THEMES.vendime;
}
