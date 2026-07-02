import type { Metadata } from "next";
import type { ReactNode } from "react";
import AdminAuthGate from "./AdminAuthGate";

export const metadata: Metadata = {
  title: "Admin | Transparency Radar Albania",
  robots: {
    index: false,
    follow: false,
  },
};

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <AdminAuthGate>{children}</AdminAuthGate>;
}
