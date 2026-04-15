import type { Metadata } from "next";
import VerticalFeedPage from "../components/vertical-feed-page";
import { QueryMap, firstValue, normalizeMunicipality, normalizePage, normalizeSort, normalizeYear } from "../lib/public-feed";
import { VERTICAL_THEMES } from "../lib/verticals";
import { buildOpenGraph, buildPageTitle } from "../metadata";

function buildMetadataCopy(municipality: string, year: string) {
  const segments = ["Konsultime Publike"];
  if (municipality) segments.push(municipality);
  if (year) segments.push(year);

  const titleCore = segments.join(" ");
  const description = municipality
    ? `Konsultimet publike të publikuara për ${municipality}${year ? ` në ${year}` : ""}.`
    : `Konsultimet publike nga të gjitha bashkitë${year ? ` në ${year}` : ""}.`;

  return { titleCore, description };
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}): Promise<Metadata> {
  const query = await searchParams;
  const municipality = normalizeMunicipality(firstValue(query, "municipality"));
  const year = normalizeYear(firstValue(query, "year"));
  const sort = normalizeSort(firstValue(query, "sort"));
  const page = normalizePage(firstValue(query, "page"));

  const canonicalQuery = new URLSearchParams();
  if (municipality) canonicalQuery.set("municipality", municipality);
  if (year) canonicalQuery.set("year", year);
  if (sort !== "newest") canonicalQuery.set("sort", sort);
  if (page > 1) canonicalQuery.set("page", String(page));

  const canonical = canonicalQuery.toString()
    ? `/konsultime?${canonicalQuery.toString()}`
    : "/konsultime";
  const { titleCore, description } = buildMetadataCopy(municipality, year);
  const title = buildPageTitle(titleCore);

  return {
    title,
    description,
    alternates: {
      canonical,
    },
    openGraph: {
      ...buildOpenGraph({
        title,
        description,
      }),
      url: canonical,
    },
  };
}

export default async function KonsultimePage({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}) {
  return (
    <VerticalFeedPage
      searchParams={searchParams}
      theme={VERTICAL_THEMES.konsultime}
      title="Konsultime publike dhe njoftime"
      description="Shfleto konsultimet publike të publikuara nga bashkitë dhe përdor filtrat për të fokusuar vitin apo bashkinë që po monitoron."
    />
  );
}
