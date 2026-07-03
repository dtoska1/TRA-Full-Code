"use strict";

const { foldText } = require("../scrapers/konsultimeUtils");

const CONSULTATION_CATEGORY = "Konsultime publike";
const ARGUMENT_MAX_LENGTH = 600;

function sanitizePlainText(value, maxLength = ARGUMENT_MAX_LENGTH) {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1).trim()}...` : cleaned;
}

function hasText(value) {
  return sanitizePlainText(value).length > 0;
}

function score(autoScore, confidence, argument) {
  return {
    auto_score: autoScore,
    confidence,
    argument: sanitizePlainText(argument),
  };
}

function normalizeEvidenceText(value) {
  return foldText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function hasPhrase(text, phrase) {
  const normalizedText = ` ${normalizeEvidenceText(text)} `;
  const normalizedPhrase = normalizeEvidenceText(phrase);
  return !!normalizedPhrase && normalizedText.includes(` ${normalizedPhrase} `);
}

function safeDecode(value) {
  const raw = String(value || "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function getUrlFileName(value) {
  try {
    const parsed = new URL(String(value || ""));
    return safeDecode(parsed.pathname.split("/").filter(Boolean).pop() || "");
  } catch {
    return "";
  }
}

function evidenceDocumentName(evidence) {
  const fromSource = getUrlFileName(evidence?.attachment_source_url);
  const fromStorage = String(evidence?.file_name || "").trim();
  const name = sanitizePlainText(fromSource || fromStorage || "archived document", 180);
  const sourceUrl = sanitizePlainText(evidence?.attachment_source_url || "", 320);
  return sourceUrl ? `${name} (${sourceUrl})` : name;
}

function buildEvidenceRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const attachmentText = normalizeEvidenceText(
      `${row.attachment_source_url || ""} ${row.file_name || ""}`
    );
    const itemText = normalizeEvidenceText(
      `${row.item_title || ""} ${row.item_summary || ""} ${row.item_source_url || ""}`
    );
    return {
      ...row,
      attachmentText,
      itemText,
      combinedText: `${itemText} ${attachmentText}`.trim(),
    };
  });
}

function isAnnualCalendarEvidence(evidence) {
  const annualItemContext =
    hasPhrase(evidence.itemText, "kalendari vjetor") ||
    hasPhrase(evidence.itemText, "plani i konsultimeve publike") ||
    hasPhrase(evidence.item_source_url, "kalendari vjetor i keshillit");
  const annualDocumentContext =
    hasPhrase(evidence.attachmentText, "kalendari vjetor") ||
    hasPhrase(evidence.attachmentText, "plani i konsultimeve publike") ||
    hasPhrase(evidence.attachmentText, "plani i aktiviteteve dhe plani i konsultimeve publike");
  const perItemCalendar =
    hasPhrase(evidence.attachmentText, "kalendari i konsultimit publik") ||
    hasPhrase(evidence.attachmentText, "kalendari i konsultimeve publike");

  if (perItemCalendar && !annualItemContext && !annualDocumentContext) return false;
  return annualItemContext || annualDocumentContext;
}

function isDraftActEvidence(evidence) {
  const text = evidence.attachmentText;
  return (
    hasPhrase(text, "projekt vendim") ||
    hasPhrase(text, "projektvendim") ||
    hasPhrase(text, "projekt akt") ||
    hasPhrase(text, "relacion") ||
    /\bpv\b/.test(text)
  );
}

function isConsultationResponseEvidence(evidence) {
  const text = evidence.attachmentText;
  if (hasPhrase(text, "procesverbal")) return false;
  if (hasPhrase(text, "raport permbledhes") || hasPhrase(text, "raport permbledhese")) {
    return true;
  }
  if (
    (hasPhrase(text, "raport") || hasPhrase(text, "permbledhes") || hasPhrase(text, "permbledhese")) &&
    hasPhrase(text, "konsultim")
  ) {
    return true;
  }
  return hasPhrase(text, "pergjigje") && hasPhrase(text, "konsultim");
}

function pickEvidence(evidenceRows, predicate, ranker = null) {
  const matches = evidenceRows.filter(predicate);
  if (!matches.length) return null;
  if (ranker) {
    matches.sort((left, right) => ranker(right) - ranker(left));
  }
  return matches[0];
}

function rankAnnualCalendarEvidence(evidence) {
  let rank = 0;
  if (hasPhrase(evidence.attachmentText, "plani i konsultimeve publike")) rank += 30;
  if (hasPhrase(evidence.attachmentText, "kalendari vjetor")) rank += 25;
  if (hasPhrase(evidence.itemText, "kalendari vjetor")) rank += 20;
  if (String(evidence.published_date || "").startsWith("2026")) rank += 5;
  return rank;
}

function neutralPendingReviewScore() {
  return {
    ind1: score(
      0,
      "low",
      "Pending review - could not auto-compute consultation score from available public evidence."
    ),
    ind2: score(
      0,
      "low",
      "Pending review - could not auto-compute consultation score from available public evidence."
    ),
    ind3: score(
      0,
      "low",
      "Pending review - could not auto-compute consultation score from available public evidence."
    ),
    ind4: score(
      0,
      "low",
      "Pending review - could not auto-compute consultation score from available public evidence."
    ),
    ind5: score(
      0,
      "low",
      "Pending review - could not auto-compute consultation score from available public evidence."
    ),
  };
}

async function loadConsultationEvidence(pool, municipalityId) {
  const result = await pool.query(
    `
    SELECT
      m.id AS municipality_id,
      m.name_key,
      m.name_sq,
      sr.konsultime_url,
      COALESCE(counts.consultation_items_count, 0)::int AS consultation_items_count,
      COALESCE(counts.consultation_items_with_attachments, 0)::int
        AS consultation_items_with_attachments,
      COALESCE(counts.consultation_attachment_count, 0)::int
        AS consultation_attachment_count
    FROM municipalities m
    LEFT JOIN LATERAL (
      SELECT konsultime_url
      FROM source_registry sr
      WHERE sr.municipality_id = m.id
        AND sr.is_primary = TRUE
      ORDER BY sr.updated_at DESC
      LIMIT 1
    ) sr ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT i.id)::int AS consultation_items_count,
        COUNT(DISTINCT i.id) FILTER (WHERE a.id IS NOT NULL)::int
          AS consultation_items_with_attachments,
        COUNT(a.id)::int AS consultation_attachment_count
      FROM items i
      LEFT JOIN attachments a ON a.item_id = i.id
      WHERE i.municipality_id = m.id
        AND i.category = $2
        AND i.status = 'published'
    ) counts ON TRUE
    WHERE m.id = $1
    LIMIT 1
    `,
    [municipalityId, CONSULTATION_CATEGORY]
  );

  return result.rowCount ? result.rows[0] : null;
}

async function loadConsultationAttachmentEvidence(pool, municipalityId) {
  const result = await pool.query(
    `
    SELECT
      i.id AS item_id,
      i.title AS item_title,
      i.summary AS item_summary,
      i.source_url AS item_source_url,
      i.published_date::text AS published_date,
      a.id AS attachment_id,
      a.file_name,
      a.mime_type,
      a.size_bytes,
      a.source_url AS attachment_source_url
    FROM items i
    JOIN attachments a ON a.item_id = i.id
    WHERE i.municipality_id = $1
      AND i.category = $2
      AND i.status = 'published'
    ORDER BY i.published_date DESC NULLS LAST, i.title, a.source_url
    `,
    [municipalityId, CONSULTATION_CATEGORY]
  );

  return buildEvidenceRows(result.rows);
}

function buildInd1Score(evidenceRows) {
  const evidence = pickEvidence(evidenceRows, isAnnualCalendarEvidence, rankAnnualCalendarEvidence);
  if (!evidence) {
    return score(
      0,
      "low",
      "No annual consultation calendar document detected in archived consultation attachments. Per-item consultation calendars are not counted as annual plans - pending review."
    );
  }
  return score(
    10,
    "medium",
    `Ind1=10 - consultation calendar/annual plan evidence identified: ${evidenceDocumentName(
      evidence
    )}. Full-year coverage and quality remain pending review.`
  );
}

function buildInd3Score({
  evidenceRows,
  consultationItemsCount,
  consultationAttachmentCount,
  consultationItemsWithAttachments,
}) {
  const evidence = pickEvidence(evidenceRows, isDraftActEvidence);
  if (evidence) {
    return score(
      10,
      "medium",
      `Ind3=10 - draft/project-act evidence identified: ${evidenceDocumentName(
        evidence
      )}. Plain-language explanatory material and completeness remain pending review.`
    );
  }

  if (consultationAttachmentCount > 0) {
    return score(
      5,
      "low",
      `${consultationItemsCount} consultation items published with ${consultationAttachmentCount} archived documents across ${consultationItemsWithAttachments} items, but no clear draft/project-act or relacion document was identified by conservative patterns - pending review.`
    );
  }

  if (consultationItemsCount > 0) {
    return score(
      5,
      "low",
      `${consultationItemsCount} consultation items found but no documents archived - pending review.`
    );
  }

  return score(0, "low", "No consultation drafts/documents found - pending review.");
}

function buildInd5Score(evidenceRows) {
  const evidence = pickEvidence(evidenceRows, isConsultationResponseEvidence);
  if (!evidence) {
    return score(
      0,
      "low",
      "No explicit post-consultation response or summary-report document detected in archived consultation attachments. Generic council reports and processverbals are not counted - pending review."
    );
  }
  return score(
    10,
    "medium",
    `Ind5=10 - consultation response/summary-report evidence identified: ${evidenceDocumentName(
      evidence
    )}. Whether it addresses public input remains pending review.`
  );
}

async function computeConsultationScore(pool, municipalityId) {
  const evidence = await loadConsultationEvidence(pool, municipalityId);
  if (!evidence) {
    const err = new Error("Municipality not found.");
    err.code = "MUNICIPALITY_NOT_FOUND";
    throw err;
  }

  const konsultimeUrl = sanitizePlainText(evidence.konsultime_url || "", 240);
  const consultationItemsCount = Number(evidence.consultation_items_count || 0);
  const consultationItemsWithAttachments = Number(
    evidence.consultation_items_with_attachments || 0
  );
  const consultationAttachmentCount = Number(evidence.consultation_attachment_count || 0);
  const attachmentEvidenceRows = await loadConsultationAttachmentEvidence(pool, municipalityId);

  const ind2 = hasText(konsultimeUrl)
    ? score(
        10,
        "medium",
        `A consultation register was found (${konsultimeUrl}). Not assessed for dedicated / mobile-friendly / intuitive access (20 pts) - pending review.`
      )
    : score(0, "low", "No consultation register source configured - pending review.");

  return {
    ind1: buildInd1Score(attachmentEvidenceRows),
    ind2,
    ind3: buildInd3Score({
      evidenceRows: attachmentEvidenceRows,
      consultationItemsCount,
      consultationAttachmentCount,
      consultationItemsWithAttachments,
    }),
    ind4: score(
      0,
      "low",
      "Consultation-to-vote timeframe could not be automatically verified (no reliable link between consultations and council decisions). Pending review."
    ),
    ind5: buildInd5Score(attachmentEvidenceRows),
  };
}

module.exports = {
  buildEvidenceRows,
  isAnnualCalendarEvidence,
  isConsultationResponseEvidence,
  isDraftActEvidence,
  computeConsultationScore,
  neutralPendingReviewScore,
  sanitizePlainText,
};
