"use strict";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMunicipalityTermSet({ nameKey, nameSq, aliasKeys = [] }) {
  const terms = new Set();

  const addTerm = (value) => {
    const normalized = normalizeText(value);
    if (!normalized) return;
    terms.add(normalized);
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

  const hasMunicipalityMarker =
    /\bbashkia(?:\s+e)?\b/.test(normalizedAuthority) ||
    /\bmunicipality\s+of\b/.test(normalizedAuthority);
  if (!hasMunicipalityMarker) {
    return {
      matched: false,
      reason: "missing_municipality_marker",
      matched_term: null,
    };
  }

  const terms = Array.isArray(municipalityTerms) ? municipalityTerms : [];
  for (const term of terms) {
    if (!term) continue;
    const escaped = escapeRegex(term);
    const sqPattern = new RegExp(`\\bbashkia(?:\\s+e)?\\s+${escaped}(?:\\b|$)`);
    const enPattern = new RegExp(`\\bmunicipality\\s+of\\s+${escaped}(?:\\b|$)`);
    if (sqPattern.test(normalizedAuthority) || enPattern.test(normalizedAuthority)) {
      return {
        matched: true,
        reason: "matched",
        matched_term: term,
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
