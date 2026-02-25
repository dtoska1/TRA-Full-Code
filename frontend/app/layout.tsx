import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { buildOpenGraph, resolveMetadataBase } from "./metadata";

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: "Transparency Radar Albania",
    template: "%s | Transparency Radar Albania",
  },
  description:
    "Search and track published municipal transparency documents across Albania.",
  alternates: {
    canonical: "/",
  },
  openGraph: buildOpenGraph({
    title: "Transparency Radar Albania",
    description:
      "Search and track published municipal transparency documents across Albania.",
  }),
  twitter: {
    card: "summary_large_image",
    title: "Transparency Radar Albania",
    description:
      "Search and track published municipal transparency documents across Albania.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="sq">
      <body>{children}</body>
    </html>
  );
}
