"use strict";

const crypto = require("crypto");

const SESSION_COOKIE_NAME = "tra_admin_session";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_RE = /^[a-f0-9]{64}$/i;

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || ""), "utf8").digest("hex");
}

function normalizeRawToken(rawToken) {
  const cleaned = String(rawToken || "").trim();
  return SESSION_TOKEN_RE.test(cleaned) ? cleaned : "";
}

function readSessionCookie(req) {
  const cookieHeader = String(req?.headers?.cookie || "");
  if (!cookieHeader) return "";

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.split("=");
    if (String(name || "").trim() !== SESSION_COOKIE_NAME) continue;
    const rawValue = rest.join("=");
    try {
      return normalizeRawToken(decodeURIComponent(rawValue));
    } catch {
      return normalizeRawToken(rawValue);
    }
  }

  return "";
}

function setSessionCookie(res, rawToken, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
    expires: expiresAt,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
}

function cleanUserAgent(userAgent) {
  const cleaned = String(userAgent || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, 500) : null;
}

async function cleanupExpiredSessions(pool) {
  await pool.query(`DELETE FROM admin_sessions WHERE expires_at <= now()`);
}

async function createSession(pool, userId, userAgent) {
  await cleanupExpiredSessions(pool).catch(() => {});

  const rawToken = crypto.randomBytes(32).toString("hex");
  const sessionHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);

  await pool.query(
    `
    INSERT INTO admin_sessions (
      user_id,
      session_hash,
      expires_at,
      user_agent,
      last_seen_at
    )
    VALUES ($1, $2, $3, $4, now())
    `,
    [userId, sessionHash, expiresAt, cleanUserAgent(userAgent)]
  );

  return { rawToken, expiresAt };
}

async function validateSession(pool, rawToken) {
  const normalizedToken = normalizeRawToken(rawToken);
  if (!normalizedToken) return null;

  const sessionHash = hashToken(normalizedToken);
  const result = await pool.query(
    `
    SELECT
      s.id AS session_id,
      s.expires_at,
      s.last_seen_at,
      u.id AS user_id,
      u.email,
      u.display_name,
      u.is_active
    FROM admin_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_hash = $1
    LIMIT 1
    `,
    [sessionHash]
  );

  if (!result.rowCount) return null;

  const row = result.rows[0];
  const expiresAt = row.expires_at ? new Date(row.expires_at) : null;
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    await pool
      .query(`DELETE FROM admin_sessions WHERE session_hash = $1`, [sessionHash])
      .catch(() => {});
    return null;
  }

  if (row.is_active !== true) return null;

  await pool
    .query(
      `
      UPDATE admin_sessions
      SET last_seen_at = now()
      WHERE session_hash = $1
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')
      `,
      [sessionHash]
    )
    .catch(() => {});

  return {
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
    },
  };
}

async function destroySession(pool, rawToken) {
  const normalizedToken = normalizeRawToken(rawToken);
  if (!normalizedToken) return;
  await pool.query(`DELETE FROM admin_sessions WHERE session_hash = $1`, [
    hashToken(normalizedToken),
  ]);
}

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  clearSessionCookie,
  createSession,
  destroySession,
  hashToken,
  readSessionCookie,
  setSessionCookie,
  validateSession,
};
