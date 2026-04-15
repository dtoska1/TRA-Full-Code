import type { Metadata } from "next";
import type { ReactNode } from "react";
import Footer from "./components/Footer";
import SiteHeader from "./components/site-header";
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
        <SiteHeader />
        <div className="relative z-10">{children}</div>
        <Footer />
      </body>
    </html>
  );
}
