import Link from "next/link";
import { FeedItem, SearchItem, formatDate, sourceHostFromUrl, toAbsoluteApiUrl } from "../lib/public-feed";
import { VerticalTheme, getVerticalThemeByCategory } from "../lib/verticals";

export function StatCard({
  label,
  value,
  hint,
  theme,
}: {
  label: string;
  value: string;
  hint: string;
  theme: VerticalTheme;
}) {
  return (
    <article
      className={`rounded-3xl border bg-white/90 p-5 shadow-sm ring-1 backdrop-blur ${theme.accentBorderClass} ${theme.accentRingClass}`}
    >
      <div className="flex items-center gap-3">
        <span className={`h-3 w-3 rounded-full ${theme.accentClass}`} aria-hidden="true" />
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">{label}</p>
      </div>
      <p className={`mt-4 text-3xl font-semibold tracking-tight ${theme.accentTextClass}`}>{value}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{hint}</p>
    </article>
  );
}

export function CategoryCard({
  title,
  description,
  count,
  theme,
}: {
  title: string;
  description: string;
  count: number;
  theme: VerticalTheme;
}) {
  return (
    <Link
      href={theme.href}
      className={`group relative overflow-hidden rounded-[28px] border bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg ${theme.accentBorderClass}`}
    >
      <div className={`absolute inset-x-0 top-0 h-1.5 ${theme.accentClass}`} aria-hidden="true" />
      <div
        className={`absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br opacity-80 blur-2xl ${theme.heroGlowClass}`}
        aria-hidden="true"
      />
      <div className="relative">
        <div className="flex items-center justify-between gap-4">
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${theme.badgeClass}`}>
            {title}
          </span>
          <span className="text-xs font-medium uppercase tracking-[0.2em] text-slate-400">
            {count.toLocaleString("sq-AL")}
          </span>
        </div>
        <h3 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">{title}</h3>
        <p className="mt-3 max-w-xs text-sm leading-6 text-slate-600">{description}</p>
        <div className="mt-6 flex items-center justify-between">
          <span className={`text-sm font-semibold ${theme.accentTextClass}`}>Shiko feed-in</span>
          <span className="text-slate-400 transition group-hover:translate-x-1">→</span>
        </div>
      </div>
    </Link>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  theme,
}: {
  eyebrow: string;
  title: string;
  description: string;
  theme: VerticalTheme;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className={`h-3 w-3 rounded-full ${theme.accentClass}`} aria-hidden="true" />
        <p className={`text-xs font-semibold uppercase tracking-[0.24em] ${theme.accentTextClass}`}>
          {eyebrow}
        </p>
      </div>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-600 sm:text-base">{description}</p>
    </div>
  );
}

export function FeedCard({
  item,
  theme,
  showMunicipality = true,
}: {
  item: FeedItem;
  theme?: VerticalTheme;
  showMunicipality?: boolean;
}) {
  const resolvedTheme = theme || getVerticalThemeByCategory(item.category);
  const publicFileUrl = toAbsoluteApiUrl(item.primary_attachment_public_url);

  return (
    <li
      className={`rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-slate-100 transition hover:shadow-md sm:p-6`}
    >
      <div className="flex gap-4">
        <div className={`hidden w-1 self-stretch rounded-full sm:block ${resolvedTheme.accentClass}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className={`rounded-full px-2.5 py-1 font-semibold ${resolvedTheme.badgeClass}`}>
              {item.category}
            </span>
            <span>{formatDate(item.published_at || item.collected_at)}</span>
            {showMunicipality && item.municipality_name ? <span>{item.municipality_name}</span> : null}
            <span>{sourceHostFromUrl(item.source_url)}</span>
          </div>
          <p className="mt-4 text-lg font-semibold leading-8 tracking-tight text-slate-950">
            {item.title}
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            {item.source_url ? (
              <a
                href={item.source_url}
                target="_blank"
                rel="noreferrer"
                className={`font-semibold underline underline-offset-4 ${resolvedTheme.accentTextClass}`}
              >
                Burimi
              </a>
            ) : null}
            {publicFileUrl ? (
              <a
                href={publicFileUrl}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-slate-700 underline underline-offset-4"
              >
                PDF Publik
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

export function SearchResultCard({ item }: { item: SearchItem }) {
  const theme = getVerticalThemeByCategory(item.category);
  const publicFileUrl = toAbsoluteApiUrl(item.primary_attachment_public_url);

  return (
    <li className={`rounded-[26px] border bg-white p-5 shadow-sm ${theme.accentBorderClass}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className={`rounded-full px-2.5 py-1 font-semibold ${theme.badgeClass}`}>
          {item.category || "Dokument"}
        </span>
        <span>{formatDate(item.published_at || item.collected_at)}</span>
        <span>{item.municipality_name || item.municipality_name_key || "Bashki e panjohur"}</span>
        <span>{item.source_host || "Burim i panjohur"}</span>
      </div>
      <p className="mt-4 text-lg font-semibold leading-8 tracking-tight text-slate-950">{item.title}</p>
      {item.summary ? <p className="mt-3 text-sm leading-7 text-slate-600">{item.summary}</p> : null}
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        {item.source_url ? (
          <a
            href={item.source_url}
            target="_blank"
            rel="noreferrer"
            className={`font-semibold underline underline-offset-4 ${theme.accentTextClass}`}
          >
            Burimi
          </a>
        ) : null}
        {publicFileUrl ? (
          <a
            href={publicFileUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-slate-700 underline underline-offset-4"
          >
            PDF Publik
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function FeedPagination({
  basePath,
  page,
  total,
  pageSize,
  query,
  theme,
}: {
  basePath: string;
  page: number;
  total: number;
  pageSize: number;
  query: Record<string, string>;
  theme: VerticalTheme;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  function buildHref(nextPage: number): string {
    const search = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value) search.set(key, value);
    });
    if (nextPage > 1) search.set("page", String(nextPage));
    const queryString = search.toString();
    return queryString ? `${basePath}?${queryString}` : basePath;
  }

  return (
    <nav
      aria-label="Navigim i faqeve"
      className="mt-6 flex flex-col gap-3 rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-slate-600">
        Faqja <span className="font-semibold text-slate-900">{page}</span> nga{" "}
        <span className="font-semibold text-slate-900">{totalPages}</span>
      </p>
      <div className="flex items-center gap-3">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Faqja paraardhëse
          </Link>
        ) : (
          <span className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-300">
            Faqja paraardhëse
          </span>
        )}
        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            className={`rounded-full px-4 py-2 text-sm font-semibold text-white transition ${theme.accentButtonClass}`}
          >
            Faqja tjetër
          </Link>
        ) : (
          <span className="rounded-full bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-500">
            Faqja tjetër
          </span>
        )}
      </div>
    </nav>
  );
}
