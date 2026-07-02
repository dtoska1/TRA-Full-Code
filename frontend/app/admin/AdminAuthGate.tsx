"use client";

import Link from "next/link";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { getMe, login, logout } from "../lib/admin-auth";

type AuthState = "loading" | "login" | "authed";

export default function AdminAuthGate({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getMe().then((result) => {
      setAuthState(result.ok ? "authed" : "login");
    });
  }, []);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    const email = String(emailRef.current?.value || "").trim();
    const password = String(passwordRef.current?.value || "");
    if (!email || !password) {
      setLoginError("Plotëso të gjitha fushat.");
      return;
    }
    setLoginLoading(true);
    setLoginError(null);
    const result = await login(email, password);
    if (result.ok) {
      setAuthState("authed");
    } else {
      setLoginError(result.error ?? "Kredencialet janë të pasakta.");
      if (passwordRef.current) passwordRef.current.value = "";
    }
    setLoginLoading(false);
  }

  async function handleLogout() {
    await logout();
    setAuthState("login");
    setLoginError(null);
  }

  if (authState === "loading") {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-8 pb-12 sm:px-6">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
          <div className="animate-pulse">
            <div className="h-4 w-32 rounded bg-slate-200" />
            <div className="mt-4 h-10 w-72 rounded bg-slate-200" />
            <div className="mt-3 h-4 w-full max-w-2xl rounded bg-slate-200" />
            <div className="mt-8 h-12 w-full rounded bg-slate-200" />
          </div>
        </section>
      </main>
    );
  }

  if (authState === "login") {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8 pb-12 sm:px-6">
        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-soft sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Admin</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
            Transparency Radar Albania
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-600">
            Kyçu për të hyrë në panelin e administrimit.
          </p>

          <form onSubmit={handleLogin} className="mt-8 space-y-4">
            <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Email
              <input
                ref={emailRef}
                type="email"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                placeholder="admin@example.com"
                autoComplete="email"
                required
              />
            </label>

            <label className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Fjalëkalimi
              <input
                ref={passwordRef}
                type="password"
                className="mt-2 w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-500"
                autoComplete="current-password"
                required
              />
            </label>

            <button
              type="submit"
              disabled={loginLoading}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loginLoading ? "Duke u kyçur…" : "Hyr"}
            </button>
          </form>

          {loginError ? (
            <p className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {loginError}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <>
      <nav className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-1">
            <Link
              href="/admin"
              className="rounded-xl px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-950"
            >
              Panel Admin
            </Link>
            <Link
              href="/admin/consultation-scores"
              className="rounded-xl px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-950"
            >
              Rishikimet e Konsultimeve
            </Link>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 hover:text-slate-950"
          >
            Dil
          </button>
        </div>
      </nav>
      {children}
    </>
  );
}
