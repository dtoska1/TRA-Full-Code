type StatusCounts = {
  OK: number;
  BLOCKED: number;
  DOWN: number;
  ERROR: number;
  UNKNOWN: number;
};

type BlockedMunicipality = {
  name_key: string;
  url: string | null;
  cooldown_until_utc: string | null;
};

type VendimeStatusResponse = {
  generated_at_utc: string;
  counts: StatusCounts;
  blocked: BlockedMunicipality[];
};

const FALLBACK_COUNTS: StatusCounts = {
  OK: 0,
  BLOCKED: 0,
  DOWN: 0,
  ERROR: 0,
  UNKNOWN: 0,
};

function formatUtc(value: string | null): string {
  if (!value) return "N/A";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return date.toUTCString();
}

async function getVendimeStatus(): Promise<{
  data: VendimeStatusResponse | null;
  error: string | null;
}> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";
  const url = `${apiBaseUrl.replace(/\/+$/, "")}/api/status/vendime`;

  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { data: null, error: `Backend returned HTTP ${response.status}` };
    }

    const json = (await response.json()) as VendimeStatusResponse;
    return { data: json, error: null };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : "Failed to load status",
    };
  }
}

export default async function StatusPage() {
  const { data, error } = await getVendimeStatus();
  const counts = data?.counts ?? FALLBACK_COUNTS;
  const blocked = data?.blocked ?? [];

  return (
    <main className="mx-auto w-full max-w-5xl p-4 pb-10 sm:p-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Public Status</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Vendime Scrape Health</h1>
        <p className="mt-2 text-sm text-slate-600">
          Source: <code>{process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050"}</code>
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Generated: {data?.generated_at_utc ? formatUtc(data.generated_at_utc) : "N/A"}
        </p>
        {error ? (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}
      </section>

      <section className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {Object.entries(counts).map(([label, value]) => (
          <article
            key={label}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
          </article>
        ))}
      </section>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Blocked Municipalities</h2>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-600">
                <th className="py-2 pr-4 font-medium">name_key</th>
                <th className="py-2 pr-4 font-medium">url</th>
                <th className="py-2 font-medium">cooldown_until_utc</th>
              </tr>
            </thead>
            <tbody>
              {blocked.map((item) => (
                <tr key={item.name_key} className="border-b border-slate-100 align-top">
                  <td className="py-3 pr-4 font-medium text-slate-900">{item.name_key}</td>
                  <td className="py-3 pr-4">
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-blue-700 underline"
                      >
                        {item.url}
                      </a>
                    ) : (
                      <span className="text-slate-500">N/A</span>
                    )}
                  </td>
                  <td className="py-3 text-slate-700">{formatUtc(item.cooldown_until_utc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {blocked.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">No blocked municipalities.</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
