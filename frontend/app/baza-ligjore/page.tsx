import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Baza Ligjore",
  description:
    "Ligjet shqiptare që mbështesin publikimin dhe agregimin e informacionit publik bashkiak në platformën Transparency Radar Albania.",
  alternates: { canonical: "/baza-ligjore" },
};

const laws = [
  {
    number: "Ligj nr. 119/2014",
    title: "Për të Drejtën e Informimit",
    role: "Bazë kryesore",
    summary:
      "Garanton të drejtën e çdo personi për të aksesuar informacionin publik dhe vendos detyrime për autoritetet publike që të publikojnë informacion institucional në mënyrë proaktive.",
    relevance:
      "Bashkitë janë të detyruara të publikojnë vendime, regjistra, informacion prokurimi, materiale konsultimi dhe dokumentacion të programit të transparencës.",
  },
  {
    number: "Ligj nr. 139/2015",
    title: "Për Vetëqeverisjen Vendore",
    role: "Mbështet publikimin e vendimeve",
    summary:
      "Përcakton që këshillat bashkiakë ushtrojnë autoritet publik dhe që veprimtaria e tyre vendimmarrëse duhet të jetë transparente dhe e aksesueshme.",
    relevance:
      "Vendimet e këshillit bashkiak janë akte administrative publike dhe rrjedhimisht të përshtatshme ligjërisht për agregim dhe publikim në iniciativa civile transparence.",
  },
  {
    number: "Ligj nr. 146/2014",
    title: "Për Njoftimin dhe Konsultimin Publik",
    role: "Mbështet publikimin e konsultimeve",
    summary:
      "Rregullon publikimin e drafteve të akteve dhe procesin e konsultimit publik. Detyron institucionet të publikojnë drafte, hapin procedura konsultimi, mbajnë regjistra konsultimi dhe njoftojnë qytetarët për rezultatet.",
    relevance:
      "Ofron bazë të fortë normative për përfshirjen e materialeve të konsultimit publik në platformë.",
  },
  {
    number: "Ligj nr. 162/2020",
    title: "Për Prokurimin Publik",
    role: "Bazë për të dhënat e prokurimit",
    summary:
      "Rregullon procedurat e prokurimit publik dhe administrohet nëpërmjet sistemit elektronik të centralizuar të menaxhuar nga Agjencia e Prokurimit Publik (APP).",
    relevance:
      "APP është burimi institucional zyrtar për njoftime dhe procedura prokurimi. Përdorimi i tij si burim parësor është ligjërisht i përshtatshëm dhe i preferuar.",
  },
  {
    number: "Ligj nr. 9887/2008",
    title: "Për Mbrojtjen e të Dhënave Personale",
    role: "Detyrim për mbrojtje të të dhënave",
    summary:
      "Vendos parimet e mbrojtjes së të dhënave personale dhe proporcionalitetit në publikimin e tyre.",
    relevance:
      "Edhe pse të dhënat e transparencës bashkiake janë në thelb publike, dokumente të caktuara mund të përmbajnë informacion personal. Platforma duhet të sigurojë proporcionalitet dhe të shmangë ekspozimin e panevojshëm të të dhënave personale.",
  },
];

export default function BazaLigjore() {
  return (
    <main className="bg-white">
      {/* Hero */}
      <section className="bg-slate-950 text-white">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6 sm:py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[#6EE7D8]">
            Baza Ligjore
          </p>
          <h1 className="mt-4 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Ligjet që mbështesin Transparency Radar Albania
          </h1>
          <p className="mt-6 text-base leading-7 text-slate-300 sm:text-lg">
            Mbledhja, organizimi dhe publikimi i informacionit publik bashkiak në këtë
            platformë mbështetet në kuadrin ligjor të Republikës së Shqipërisë për të drejtën e
            informimit, vetëqeverisjen vendore, konsultimin publik, prokurimin dhe mbrojtjen e
            të dhënave personale.
          </p>
        </div>
      </section>

      {/* Hyrje */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Hyrje
        </h2>
        <div className="mt-6 space-y-4 text-base leading-7 text-slate-700">
          <p>
            Transparenca dhe llogaridhënia janë parime themelore të qeverisjes demokratike dhe
            administrimit publik vendor në Shqipëri. Aksesi në vendimmarrjen bashkiake është i
            lidhur drejtpërdrejt me besimin publik, pjesëmarrjen qytetare dhe llogaridhënien
            institucionale.
          </p>
          <p>
            Platforma Transparency Radar Albania operon brenda parimit të përgjithshëm ligjor
            që informacioni bashkiak me interes publik duhet të jetë i aksesueshëm dhe i
            dukshëm për qytetarët.
          </p>
        </div>
      </section>

      {/* Pesë ligjet */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Pesë ligjet kryesore
          </h2>
          <div className="mt-8 space-y-6">
            {laws.map((law) => (
              <article
                key={law.number}
                className="rounded-2xl border border-slate-200 bg-white p-6"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#2AA198]">
                    {law.number}
                  </p>
                  <span className="text-xs text-slate-400">·</span>
                  <p className="text-xs font-medium text-slate-500">{law.role}</p>
                </div>
                <h3 className="mt-2 text-xl font-semibold text-slate-900">{law.title}</h3>
                <p className="mt-3 text-base leading-7 text-slate-700">{law.summary}</p>
                <div className="mt-4 rounded-lg bg-[#F0FBF9] p-4">
                  <p className="text-sm leading-6 text-[#0F4D47]">
                    <span className="font-semibold">Rëndësia për TRA: </span>
                    {law.relevance}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Pajtueshmëria e tre kategorive */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Pajtueshmëria ligjore e tre kategorive
        </h2>
        <div className="mt-6 space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Vendimet bashkiake</h3>
            <p className="mt-2 text-base leading-7 text-slate-700">
              Janë akte administrative publike që i nënshtrohen detyrimeve ligjore për publikim
              dhe transparencë. Agregimi i tyre në një platformë civile transparence është në
              përputhje me legjislacionin shqiptar për aksesin në informacion dhe vetëqeverisjen
              vendore.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Procedurat e prokurimit</h3>
            <p className="mt-2 text-base leading-7 text-slate-700">
              Janë publikisht të aksesueshme përmes kuadrit zyrtar të menaxhuar nga APP.
              Platforma ka të drejtë ligjore t&apos;i mbledhë dhe organizojë sipas bashkisë, duke
              ruajtur lidhjen me burimin zyrtar origjinal për të shmangur keqinterpretime.
            </p>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Materialet e konsultimit publik</h3>
            <p className="mt-2 text-base leading-7 text-slate-700">
              Kanë rëndësi të madhe demokratike sepse pasqyrojnë pjesëmarrjen qytetare dhe
              hapjen institucionale para vendimmarrjes. Platforma përfshin drafte aktesh,
              njoftime, regjistra dhe lajmërime, duke i dalluar qartë nga aktet e miratuara.
            </p>
          </div>
        </div>
      </section>

      {/* Masat mbrojtëse */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            Masat mbrojtëse që zbaton platforma
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-base font-semibold text-slate-900">Provenanca institucionale</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Çdo dokument ruan referencën e qartë te bashkia, data e publikimit dhe burimi
                zyrtar origjinal.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-base font-semibold text-slate-900">Dallimi mes drafteve dhe akteve</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Materialet e konsultimit dallohen qartë nga aktet e miratuara, për të shmangur
                konfuzion mbi statusin ligjor.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-base font-semibold text-slate-900">Mbrojtja e të dhënave personale</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Aplikohen parimet e proporcionalitetit dhe nevojshmërisë; shmangen riprodhimet e
                panevojshme të të dhënave personale.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <h3 className="text-base font-semibold text-slate-900">Burimi origjinal mbetet referencë</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                Çdo dokument lidhet me faqen origjinale institucionale, e cila mbetet burimi
                ligjërisht autoritar.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Deklarata institucionale */}
      <section className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Deklaratë institucionale
        </h2>
        <div className="mt-6 rounded-2xl border-l-4 border-[#2AA198] bg-[#F0FBF9] p-6">
          <ul className="space-y-3 text-base leading-7 text-slate-800">
            <li>
              <span className="font-semibold">·</span> Informacioni i publikuar në këtë platformë vjen nga
              burime publike institucionale zyrtare (faqet e bashkive, vendime.al, Agjencia e
              Prokurimit Publik).
            </li>
            <li>
              <span className="font-semibold">·</span> Platforma shërben për qëllime informimi, transparence
              dhe aksesi publik. Nuk është një burim ligjërisht autoritar në vetvete.
            </li>
            <li>
              <span className="font-semibold">·</span> Burimet origjinale institucionale mbeten referenca
              ligjore zyrtare. Për përdorim ligjor apo zyrtar, ju lutemi të konsultoni dokumentin
              origjinal te institucioni publikues.
            </li>
            <li>
              <span className="font-semibold">·</span> Nëse vëreni një gabim ose mospërputhje me burimin
              origjinal, ju lutemi të na njoftoni përmes faqes së kontaktit.
            </li>
          </ul>
        </div>
      </section>

      {/* Lidhje për më shumë */}
      <section className="bg-slate-50">
        <div className="mx-auto w-full max-w-4xl px-4 py-12 sm:px-6">
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">Lexo më shumë</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              href="/rreth-projektit"
              className="group block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-[#2AA198]"
            >
              <span className="font-semibold text-slate-900 group-hover:text-[#15524D]">
                Rreth Projektit →
              </span>
            </Link>
            <Link
              href="/metodologjia"
              className="group block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-[#2AA198]"
            >
              <span className="font-semibold text-slate-900 group-hover:text-[#15524D]">
                Metodologjia →
              </span>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
