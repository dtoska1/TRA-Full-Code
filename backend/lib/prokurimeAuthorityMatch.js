"use strict";

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTermWithGenitiveVariants(term) {
  const normalized = normalizeText(term);
  if (!normalized) return [];

  const parts = normalized.split(" ").filter(Boolean);
  if (!parts.length) return [];

  const variants = new Set([normalized]);
  const last = parts[parts.length - 1];
  if (last.length >= 4) {
    for (const suffix of ["S", "SE", "IT", "UT"]) {
      const alt = [...parts];
      alt[alt.length - 1] = `${last}${suffix}`;
      variants.add(alt.join(" "));
    }
  }

  return Array.from(variants.values());
}

function containsTermSequence(text, termVariant) {
  if (!text || !termVariant) return false;
  const escaped = escapeRegex(termVariant);
  const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`);
  return re.test(text);
}

function buildMunicipalityTermSet({ nameKey, nameSq, aliasKeys = [] }) {
  const terms = new Set();

  const addTerm = (value) => {
    for (const variant of buildTermWithGenitiveVariants(value)) {
      if (!variant) continue;
      terms.add(variant);
    }
  };

  addTerm(nameSq);
  addTerm(String(nameKey || "").replace(/-/g, " "));
  for (const alias of aliasKeys) {
    addTerm(String(alias || "").replace(/-/g, " "));
  }

  return Array.from(terms.values()).sort((a, b) => b.length - a.length);
}

function matchAuthorityToMunicipality({ authority, municipalityTerms }) {
  const normalizedAuthority = normalizeText(authority);
  if (!normalizedAuthority) {
    return {
      matched: false,
      reason: "missing_authority",
      matched_term: null,
    };
  }

  const hasBashkiaMarker = /\bBASHKIA\b/.test(normalizedAuthority);
  const hasMunicipalityOfMarker = /\bMUNICIPALITY\s+OF\b/.test(normalizedAuthority);
  if (!hasBashkiaMarker && !hasMunicipalityOfMarker) {
    return {
      matched: false,
      reason: "missing_municipality_marker",
      matched_term: null,
    };
  }

  const authorityAfterBashkia = (() => {
    const m = normalizedAuthority.match(/\bBASHKIA\b/);
    if (!m || m.index === undefined) return "";
    const tail = normalizedAuthority.slice(m.index + m[0].length).trim();
    return tail.replace(/^E\s+/, "").trim();
  })();

  const authorityAfterMunicipalityOf = (() => {
    const m = normalizedAuthority.match(/\bMUNICIPALITY\s+OF\b/);
    if (!m || m.index === undefined) return "";
    return normalizedAuthority.slice(m.index + m[0].length).trim();
  })();

  const terms = Array.isArray(municipalityTerms) ? municipalityTerms : [];
  for (const term of terms) {
    const normalizedTerm = normalizeText(term);
    if (!normalizedTerm) continue;

    const matchedByBashkia =
      authorityAfterBashkia && containsTermSequence(authorityAfterBashkia, normalizedTerm);
    const matchedByMunicipalityOf =
      authorityAfterMunicipalityOf &&
      containsTermSequence(authorityAfterMunicipalityOf, normalizedTerm);
    if (matchedByBashkia || matchedByMunicipalityOf) {
      return {
        matched: true,
        reason: matchedByBashkia ? "matched_bashkia" : "matched_municipality_of",
        matched_term: normalizedTerm,
      };
    }
  }

  return {
    matched: false,
    reason: "unclear_authority_name",
    matched_term: null,
  };
}

module.exports = {
  buildMunicipalityTermSet,
  matchAuthorityToMunicipality,
  normalizeText,
};
