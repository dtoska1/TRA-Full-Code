import Link from "next/link";
import { FeedCard, FeedPagination, SectionHeading } from "./public-cards";
import {
  FEED_PAGE_SIZE,
  QueryMap,
  firstValue,
  getFeed,
  getMunicipalityOptions,
  normalizeMunicipality,
  normalizePage,
  normalizeSort,
  normalizeYear,
} from "../lib/public-feed";
import { VerticalTheme } from "../lib/verticals";

export default async function VerticalFeedPage({
  searchParams,
  theme,
  title,
  description,
}: {
  searchParams: Promise<QueryMap>;
  theme: VerticalTheme;
  title: string;
  description: string;
}) {
  const query = await searchParams;
  const selectedMunicipality = normalizeMunicipality(firstValue(query, "municipality"));
  const selectedYear = normalizeYear(firstValue(query, "year"));
  const selectedSort = normalizeSort(firstValue(query, "sort"));
  const selectedPage = normalizePage(firstValue(query, "page"));

  const [{ data, error }, { items: municipalities, error: municipalitiesError }] = await Promise.all([
    getFeed({
      category: theme.category,
      municipality: selectedMunicipality,
      year: selectedYear,
      sort: selectedSort,
      page: selectedPage,
      limit: FEED_PAGE_SIZE,
    }),
    getMunicipalityOptions(),
  ]);

  const pagerQuery = {
    municipality: selectedMunicipality,
    year: selectedYear,
    sort: selectedSort,
  };

  const resetHref = `${theme.href}?sort=newest`;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 pb-12 sm:px-6 sm:py-8 sm:pb-14">
      <section
        className={`overflow-hidden rounded-[32px] border bg-white shadow-soft ${theme.accentBorderClass}`}
      >
        <div className={`bg-gradient-to-br ${theme.heroGlowClass} px-6 py-8 sm:px-8 sm:py-10`}>
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <SectionHeading
                eyebrow={theme.shortLabel}
                title={title}
                description={description}
                theme={theme}
              />
            </div>
            <div className={`rounded-[24px] border bg-white/80 px-5 py-4 shadow-sm ${theme.accentBorderClass}`}>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                Gjithsej dokumente
              </p>
              <p className={`mt-2 text-3xl font-semibold tracking-tight ${theme.accentTextClass}`}>
                {(data?.total || 0).toLocaleString("sq-AL")}
              </p>
            </div>
          </div>

          <form method="GET" className="mt-8 grid gap-4 rounded-[28px] border border-white/70 bg-white/80 p-5 shadow-sm lg:grid-cols-[1.1fr_0.65fr_0.65fr_auto_auto]">
            <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Bashkia
              <select
                name="municipality"
                defaultValue={selectedMunicipality}
                className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-500"
              >
                <option value="">Të gjitha bashkitë</option>
                {municipalities.map((item) => (
                  <option key={item.name_key} value={item.name_key}>
                    {item.name_sq}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Viti
              <input
                type="number"
                name="year"
                min={2000}
                max={2100}
                defaultValue={selectedYear}
                placeholder="YYYY"
                className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-500"
              />
            </label>

            <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Rendit
              <select
                name="sort"
                defaultValue={selectedSort}
                className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-slate-500"
              >
                <option value="newest">Më të rejat</option>
                <option value="oldest">Më të vjetrat</option>
              </select>
            </label>

            <div className="flex items-end">
              <button
                type="submit"
                className={`w-full rounded-2xl px-5 py-3 text-sm font-semibold text-white transition ${theme.accentButtonClass}`}
              >
                Apliko
              </button>
            </div>

            <div className="flex items-end">
              <Link
                href={resetHref}
                className="w-full rounded-2xl border border-slate-300 px-5 py-3 text-center text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Pastro filtrat
              </Link>
            </div>
          </form>

          {municipalitiesError ? (
            <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {municipalitiesError}
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-2 border-b border-slate-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className={`text-xs font-semibold uppercase tracking-[0.22em] ${theme.accentTextClass}`}>
              Rrjedha e dokumenteve
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Publikimet e fundit
            </h2>
          </div>
          <p className="text-sm text-slate-500">
            Shfaqen {Math.min(data?.items?.length || 0, FEED_PAGE_SIZE)} nga {(data?.total || 0).toLocaleString("sq-AL")} dokumente
          </p>
        </div>

        <ul className="mt-6 space-y-4">
          {(data?.items || []).map((item) => (
            <FeedCard key={item.id} item={item} theme={theme} />
          ))}
        </ul>

        {(data?.items || []).length === 0 ? (
          <p className="mt-6 text-sm text-slate-500">Nuk ka dokumente të publikuara për këto filtra.</p>
        ) : null}

        <FeedPagination
          basePath={theme.href}
          page={selectedPage}
          total={data?.total || 0}
          pageSize={FEED_PAGE_SIZE}
          query={pagerQuery}
          theme={theme}
        />
      </section>
    </main>
  );
}
