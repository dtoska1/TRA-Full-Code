"use strict";

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

  const ind2 = hasText(konsultimeUrl)
    ? score(
        10,
        "medium",
        `A consultation register was found (${konsultimeUrl}). Not assessed for dedicated / mobile-friendly / intuitive access (20 pts) - pending review.`
      )
    : score(0, "low", "No consultation register source configured - pending review.");

  let ind3;
  if (consultationAttachmentCount > 0) {
    ind3 = score(
      10,
      "medium",
      `${consultationItemsCount} consultation items published with ${consultationAttachmentCount} archived documents across ${consultationItemsWithAttachments} items. Archived documents are used as the current proxy because consultation kind is not persisted. Plain-language explanatory memos not verified (20 pts requires document text review) - pending review.`
    );
  } else if (consultationItemsCount > 0) {
    ind3 = score(
      5,
      "low",
      `${consultationItemsCount} consultation items found but no documents archived - pending review.`
    );
  } else {
    ind3 = score(0, "low", "No consultation drafts/documents found - pending review.");
  }

  return {
    ind1: score(
      0,
      "low",
      "No annual consultation calendar detected in scraped sources. May exist on the municipal website - pending review."
    ),
    ind2,
    ind3,
    ind4: score(
      0,
      "low",
      "Consultation-to-vote timeframe could not be automatically verified (no reliable link between consultations and council decisions). Pending review."
    ),
    ind5: score(
      0,
      "low",
      "No post-consultation institutional response reports detected in scraped sources. May exist - pending review."
    ),
  };
}

module.exports = {
  computeConsultationScore,
  neutralPendingReviewScore,
  sanitizePlainText,
};
