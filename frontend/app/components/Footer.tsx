import Link from "next/link";

const categoryLinks = [
  { href: "/vendime", label: "Vendime" },
  { href: "/prokurime", label: "Prokurime" },
  { href: "/konsultime", label: "Konsultime" },
];

const aboutLinks = [
  { href: "/#rreth-platformes", label: "Rreth platformës" },
  { href: "/#kerko", label: "Kërko në platformë" },
  { href: "/status", label: "Statusi publik" },
];

export default function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-slate-950 text-slate-200">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#6EE7D8]">CSDG</p>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-white">
            Transparency Radar Albania
          </h2>
          <p className="mt-4 max-w-xl text-sm leading-7 text-slate-400">
            Një hapësirë publike për të ndjekur dokumentet bashkiake, për të krahasuar zhvillimet
            mes bashkive dhe për të forcuar llogaridhënien vendore.
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold text-white">Kategoritë</p>
          <ul className="mt-4 space-y-3 text-sm text-slate-400">
            {categoryLinks.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="transition hover:text-white">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-sm font-semibold text-white">Rreth</p>
          <ul className="mt-4 space-y-3 text-sm text-slate-400">
            {aboutLinks.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="transition hover:text-white">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
