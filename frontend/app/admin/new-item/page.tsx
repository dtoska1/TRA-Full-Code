"use client";

import { type FormEvent, useState } from "react";
import { adminFetch } from "../../lib/admin-auth";

const CATEGORIES = ["Vendime", "Prokurime", "Konsultime publike"] as const;

type Mode = "source_url" | "file";

type ManualCreateResponse = {
  ok?: boolean;
  item_id?: string;
  attachment_id?: string | null;
  municipality_id?: string;
  category?: string;
  status?: string;
  error?: string;
  message?: string;
};

function toCleanString(value: string): string {
  return String(value || "").trim();
}

export default function AdminNewItemPage() {
  const [mode, setMode] = useState<Mode>("file");
  const [municipality, setMunicipality] = useState("tirane");
  const [municipalityId, setMunicipalityId] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("Vendime");
  const [title, setTitle] = useState("");
  const [publishedDate, setPublishedDate] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualCreateResponse | null>(null);

  const attachmentId = toCleanString(result?.attachment_id || "");
  const adminFilePath = attachmentId ? `/api/admin/files/${encodeURIComponent(attachmentId)}` : null;
  const publicFilePath = attachmentId ? `/api/public/files/${encodeURIComponent(attachmentId)}` : null;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const cleanTitle = toCleanString(title);
      if (!cleanTitle) {
        throw new Error("Title is required.");
      }

      const cleanMunicipality = toCleanString(municipality);
      const cleanMunicipalityId = toCleanString(municipalityId);
      if (!cleanMunicipality && !cleanMunicipalityId) {
        throw new Error("Provide municipality or municipality_id.");
      }

      const cleanSourceUrl = toCleanString(sourceUrl);
      if (mode === "source_url") {
        if (!cleanSourceUrl) {
          throw new Error("source_url is required in URL mode.");
        }
        if (file) {
          throw new Error("Remove file input when using source_url mode.");
        }
      } else {
        if (!file) {
          throw new Error("PDF file is required in file mode.");
        }
        if (cleanSourceUrl) {
          throw new Error("Remove source_url when using file mode.");
        }
      }

      let response: Response;

      if (mode === "source_url") {
        const payload: Record<string, string> = {
          category,
          title: cleanTitle,
          source_url: cleanSourceUrl,
        };
        if (cleanMunicipality) payload.municipality = cleanMunicipality;
        if (cleanMunicipalityId) payload.municipality_id = cleanMunicipalityId;
        if (toCleanString(publishedDate)) payload.published_date = toCleanString(publishedDate);

        response = await adminFetch("/api/admin/items/manual", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        const formData = new FormData();
        formData.set("category", category);
        formData.set("title", cleanTitle);
        if (cleanMunicipality) formData.set("municipality", cleanMunicipality);
        if (cleanMunicipalityId) formData.set("municipality_id", cleanMunicipalityId);
        if (toCleanString(publishedDate)) formData.set("published_date", toCleanString(publishedDate));
        if (file) formData.set("file", file);

        response = await adminFetch("/api/admin/items/manual", {
          method: "POST",
          body: formData,
        });
      }

      const text = await response.text();
      let json: ManualCreateResponse = {};
      try {
        json = JSON.parse(text) as ManualCreateResponse;
      } catch {
        json = {};
      }
      if (!response.ok || !json?.ok) {
        throw new Error(json?.message || json?.error || `Request failed with HTTP ${response.status}`);
      }

      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create manual item.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-4 pb-10 sm:p-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Admin</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Create Manual Item</h1>
        <p className="mt-2 text-sm text-slate-600">
          Public file links return 404 until item status becomes published.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input
              type="text"
              value={municipality}
              onChange={(e) => setMunicipality(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="municipality (name_key, e.g. tirane)"
              aria-label="municipality"
            />
            <input
              type="text"
              value={municipalityId}
              onChange={(e) => setMunicipalityId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="municipality_id (optional)"
              aria-label="municipality_id"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              aria-label="category"
            >
              {CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={publishedDate}
              onChange={(e) => setPublishedDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              aria-label="published_date"
            />
            <div className="flex items-center gap-3 rounded-lg border border-slate-300 px-3 py-2 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === "file"}
                  onChange={() => setMode("file")}
                />
                File
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={mode === "source_url"}
                  onChange={() => setMode("source_url")}
                />
                source_url
              </label>
            </div>
          </div>

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            placeholder="Title"
            aria-label="title"
            required
          />

          {mode === "source_url" ? (
            <input
              type="url"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              placeholder="source_url"
              aria-label="source_url"
              required
            />
          ) : (
            <input
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              aria-label="file"
              required
            />
          )}

          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Submitting..." : "Create manual item"}
          </button>
        </form>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        {result?.ok ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <p>Created item_id: {result.item_id}</p>
            <p>Status: {result.status}</p>
            {result.attachment_id ? <p>attachment_id: {result.attachment_id}</p> : null}
            {adminFilePath ? (
              <p className="mt-2">
                Admin file URL:{" "}
                <a
                  href={adminFilePath}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline"
                >
                  {adminFilePath}
                </a>
              </p>
            ) : null}
            {publicFilePath ? (
              <p>
                Public file URL:{" "}
                <a
                  href={publicFilePath}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline"
                >
                  {publicFilePath}
                </a>
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
