import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center p-6">
      <div className="w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold text-slate-900">Transparency Radar Albania</h1>
        <p className="mt-2 text-sm text-slate-600">
          Public operational surfaces for municipal ingestion.
        </p>
        <Link
          href="/status"
          className="mt-5 inline-flex rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Open Vendime Status
        </Link>
      </div>
    </main>
  );
}
