import type { Metadata } from "next";

const FALLBACK_SITE_URL = "http://localhost:3000";

export function resolveSiteUrl(): string {
  const raw = String(process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  if (!raw) return FALLBACK_SITE_URL;
  return raw.replace(/\/+$/, "");
}

export function resolveMetadataBase(): URL {
  try {
    return new URL(resolveSiteUrl());
  } catch {
    return new URL(FALLBACK_SITE_URL);
  }
}

export function buildPageTitle(value: string): string {
  return `${value} | Transparency Radar Albania`;
}

export function buildOpenGraph(overrides: {
  title: string;
  description: string;
}): NonNullable<Metadata["openGraph"]> {
  return {
    type: "website",
    locale: "sq_AL",
    siteName: "Transparency Radar Albania",
    title: overrides.title,
    description: overrides.description,
  };
}
