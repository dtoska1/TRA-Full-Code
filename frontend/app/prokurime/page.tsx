import type { Metadata } from "next";
import VerticalFeedPage from "../components/vertical-feed-page";
import { QueryMap, firstValue, normalizeMunicipality, normalizePage, normalizeSort, normalizeYear } from "../lib/public-feed";
import { VERTICAL_THEMES } from "../lib/verticals";
import { buildOpenGraph, buildPageTitle } from "../metadata";

function buildMetadataCopy(municipality: string, year: string) {
  const segments = ["Prokurime"];
  if (municipality) segments.push(municipality);
  if (year) segments.push(year);

  const titleCore = segments.join(" ");
  const description = municipality
    ? `Njoftimet e prokurimit të publikuara për ${municipality}${year ? ` në ${year}` : ""}.`
    : `Njoftimet e prokurimit nga të gjitha bashkitë${year ? ` në ${year}` : ""}.`;

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
    ? `/prokurime?${canonicalQuery.toString()}`
    : "/prokurime";
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

export default async function ProkurimePage({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}) {
  return (
    <VerticalFeedPage
      searchParams={searchParams}
      theme={VERTICAL_THEMES.prokurime}
      title="Prokurime dhe njoftime publike"
      description="Ndjek njoftimet e prokurimit për bashkitë, filtro sipas vendndodhjes ose vitit dhe lëviz nëpër faqet e rezultateve pa humbur filtrat."
    />
  );
}
