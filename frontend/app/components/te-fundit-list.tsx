"use client";

import { useState } from "react";
import { formatDate } from "../lib/public-feed";
import { getVerticalThemeByCategory } from "../lib/verticals";

type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  municipality_name: string | null;
  published_at: string | null;
  collected_at: string | null;
};

const PAGE_SIZE = 5;

export default function TeFunditList({ items }: { items: FeedItem[] }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const visibleItems = items.slice(0, visibleCount);
  const hasMore = visibleCount < items.length;

  if (items.length === 0) {
    return <p className="mt-4 text-sm text-slate-500">Nuk ka të dhëna.</p>;
  }

  return (
    <>
      <ul className="mt-5 space-y-3">
        {visibleItems.map((item) => {
          const theme = getVerticalThemeByCategory(item.category);

          return (
            <li
              key={item.id}
              className="rounded-[22px] border border-slate-200 bg-white/90 p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className={`rounded-full px-2.5 py-1 font-semibold ${theme.badgeClass}`}>
                  {item.category}
                </span>
                <span>{formatDate(item.published_at || item.collected_at)}</span>
              </div>
              <p className="mt-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                {item.municipality_name || "Bashki e pacaktuar"}
              </p>
              <p className="mt-2 text-sm font-semibold leading-7 text-slate-950">
                {item.source_url ? (
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className={`underline underline-offset-4 ${theme.accentTextClass}`}
                  >
                    {item.title}
                  </a>
                ) : (
                  item.title
                )}
              </p>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
          className="mt-4 w-full rounded-full border border-slate-300 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600 transition hover:bg-slate-50 hover:text-slate-800"
        >
          Shfaq më shumë ({items.length - visibleCount} të mbetura)
        </button>
      )}
    </>
  );
}
