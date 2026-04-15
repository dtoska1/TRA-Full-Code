import Link from "next/link";

const mainLinks = [
  { href: "/vendime", label: "Vendime" },
  { href: "/prokurime", label: "Prokurime" },
  { href: "/konsultime", label: "Konsultime" },
];

const operatorLinks = [
  { href: "/coverage", label: "Mbulimi" },
  { href: "/admin/new-item", label: "Shto dokument" },
];

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-[#2AA198]/30 bg-slate-950/95 text-white shadow-sm backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <Link href="/" className="text-sm font-semibold uppercase tracking-[0.3em] text-[#6EE7D8]">
              Transparency Radar Albania
            </Link>
            <p className="mt-1 max-w-2xl text-sm text-slate-300">
              Platforma kombëtare për vendime, prokurime dhe konsultime publike nga të 61 bashkitë.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <nav aria-label="Navigim kryesor" className="flex flex-wrap items-center gap-2">
              {mainLinks.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-full px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 hover:text-white"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <Link
              href="/#kerko"
              className="inline-flex items-center justify-center rounded-full border border-[#2AA198]/40 bg-[#103B37] px-4 py-2 text-sm font-semibold text-[#D6FFFA] transition hover:bg-[#15524D]"
            >
              Kërko
            </Link>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Lidhje pune</p>
          <nav aria-label="Navigim pune" className="flex flex-wrap items-center gap-4">
            {operatorLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-xs font-medium text-slate-400 underline-offset-4 transition hover:text-slate-200 hover:underline"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}
