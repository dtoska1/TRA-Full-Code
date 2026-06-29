import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Metodologjia",
  description:
    "Si zgjidhen burimet, si ruhet provenanca dhe cilat masa cilësie zbaton platforma Transparency Radar Albania.",
  alternates: { canonical: "/metodologjia" },
};

export default function Metodologjia() {
  return (
    <main className="bg-white">
      {/* Hero */}
      <section className="bg-slate-950 text-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#6EE7D8]">
            Metodologjia
          </p>
          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Si funksionon Transparency Radar Albania
          </h1>
          <p className="mt-6 text-base leading-7 text-slate-300 sm:text-lg">
            Kjo faqe shpjegon si zgjidhen burimet, si mblidhen të dhënat, si ruhet
            provenanca institucionale dhe cilat masa cilësie zbaton platforma për të
            siguruar besueshmëri dhe pajtueshmëri ligjore.
          </p>
        </div>
      </section>

      {/* Si zgjidhen bashkitë */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          1. Si zgjidhen bashkitë prioritare
        </h2>
        <div className="mt-6 space-y-4 text-base leading-7 text-slate-700">
          <p>
            Platforma mbulon të 61 bashkitë e Shqipërisë në nivel bazë përmes burimeve
            qendrore. Për fazën e parë (v1), pesë bashki janë përzgjedhur për mbulim të
            thelluar &mdash; me skraperë të dedikuar, kontroll cilësie dhe verifikim të rregullt.
          </p>
          <p>
            Përzgjedhja bazohet në një vlerësim cilësor institucional, jo në një metodologji
            vetëm teknike. Dimensionet që merren parasysh janë:
          </p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {[
            {
              title: "Disponueshmëria e informacionit publik",
              body: "Bashkia duhet të demonstrojë praktika të dukshme dhe të rregullta publikimi për vendimet, konsultimet dhe prokurimet.",
            },
            {
              title: "Kultura institucionale e transparencës",
              body: "Një minimum angazhimi institucional për transparencë proaktive dhe informim të qytetarëve.",
            },
            {
              title: "Përfaqësim gjeografik",
              body: "Kampioni duhet të mbulojë Shqipërinë qendrore, veriore, jugore, bregdetare dhe të brendshme.",
            },
            {
              title: "Përfaqësim demografik dhe social",
              body: "Mbulim i një pjese të konsiderueshme të popullsisë dhe diversitet social, ekonomik dhe urban.",
            },
            {
              title: "Mundësi për zgjerim",
              body: "Bazë realiste për zgjerim drejt bashkive shtesë në fazat e ardhshme.",
            },
            {
              title: "Ekuilibër politik dhe institucional",
              body: "Përfaqësim i balancuar që shmang përqendrimin e tepruar në një qendër të vetme institucionale.",
            },
          ].map((d) => (
            <div key={d.title} className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-base font-semibold text-slate-900">{d.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{d.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Burimet e të dhënave */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            2. Burimet e të dhënave
          </h2>
          <div className="mt-6 space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
                Burim baseline (mbulim kombëtar)
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">vendime.al</h3>
              <p className="mt-3 text-base leading-7 text-slate-700">
                Përdoret si burim baseline për vendimet bashkiake nga të 61 bashkitë. Garanton
                konsistencë dhe mbulim kombëtar.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
                Burim baseline për prokurimin
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">
                Agjencia e Prokurimit Publik (APP)
              </h3>
              <p className="mt-3 text-base leading-7 text-slate-700">
                APP është burimi institucional zyrtar i centralizuar për njoftime dhe procedura
                prokurimi. Përdorimi i tij është ligjërisht i përshtatshëm dhe i preferuar.
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
                Burime zyrtare bashkiake (suplementare)
              </p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">
                Faqet zyrtare të bashkive
              </h3>
              <p className="mt-3 text-base leading-7 text-slate-700">
                Për bashkitë prioritare, faqet zyrtare përdoren si burim suplementar për të
                rritur freskinë dhe për të mbushur boshllëqet. Burimi zyrtar nuk e bllokon
                publikimin baseline; vetëm e plotëson atë.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Si ruhet provenanca */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          3. Si ruhet provenanca
        </h2>
        <p className="mt-6 text-base leading-7 text-slate-700">
          Çdo regjistrim në platformë ruan informacion të plotë provenance:
        </p>
        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-left text-slate-700">
              <tr>
                <th className="px-4 py-3 font-semibold">Fusha</th>
                <th className="px-4 py-3 font-semibold">Përshkrimi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              <tr>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">municipality</td>
                <td className="px-4 py-3 text-slate-700">Bashkia origjinuese</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">published_date</td>
                <td className="px-4 py-3 text-slate-700">Data zyrtare e publikimit</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">source_origin</td>
                <td className="px-4 py-3 text-slate-700">Domain-i i burimit (p.sh. tirana.al)</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">source_page_url</td>
                <td className="px-4 py-3 text-slate-700">URL-ja e faqes ku u gjet dokumenti</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">category</td>
                <td className="px-4 py-3 text-slate-700">Vendim, Prokurim ose Konsultim</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">first_seen / last_seen</td>
                <td className="px-4 py-3 text-slate-700">Kur u pa për herë të parë / të fundit</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Ruajtja e provenancës është thelbësore për integritetin informacional dhe
          llogaridhënien institucionale.
        </p>
      </section>

      {/* Masat e cilësisë */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            4. Masat e cilësisë dhe pajtueshmërisë
          </h2>
          <div className="mt-6 space-y-4">
            {[
              {
                n: "4.1",
                title: "Integriteti i burimit",
                body: "Çdo informacion ruan referencë të qartë institucionale: bashki, datë publikimi, burim origjinal, URL e faqes burim.",
              },
              {
                n: "4.2",
                title: "Mbrojtja e të dhënave",
                body: "Shmangim ekspozimi i panevojshëm i të dhënave personale dhe sigurojmë proporcionalitet në ripublikim.",
              },
              {
                n: "4.3",
                title: "Dallimi mes drafteve dhe akteve",
                body: "Materialet e konsultimit dallohen qartë nga vendimet e miratuara, për të shmangur konfuzion mbi statusin ligjor të dokumenteve.",
              },
              {
                n: "4.4",
                title: "Eliminim i dublikatave",
                body: "Logjika e dedup-it parandalon shfaqjen e të njëjtit dokument disa herë kur vjen nga burime të ndryshme (p.sh. vendime.al + faqja zyrtare).",
              },
              {
                n: "4.5",
                title: "Verifikim periodik",
                body: "Skraperët kontrollohen rregullisht; rezultatet auditohen; problemet raportohen përmes faqes së statusit publik.",
              },
              {
                n: "4.6",
                title: "Deklaratë institucionale",
                body: "Platforma përfshin një deklaratë publike që sqaron se shërben për qëllime transparence dhe që burimet origjinale mbeten autoritare.",
              },
            ].map((m) => (
              <div key={m.n} className="rounded-xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
                  {m.n}
                </p>
                <h3 className="mt-1 text-base font-semibold text-slate-900">{m.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{m.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Roli i platformës */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          5. Roli i platformës dhe kufijtë
        </h2>
        <div className="mt-6 space-y-4 text-base leading-7 text-slate-700">
          <p>
            Transparency Radar Albania nuk është burimi ligjërisht autoritar i informacionit
            bashkiak. Roli i saj është agregim, organizim dhe publikim i informacionit që
            është tashmë publik nga burime institucionale.
          </p>
          <p>
            Platforma mbështet objektiva më të gjera demokratike duke përmirësuar dukshmërinë
            e vendimmarrjes lokale dhe duke forcuar aksesin publik në informacion. Ajo nuk
            zëvendëson detyrimin e bashkive për transparencë dhe nuk pretendon plotësi absolute.
          </p>
          <p>
            Nëse vëreni një gabim, mospërputhje ose informacion të pasaktë, ju lutemi të na
            njoftoni. Burimet origjinale institucionale mbeten referenca ligjore zyrtare.
          </p>
        </div>
      </section>

      {/* Lidhje për më shumë */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">Lexo më shumë</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              href="/baza-ligjore"
              className="group block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-[#2AA198]"
            >
              <span className="font-semibold text-slate-900 group-hover:text-[#15524D]">
                Baza Ligjore →
              </span>
            </Link>
            <Link
              href="/rreth-projektit"
              className="group block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-[#2AA198]"
            >
              <span className="font-semibold text-slate-900 group-hover:text-[#15524D]">
                Rreth Projektit →
              </span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
