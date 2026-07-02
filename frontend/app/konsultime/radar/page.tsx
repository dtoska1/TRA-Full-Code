import type { Metadata } from "next";
import Link from "next/link";
import {
  ConsultationScoreIndicator,
  ConsultationScoreMunicipality,
  ConsultationScoreSort,
  formatScoreDate,
  getConsultationScores,
  normalizeConsultationScoreSort,
  sortConsultationScores,
} from "../../lib/consultation-scores";
import { QueryMap, firstValue } from "../../lib/public-feed";
import { buildOpenGraph, buildPageTitle } from "../../metadata";

export const metadata: Metadata = {
  title: buildPageTitle("Radar i Konsultimeve Publike"),
  description:
    "Indeksi publik i vleresimit automatik per konsultimet publike ne 61 bashkite e Shqiperise.",
  alternates: { canonical: "/konsultime/radar" },
  openGraph: buildOpenGraph({
    title: buildPageTitle("Radar i Konsultimeve Publike"),
    description:
      "Indeksi publik i vleresimit automatik per konsultimet publike ne 61 bashkite e Shqiperise.",
  }),
};

function tierClassName(tier: string): string {
  const normalized = String(tier || "").toLowerCase();
  if (normalized === "excellent") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (normalized === "good") return "border-teal-200 bg-teal-50 text-teal-800";
  if (normalized === "moderate") return "border-amber-200 bg-amber-50 text-amber-800";
  if (normalized === "weak") return "border-orange-200 bg-orange-50 text-orange-800";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

function confidenceClassName(confidence: string): string {
  const normalized = String(confidence || "").toLowerCase();
  if (normalized === "high") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (normalized === "medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function sortLabel(sort: ConsultationScoreSort): string {
  if (sort === "total_asc") return "Pike me te uleta";
  if (sort === "name_asc") return "Bashkia A-Z";
  return "Pike me te larta";
}

function scoreBarWidth(total: number): string {
  return `${Math.max(0, Math.min(100, Number(total || 0)))}%`;
}

function IndicatorRow({ indicator }: { indicator: ConsultationScoreIndicator }) {
  const confidence = String(indicator.confidence || "low").toLowerCase();
  const pendingReview = confidence === "low" && Number(indicator.score || 0) === 0;

  return (
    <article
      className={`rounded-[18px] border p-4 ${
        pendingReview
          ? "border-dashed border-slate-300 bg-slate-50"
          : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Indikatori {indicator.n}
          </p>
          <h3 className="mt-1 text-base font-semibold text-slate-950">{indicator.name}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-900">
            {Number(indicator.score || 0)}/{Number(indicator.max || 20)}
          </span>
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] ${confidenceClassName(
              confidence,
            )}`}
          >
            {confidence}
          </span>
          {pendingReview ? (
            <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600">
              Ne verifikim
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        {indicator.argument || "Argumenti nuk eshte ende i disponueshem."}
      </p>
    </article>
  );
}

function MunicipalityScoreCard({
  item,
  defaultOpen,
}: {
  item: ConsultationScoreMunicipality;
  defaultOpen: boolean;
}) {
  return (
    <details className="group rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm open:shadow-md sm:p-6" open={defaultOpen}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${tierClassName(item.tier)}`}>
                {item.tier}
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {item.municipality_key}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-semibold tracking-tight text-slate-950">
              {item.municipality_name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Llogaritur me {formatScoreDate(item.computed_at)}
            </p>
          </div>

          <div className="w-full max-w-sm">
            <div className="flex items-end justify-between gap-4">
              <p className="text-sm font-medium text-slate-500">Totali</p>
              <p className="text-3xl font-semibold tracking-tight text-slate-950">
                {Number(item.total || 0)}
                <span className="text-base font-semibold text-slate-400">/100</span>
              </p>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-konsultime"
                style={{ width: scoreBarWidth(item.total) }}
                aria-hidden="true"
              />
            </div>
            <p className="mt-2 text-xs text-slate-500">Hap per te pare 5 indikatoret.</p>
          </div>
        </div>
      </summary>

      <div className="mt-6 grid gap-3">
        {item.indicators.map((indicator) => (
          <IndicatorRow key={indicator.n} indicator={indicator} />
        ))}
      </div>
    </details>
  );
}

export default async function ConsultationRadarPage({
  searchParams,
}: {
  searchParams: Promise<QueryMap>;
}) {
  const query = await searchParams;
  const sort = normalizeConsultationScoreSort(firstValue(query, "sort"));
  const { data, error } = await getConsultationScores();
  const municipalities = sortConsultationScores(data?.municipalities || [], sort);
  const topScore = municipalities[0]?.total || 0;
  const computedCount = municipalities.filter((item) => item.computed_at).length;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 pb-12 sm:px-6 sm:py-8 sm:pb-14">
      <section className="overflow-hidden rounded-[32px] border border-konsultime/25 bg-white shadow-soft">
        <div className="bg-gradient-to-br from-konsultime-light/90 via-white to-white px-6 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-konsultime-dark">
                Radar i konsultimeve
              </p>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                Vleresimi automatik i konsultimeve publike
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">
                Nje pamje krahasuese per te gjitha bashkite, bazuar ne matricen 100-pikeshe te
                konsultimit publik dhe provat qe platforma ka arritur te verifikoje automatikisht.
              </p>
            </div>
            <div className="rounded-[24px] border border-konsultime/20 bg-white/85 px-5 py-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                Bashki te vleresuara
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-konsultime-dark">
                {municipalities.length.toLocaleString("sq-AL")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-6 rounded-[28px] border border-amber-200 bg-amber-50 p-5 shadow-sm sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-800">
          Shenim metodologjik
        </p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
          Rezultatet jane verifikim automatik, me rishikim njerezor ne vijim.
        </h2>
        <p className="mt-3 text-sm leading-7 text-slate-700">
          Matrica bazohet ne Ligjin 146/2014 dhe perdor 5 indikatore me maksimum 100 pike.
          Indikatoret me argument "pending review" ose besueshmeri te ulet nuk jane deshmi e
          konfirmuar mungese; jane pika qe platforma nuk i verifikon ende automatikisht.
        </p>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Renditja
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{sortLabel(sort)}</p>
        </article>
        <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Pike maksimale lokale
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{topScore}/100</p>
        </article>
        <article className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Me date llogaritjeje
          </p>
          <p className="mt-2 text-2xl font-semibold text-slate-950">{computedCount}</p>
        </article>
      </section>

      <section className="mt-6 rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-konsultime-dark">
              Indeksi
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Te gjitha bashkite
            </h2>
          </div>
          <form method="GET" className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Rendit
              <select
                name="sort"
                defaultValue={sort}
                className="rounded-2xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition focus:border-konsultime focus:ring-2 focus:ring-konsultime/15"
              >
                <option value="total_desc">Pike me te larta</option>
                <option value="total_asc">Pike me te uleta</option>
                <option value="name_asc">Bashkia A-Z</option>
              </select>
            </label>
            <button
              type="submit"
              className="rounded-2xl bg-konsultime px-5 py-3 text-sm font-semibold text-white transition hover:bg-konsultime-dark"
            >
              Apliko
            </button>
            <Link
              href="/konsultime"
              className="rounded-2xl border border-slate-300 px-5 py-3 text-center text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Feed-i i konsultimeve
            </Link>
          </form>
        </div>

        {error ? (
          <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        <div className="mt-6 space-y-4">
          {municipalities.map((item, index) => (
            <MunicipalityScoreCard
              key={item.municipality_key}
              item={item}
              defaultOpen={index < 3}
            />
          ))}
        </div>

        {municipalities.length === 0 ? (
          <p className="mt-6 text-sm text-slate-500">
            Nuk ka ende vleresime te publikuara per konsultimet publike.
          </p>
        ) : null}
      </section>
    </main>
  );
}
