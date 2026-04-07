import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import { buildOpenGraph, resolveMetadataBase } from "./metadata";

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: "Transparency Radar Albania — Vendime, Prokurime dhe Konsultime Bashkiake",
    template: "%s | Transparency Radar Albania",
  },
  description:
    "Platforma kombëtare e transparencës bashkiake. Kërko vendime, prokurime dhe konsultime publike nga të 61 bashkitë e Shqipërisë.",
  keywords: "transparencë, bashki, vendime bashkiake, prokurime, konsultime publike, Shqipëri",
  alternates: {
    canonical: "/",
  },
  openGraph: buildOpenGraph({
    title: "Transparency Radar Albania",
    description:
      "Kërko vendime, prokurime dhe konsultime publike nga të 61 bashkitë e Shqipërisë.",
  }),
  twitter: {
    card: "summary_large_image",
    title: "Transparency Radar Albania",
    description:
      "Kërko vendime, prokurime dhe konsultime publike nga të 61 bashkitë e Shqipërisë.",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Transparency Radar Albania",
  description: "Platforma kombëtare e transparencës bashkiake për të 61 bashkitë e Shqipërisë.",
  url: "https://transparencyradar.al",
  inLanguage: "sq",
  potentialAction: {
    "@type": "SearchAction",
    target: "https://transparencyradar.al/?q={search_term_string}",
    "query-input": "required name=search_term_string",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="sq">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <header className="w-full bg-slate-900 px-4 py-4 sm:px-6">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
            <div>
              <Link
                href="/"
                className="text-xs font-semibold uppercase tracking-widest text-blue-400"
              >
                Transparency Radar Albania
              </Link>
              <p className="mt-0.5 text-xs text-slate-400">
                Platforma kombëtare e transparencës bashkiake
              </p>
            </div>
            <nav aria-label="Navigim i faqes" className="flex items-center gap-4">
              <Link href="/vendime" className="text-sm font-medium text-slate-200 hover:text-white">
                Vendime
              </Link>
              <Link href="/prokurime" className="text-sm font-medium text-slate-200 hover:text-white">
                Prokurime
              </Link>
              <Link href="/konsultime" className="text-sm font-medium text-slate-200 hover:text-white">
                Konsultime
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
