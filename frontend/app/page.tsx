import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center p-4 sm:p-6">
      <div className="w-full rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Transparency Radar Albania</p>
        <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-900">
          Public Transparency Surfaces
        </h1>
        <p className="mt-3 text-sm text-slate-600">
          Track ingestion health and upcoming public feed views in one place.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Link
            href="/status"
            className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-base font-semibold text-white"
          >
            Public Status
          </Link>
          <span className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-slate-50 px-5 py-3 text-base font-medium text-slate-600">
            Feed (coming soon)
          </span>
        </div>
      </div>
    </main>
  );
}
