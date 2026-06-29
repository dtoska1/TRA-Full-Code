import ProkurimeSpendCard from "./prokurime-spend-card";
import { getMunicipalityOptions } from "../lib/public-feed";

export default async function ProkurimeSpendSection({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow?: string;
  title?: string;
  description?: string;
  className?: string;
}) {
  const { items: municipalities, error } = await getMunicipalityOptions();

  if (error) {
    return (
      <section className={`rounded-[32px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 ${className || ""}`.trim()}>
        {error}
      </section>
    );
  }

  return (
    <ProkurimeSpendCard
      municipalities={municipalities}
      eyebrow={eyebrow}
      title={title}
      description={description}
      className={className}
    />
  );
}
