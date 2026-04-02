"use client";

import { useState } from "react";

type FeedItem = {
  id: string;
  title: string;
  source_url: string | null;
  category: string;
  municipality_name: string | null;
  published_at: string | null;
  collected_at: string | null;
};

function categoryBadgeClass(category: string): string {
  if (category === "Prokurime") return "bg-amber-100 text-amber-800";
  if (category === "Konsultime publike") return "bg-green-100 text-green-800";
  return "bg-blue-100 text-blue-800";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Pa datë";
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return "Pa datë";
  }
}

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
      <ul className="mt-4 divide-y divide-slate-100">
        {visibleItems.map((item) => (
          <li key={item.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span>{formatDate(item.published_at || item.collected_at)}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${categoryBadgeClass(item.category)}`}
              >
                {item.category}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{item.municipality_name || ""}</p>
            <p className="mt-0.5 text-sm font-medium leading-snug text-slate-900">
              {item.source_url ? (
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline"
                >
                  {item.title}
                </a>
              ) : (
                item.title
              )}
            </p>
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
          className="mt-4 w-full rounded-lg border border-slate-200 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700"
        >
          Shfaq më shumë ({items.length - visibleCount} të mbetura)
        </button>
      )}
    </>
  );
}
