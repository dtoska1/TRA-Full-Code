import Link from "next/link";
import { CategoryCard, SearchResultCard, SectionHeading, StatCard } from "./components/public-cards";
import ProkurimeSpendSection from "./components/prokurime-spend-section";
import TeFunditList from "./components/te-fundit-list";
import {
  FeedItem,
  QueryMap,
  SearchResponse,
  firstValue,
  getFeed,
  getFeedTotal,
  normalizeSort,
  normalizeYear,
} from "./lib/public-feed";
import { SupportedCategory, VERTICAL_LIST, VERTICAL_THEMES } from "./lib/verticals";

type SearchCategory = "" | SupportedCategory;

function normalizeSearchCategory(value: string): SearchCategory {
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "vendime") return "Vendime";
  if (cleaned === "prokurime") return "Prokurime";
  if (cleaned === "konsultime publike" || cleaned === "konsultime-publike") {
    return "Konsultime publike";
  }
  return "";
}

async function searchPublishedItems(filters: {
  q: string;
  category: SearchCategory;
  year: string;
  sort: "newest" | "oldest";
}): Promise<{ data: SearchResponse | null; error: string | null }> {
  if (!filters.q.trim()) {
    return { data: null, error: null };
  }

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = new URL(`${apiBaseUrl.replace(/\/+$/, "")}/api/search`);
  url.searchParams.set("q", filters.q.trim());
  url.searchParams.set("limit", "20");
  url.searchParams.set("sort", filters.sort);
  if (filters.category) url.searchParams.set("category", filters.category);
  if (filters.year) url.searchParams.set("year", filters.year);

  try {
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) {
      return { data: null, error: `Search returned HTTP ${response.status}` };
    }
    const json = (await response.json()) as SearchResponse;
    return { data: json, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Search request failed",
    };
  }
}

async function getLatestItems(): Promise<{ items: FeedItem[]; error: string | null }> {
  const { data, error } = await getFeed({ limit: 10, page: 1, sort: "newest" });
  return { items: data?.items || [], error };
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}) {
  const params = await searchParams;
  const q = firstValue(params, "q").trim();
  const category = normalizeSearchCategory(firstValue(params, "category"));
  const year = normalizeYear(firstValue(params, "year"));
  const sort = normalizeSort(firstValue(params, "sort"));

  const [
    { data: searchData, error: searchError },
    { items: latestItems, error: latestError },
    vendimeTotal,
    prokurimeTotal,
    konsultimeTotal,
  ] = await Promise.all([
    searchPublishedItems({ q, category, year, sort }),
    getLatestItems(),
    getFeedTotal("Vendime"),
    getFeedTotal("Prokurime"),
    getFeedTotal("Konsultime publike"),
  ]);

  const categoryTotals: Record<SupportedCategory, number> = {
    Vendime: vendimeTotal,
    Prokurime: prokurimeTotal,
    "Konsultime publike": konsultimeTotal,
  };
  const totalAcrossVerticals = vendimeTotal + prokurimeTotal + konsultimeTotal;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 pb-12 sm:px-6 sm:py-8 sm:pb-14">
      <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-soft">
        <div className="grid gap-0 lg:grid-cols-[1.45fr_0.9fr]">
          <div className="relative overflow-hidden px-6 py-8 sm:px-8 sm:py-10">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(13,150,104,0.14),transparent_34%),radial-gradient(circle_at_65%_12%,rgba(25,118,210,0.12),transparent_26%),linear-gradient(180deg,rgba(255,255,255,0.96),rgba(248,250,252,0.96))]" />
            <div className="relative">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">
                Vëzhgim publik në shkallë kombëtare
              </p>
              <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-slate-950 sm:text-5xl">
                Dokumentet bashkiake më të rëndësishme, të mbledhura në një rrjedhë të vetme.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-8 text-slate-600">
                Transparency Radar Albania e bën më të thjeshtë ndjekjen e vendimeve, prokurimeve
                dhe konsultimeve publike për çdo bashki, me një përvojë të qartë, kërkueshme dhe
                të përdorshme në telefon.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Link
                  href="/vendime"
                  className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Hyr te vendimet
                </Link>
                <Link
                  href="/#kerko"
                  className="rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  Kërko në platformë
                </Link>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 bg-slate-950 px-6 py-8 text-white sm:px-8 lg:border-l lg:border-t-0">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#7DD3C7]">
              Panorama
            </p>
            <p className="mt-4 text-4xl font-semibold tracking-tight">
              {totalAcrossVerticals.toLocaleString("sq-AL")}
            </p>
            <p className="mt-2 text-sm leading-7 text-slate-300">
              Dokumente të publikuara në tre vertikalet kryesore të platformës.
            </p>

            <div className="mt-8 space-y-4">
              {VERTICAL_LIST.map((theme) => (
                <div
                  key={theme.key}
                  className="flex items-center justify-between rounded-[22px] border border-white/10 bg-white/5 px-4 py-4"
                >
                  <div className="flex items-center gap-3">
                    <span className={`h-3 w-3 rounded-full ${theme.accentClass}`} aria-hidden="true" />
                    <span className="text-sm font-medium text-white">{theme.shortLabel}</span>
                  </div>
                  <span className="text-sm font-semibold text-slate-200">
                    {categoryTotals[theme.category].toLocaleString("sq-AL")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Vendime"
          value={vendimeTotal.toLocaleString("sq-AL")}
          hint="Vendime të publikuara nga këshillat bashkiakë dhe organet vendore."
          theme={VERTICAL_THEMES.vendime}
        />
        <StatCard
          label="Prokurime"
          value={prokurimeTotal.toLocaleString("sq-AL")}
          hint="Njoftime dhe dokumente prokurimi për monitorim më të shpejtë."
          theme={VERTICAL_THEMES.prokurime}
        />
        <StatCard
          label="Konsultime"
          value={konsultimeTotal.toLocaleString("sq-AL")}
          hint="Konsultime publike të mbledhura për të ndjekur pjesëmarrjen qytetare."
          theme={VERTICAL_THEMES.konsultime}
        />
        <article className="rounded-3xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Rrjedhë e unifikuar
          </p>
          <p className="mt-4 text-2xl font-semibold tracking-tight">Të fundit nga gjithë vendi</p>
          <p className="mt-2 text-sm leading-7 text-slate-300">
            Një hyrje e vetme për t&apos;u orientuar shpejt mes zhvillimeve më të reja.
          </p>
        </article>
      </section>

      <section className="grid gap-8 xl:grid-cols-[1.4fr_0.9fr]">
        <div className="space-y-8">
          <section id="kerko" className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <SectionHeading
              eyebrow="Kërkim publik"
              title="Gjej dokumentet që të interesojnë"
              description="Përdor kërkimin për të filtruar sipas fjalës kyçe, kategorisë dhe vitit, pa lënë faqen kryesore."
              theme={VERTICAL_THEMES.prokurime}
            />

            <form method="GET" className="mt-8 space-y-4">
              <input type="hidden" name="sort" value="newest" />
              <div className="grid gap-4 lg:grid-cols-[1.6fr_0.8fr_0.6fr_auto]">
                <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Kërko
                  <input
                    type="text"
                    name="q"
                    id="q"
                    defaultValue={q}
                    placeholder="Titull, përmbledhje ose fjalë kyçe"
                    className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-prokurime focus:ring-2 focus:ring-prokurime/15"
                  />
                </label>
                <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Kategoria
                  <select
                    name="category"
                    defaultValue={category}
                    className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-prokurime focus:ring-2 focus:ring-prokurime/15"
                  >
                    <option value="">Të gjitha kategoritë</option>
                    <option value="Vendime">Vendime</option>
                    <option value="Prokurime">Prokurime</option>
                    <option value="Konsultime publike">Konsultime</option>
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Viti
                  <input
                    type="number"
                    name="year"
                    min={2000}
                    max={2100}
                    defaultValue={year}
                    placeholder="YYYY"
                    className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-prokurime focus:ring-2 focus:ring-prokurime/15"
                  />
                </label>
                <div className="flex items-end">
                  <button
                    type="submit"
                    className="w-full rounded-2xl bg-prokurime px-5 py-3 text-sm font-semibold text-white transition hover:bg-prokurime-dark"
                  >
                    Kërko
                  </button>
                </div>
              </div>
            </form>

            <div className="mt-6 flex flex-wrap gap-2">
              {VERTICAL_LIST.map((theme) => (
                <Link
                  key={theme.key}
                  href={`${theme.href}?sort=newest`}
                  className={`rounded-full px-3 py-1.5 text-sm font-semibold ${theme.badgeClass}`}
                >
                  {theme.shortLabel}
                </Link>
              ))}
            </div>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <SectionHeading
              eyebrow="Tre rrjedha tematike"
              title="Shko drejtpërdrejt te vertikalja që po ndjek"
              description="Secila faqe është e stiluar sipas llojit të dokumenteve që përmban dhe ruan filtrat kryesorë për orientim më të shpejtë."
              theme={VERTICAL_THEMES.vendime}
            />
            <div className="mt-8 grid gap-4 lg:grid-cols-3">
              <CategoryCard
                title="Vendime"
                description="Vendime këshilli, akte dhe dokumente të publikuara nga bashkitë."
                count={vendimeTotal}
                theme={VERTICAL_THEMES.vendime}
              />
              <CategoryCard
                title="Prokurime"
                description="Njoftime prokurimi dhe dokumente që ndihmojnë monitorimin e shpenzimeve publike."
                count={prokurimeTotal}
                theme={VERTICAL_THEMES.prokurime}
              />
              <CategoryCard
                title="Konsultime"
                description="Procese konsultimi dhe njoftime publike për pjesëmarrje qytetare."
                count={konsultimeTotal}
                theme={VERTICAL_THEMES.konsultime}
              />
            </div>
          </section>
        </div>

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8 xl:sticky xl:top-28">
          <SectionHeading
            eyebrow="Të fundit"
            title="Publikimet më të reja"
            description="Një përmbledhje e shkurtër e dokumenteve më të fundit nga i gjithë vendi."
            theme={VERTICAL_THEMES.konsultime}
          />
          {latestError ? (
            <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {latestError}
            </p>
          ) : (
            <TeFunditList items={latestItems} />
          )}
        </section>
      </section>

      <ProkurimeSpendSection
        eyebrow="Shpenzimet publike"
        title="Ku shkojnë paratë publike?"
        description="Ky vizualizim tregon se si shpërndahet vlera e prokurimeve sipas kategorive kryesore, për të ndihmuar qytetarët të shohin më qartë prioritetet e shpenzimit publik."
      />

      <section
        id="rreth-platformes"
        className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
      >
        <SectionHeading
          eyebrow="Rreth platformës"
          title="Një hapësirë publike për monitorim, krahasim dhe qasje më të lehtë"
          description="Platforma bashkon burime të shpërndara dhe i sjell në një strukturë të lexueshme për qytetarë, organizata dhe gazetarë."
          theme={VERTICAL_THEMES.vendime}
        />
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <article className="rounded-[26px] border border-slate-200 bg-slate-50 p-5">
            <h2 className="text-lg font-semibold text-slate-950">
              Qasje e përmirësuar në informacionin publik
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              Qytetarët, organizatat e shoqërisë civile dhe gazetarët mund të përdorin një
              platformë të vetme për të ndjekur vendimet bashkiake, të dhënat e prokurimit dhe
              konsultimet në të gjithë Shqipërinë.
            </p>
          </article>
          <article className="rounded-[26px] border border-slate-200 bg-slate-50 p-5">
            <h2 className="text-lg font-semibold text-slate-950">Demokraci dixhitale në veprim</h2>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              Transparency Radar Albania e kthen informacionin publik të fragmentuar në të dhëna të
              aksesueshme dhe të veprueshme, për të mbështetur pjesëmarrjen dhe llogaridhënien
              vendore.
            </p>
          </article>
        </div>
      </section>

      {searchError ? (
        <section className="rounded-[28px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {searchError}
        </section>
      ) : null}

      {q ? (
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <SectionHeading
            eyebrow="Rezultate kërkimi"
            title={`Rezultate për “${q}”`}
            description={`U gjetën ${searchData?.total || 0} rezultate për kriteret e zgjedhura.`}
            theme={VERTICAL_THEMES.prokurime}
          />
          <ul className="mt-8 space-y-4">
            {(searchData?.items || []).map((item) => (
              <SearchResultCard key={item.id} item={item} />
            ))}
          </ul>
          {(searchData?.items || []).length === 0 ? (
            <p className="mt-6 text-sm text-slate-500">Nuk u gjetën rezultate për këtë kërkim.</p>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
