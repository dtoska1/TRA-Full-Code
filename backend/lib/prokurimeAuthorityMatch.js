"use strict";

const LOCAL_OPERATOR_PREFIXES = [
  "NDERMARRJA E SHERBIMEVE PUBLIKE",
  "NDERMARRJA E PASURIVE PUBLIKE",
  "NDERMARRJA E PASTRIMIT",
  "AGJENCIA E SHERBIMEVE PUBLIKE",
  "AGJENCIA E SHERBIMEVE PUBLIKE RURALE",
  "NDERMARRJA RRUGA",
];

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

function hasTermSuffix(text, termVariant) {
  if (!text || !termVariant) return false;
  const escaped = escapeRegex(termVariant);
  const re = new RegExp(`(?:^|\\s)${escaped}$`);
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
      match_mode: null,
      matched_prefix: null,
      reason: "missing_authority",
      matched_term: null,
    };
  }

  const hasBashkiaMarker = /\bBASHKIA\b/.test(normalizedAuthority);
  const hasMunicipalityOfMarker = /\bMUNICIPALITY\s+OF\b/.test(normalizedAuthority);
  if (!hasBashkiaMarker && !hasMunicipalityOfMarker) {
    return {
      matched: false,
      match_mode: null,
      matched_prefix: null,
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
        match_mode: "primary",
        matched_prefix: null,
        reason: matchedByBashkia ? "matched_bashkia" : "matched_municipality_of",
        matched_term: normalizedTerm,
      };
    }
  }

  return {
    matched: false,
    match_mode: null,
    matched_prefix: null,
    reason: "unclear_authority_name",
    matched_term: null,
  };
}

function getAllowedLocalOperatorPrefix(normalizedAuthority) {
  if (!normalizedAuthority) return null;
  for (const prefix of LOCAL_OPERATOR_PREFIXES) {
    if (
      normalizedAuthority === prefix ||
      normalizedAuthority.startsWith(`${prefix} `)
    ) {
      return prefix;
    }
  }
  return null;
}

function matchAuthorityToMunicipalityAcrossContexts({ authority, municipalityContexts }) {
  const contexts = Array.isArray(municipalityContexts) ? municipalityContexts : [];
  const normalizedAuthority = normalizeText(authority);
  if (!normalizedAuthority) {
    return {
      matched: false,
      municipalityContext: null,
      match_mode: null,
      matched_prefix: null,
      reason: "missing_authority",
      matched_term: null,
    };
  }

  const hasBashkiaMarker = /\bBASHKIA\b/.test(normalizedAuthority);
  const hasMunicipalityOfMarker = /\bMUNICIPALITY\s+OF\b/.test(normalizedAuthority);

  for (const municipalityContext of contexts) {
    const primaryMatch = matchAuthorityToMunicipality({
      authority,
      municipalityTerms: municipalityContext?.municipalityTerms,
    });
    if (!primaryMatch.matched) continue;
    return {
      ...primaryMatch,
      municipalityContext,
    };
  }

  const matchedPrefix = getAllowedLocalOperatorPrefix(normalizedAuthority);
  if (!matchedPrefix) {
    return {
      matched: false,
      municipalityContext: null,
      match_mode: null,
      matched_prefix: null,
      reason:
        hasBashkiaMarker || hasMunicipalityOfMarker
          ? "unclear_authority_name"
          : "missing_municipality_marker",
      matched_term: null,
    };
  }

  const fallbackCandidates = [];
  for (const municipalityContext of contexts) {
    const terms = Array.isArray(municipalityContext?.municipalityTerms)
      ? municipalityContext.municipalityTerms
      : [];
    let matchedTerm = null;
    for (const term of terms) {
      const normalizedTerm = normalizeText(term);
      if (!normalizedTerm) continue;
      if (!hasTermSuffix(normalizedAuthority, normalizedTerm)) continue;
      matchedTerm = normalizedTerm;
      break;
    }
    if (!matchedTerm) continue;
    fallbackCandidates.push({
      municipalityContext,
      matchedTerm,
    });
    if (fallbackCandidates.length > 1) {
      return {
        matched: false,
        municipalityContext: null,
        match_mode: null,
        matched_prefix: null,
        reason: "ambiguous_fallback_municipality_suffix",
        matched_term: null,
      };
    }
  }

  if (!fallbackCandidates.length) {
    return {
      matched: false,
      municipalityContext: null,
      match_mode: null,
      matched_prefix: null,
      reason: "fallback_suffix_not_unique",
      matched_term: null,
    };
  }

  return {
    matched: true,
    municipalityContext: fallbackCandidates[0].municipalityContext,
    match_mode: "fallback_local_operator",
    matched_prefix: matchedPrefix,
    reason: "matched_fallback_local_operator",
    matched_term: fallbackCandidates[0].matchedTerm,
  };
}

module.exports = {
  LOCAL_OPERATOR_PREFIXES,
  buildMunicipalityTermSet,
  matchAuthorityToMunicipality,
  matchAuthorityToMunicipalityAcrossContexts,
  normalizeText,
};
