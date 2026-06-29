import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Rreth Projektit",
  description:
    "Transparency Radar Albania është një platformë publike që mbledh dhe organizon vendime, prokurime dhe konsultime nga të 61 bashkitë e Shqipërisë.",
  alternates: { canonical: "/rreth-projektit" },
};

const priorityMunicipalities = [
  { name: "Tiranë", region: "Qendër" },
  { name: "Shkodër", region: "Veri" },
  { name: "Durrës", region: "Bregdet qendror" },
  { name: "Vlorë", region: "Bregdet jugor" },
  { name: "Pogradec", region: "Juglindje" },
];

export default function RrethProjektit() {
  return (
    <main className="bg-white">
      {/* Hero */}
      <section className="bg-slate-950 text-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#6EE7D8]">
            Rreth Projektit
          </p>
          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Një platformë publike për transparencën bashkiake në Shqipëri
          </h1>
          <p className="mt-6 text-base leading-7 text-slate-300 sm:text-lg">
            Transparency Radar Albania mbledh, organizon dhe paraqet informacion publik nga
            të 61 bashkitë e Shqipërisë &mdash; vendime të këshillit, njoftime prokurimi dhe
            konsultime publike &mdash; në një vend të vetëm, të kuptueshëm për qytetarin.
          </p>
        </div>
      </section>

      {/* Çfarë është TRA */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Çfarë është Transparency Radar Albania
        </h2>
        <div className="mt-6 space-y-4 text-base leading-7 text-slate-700">
          <p>
            Informacioni publik bashkiak në Shqipëri publikohet zyrtarisht, por shpesh është i
            shpërndarë në dhjetëra faqe të ndryshme, në formate të paqëndrueshme dhe pa një
            mënyrë të lehtë për qytetarët ta kërkojnë apo ta krahasojnë.
          </p>
          <p>
            Transparency Radar Albania (TRA) e adreson këtë problem duke ofruar një platformë
            kombëtare ku qytetarët, gazetarët dhe organizatat e shoqërisë civile mund të:
          </p>
          <ul className="list-disc space-y-2 pl-6 text-slate-700">
            <li>kërkojnë vendime të këshillit bashkiak nga të 61 bashkitë;</li>
            <li>shfletojnë njoftime prokurimi sipas bashkisë dhe vitit;</li>
            <li>identifikojnë konsultime publike të hapura për të cilat mund të dërgojnë komente;</li>
            <li>shohin burimin origjinal të çdo dokumenti me një klikim.</li>
          </ul>
        </div>
      </section>

      {/* Tre vertikalët */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Tre kategoritë e informacionit
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            <Link
              href="/vendime"
              className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-[#2AA198] hover:shadow-md"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
                Vendime
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900 group-hover:text-[#15524D]">
                Vendime bashkiake
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Vendimet e këshillave bashkiakë &mdash; akte administrative publike që rregullojnë
                jetën në komunitet.
              </p>
            </Link>
            <Link
              href="/prokurime"
              className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-blue-500 hover:shadow-md"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-600">
                Prokurime
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900 group-hover:text-blue-700">
                Njoftime prokurimi
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Procedura prokurimi nga Agjencia e Prokurimit Publik dhe burime bashkiake zyrtare.
              </p>
            </Link>
            <Link
              href="/konsultime"
              className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-orange-500 hover:shadow-md"
            >
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-600">
                Konsultime
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900 group-hover:text-orange-700">
                Konsultime publike
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Drafte aktesh dhe njoftime konsultimi për të cilat qytetarët mund të dërgojnë mendime.
              </p>
            </Link>
          </div>
        </div>
      </section>

      {/* Bashkitë prioritare v1 */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Pesë bashkitë prioritare për fazën e parë
        </h2>
        <p className="mt-4 text-base leading-7 text-slate-700">
          Platforma mbulon të 61 bashkitë në nivel bazë përmes burimeve qendrore. Për fazën
          e parë (v1), pesë bashki marrin mbulim të thelluar me skraperë të dedikuar dhe
          verifikim të cilësisë, sipas vlerësimit të dokumentit ligjor të projektit:
        </p>
        <ul className="mt-6 space-y-3">
          {priorityMunicipalities.map((m) => (
            <li
              key={m.name}
              className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3"
            >
              <span className="text-base font-semibold text-slate-900">{m.name}</span>
              <span className="text-sm text-slate-500">{m.region}</span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm leading-6 text-slate-600">
          Ky përzgjedhje siguron ekuilibër gjeografik (qendër, veri, jug, bregdet, vise të
          brendshme) dhe mbulim demografik të rëndësishëm. Faza e dytë do të zgjerojë mbulimin
          drejt bashkive shtesë.
        </p>
      </section>

      {/* Organizata zbatuese */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Organizata zbatuese
          </h2>
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
              CSDG
            </p>
            <h3 className="mt-2 text-xl font-semibold text-slate-900">
              Qendra për Studimin e Demokracisë dhe Qeverisjes
            </h3>
            <p className="mt-4 text-base leading-7 text-slate-700">
              CSDG është një organizatë e shoqërisë civile me seli në Tiranë që punon për
              forcimin e demokracisë lokale, transparencës institucionale dhe pjesëmarrjes
              qytetare në vendimmarrjen publike.
            </p>
            <p className="mt-4 text-base leading-7 text-slate-700">
              Transparency Radar Albania zbatohet nga CSDG si pjesë e iniciativës{" "}
              <em>Civic Data Lab Albania</em>, që synon forcimin e demokracisë digjitale dhe
              pjesëmarrjes qytetare në Shqipëri.
            </p>
          </div>
        </div>
      </section>

      {/* Lidhje për më shumë */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Mëso më shumë
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Link
            href="/baza-ligjore"
            className="group block rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-[#2AA198] hover:shadow-md"
          >
            <h3 className="text-lg font-semibold text-slate-900 group-hover:text-[#15524D]">
              Baza Ligjore →
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Ligjet shqiptare që mbështesin publikimin dhe agregimin e informacionit publik
              bashkiak.
            </p>
          </Link>
          <Link
            href="/metodologjia"
            className="group block rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-[#2AA198] hover:shadow-md"
          >
            <h3 className="text-lg font-semibold text-slate-900 group-hover:text-[#15524D]">
              Metodologjia →
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Si zgjidhen burimet, si ruhet provenanca dhe cilat masa mbrojtëse zbaton platforma.
            </p>
          </Link>
        </div>
      </section>
    </main>
  );
}
