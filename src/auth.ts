import { timingSafeStringEqual } from "./secure-compare";

const PBKDF2_ITERATIONS = 100_000;
const LOGIN_WINDOW_MS = 10 * 60_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_BLOCK_MS = 15 * 60_000;

type AdminSession = {
  id: string;
  admin_id: string;
  last_seen_at: string;
  expires_at: string;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function derivePasswordHash(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return `${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [saltHex, expectedHex] = encoded.split(":");
  if (!saltHex || !expectedHex) return false;
  const actualHex = (await derivePasswordHash(password, fromHex(saltHex))).split(":")[1];
  return timingSafeStringEqual(actualHex, expectedHex);
}

async function verifySetupToken(providedToken: string, configuredToken: string): Promise<boolean> {
  return timingSafeStringEqual(providedToken, configuredToken);
}

export async function setupAdmin(
  db: D1Database,
  loginName: string,
  password: string,
  providedSetupToken: string,
  configuredSetupToken?: string,
): Promise<Response> {
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM admins`).first<{ count: number }>();
  if (count && count.count > 0) return Response.json({ error: "SETUP_ALREADY_COMPLETED" }, { status: 409 });
  if (!configuredSetupToken || configuredSetupToken.length < 32) {
    return Response.json({ error: "ADMIN_SETUP_NOT_CONFIGURED" }, { status: 503 });
  }
  if (!providedSetupToken || !(await verifySetupToken(providedSetupToken, configuredSetupToken))) {
    return Response.json({ error: "INVALID_SETUP_TOKEN" }, { status: 403 });
  }
  const normalizedLoginName = loginName.trim();
  if (normalizedLoginName.length < 3 || normalizedLoginName.length > 64) return Response.json({ error: "INVALID_LOGIN_NAME" }, { status: 400 });
  if (password.length < 12 || password.length > 256) return Response.json({ error: "INVALID_PASSWORD_LENGTH" }, { status: 400 });

  const now = new Date().toISOString();
  const passwordHash = await derivePasswordHash(password, crypto.getRandomValues(new Uint8Array(16)));
  await db.prepare(
    `INSERT INTO admins (id, login_name, password_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`,
  ).bind(crypto.randomUUID(), normalizedLoginName, passwordHash, now).run();
  return Response.json({ ok: true }, { status: 201 });
}

export async function getAdminSetupAvailability(db: D1Database, configuredSetupToken?: string): Promise<Response> {
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM admins`).first<{ count: number }>();
  return Response.json({ available: (count?.count ?? 0) === 0 && Boolean(configuredSetupToken && configuredSetupToken.length >= 32) }, {
    headers: { "cache-control": "no-store" },
  });
}

export async function recoverAdmin(
  db: D1Database,
  loginName: string,
  password: string,
  providedRecoveryToken: string,
  configuredRecoveryToken?: string,
): Promise<Response> {
  if (!configuredRecoveryToken || configuredRecoveryToken.length < 32) {
    return Response.json({ error: "ADMIN_RECOVERY_NOT_CONFIGURED" }, { status: 503 });
  }
  if (!(await verifySetupToken(providedRecoveryToken, configuredRecoveryToken))) {
    return Response.json({ error: "INVALID_RECOVERY_TOKEN" }, { status: 403 });
  }
  const normalizedLoginName = loginName.trim();
  if (normalizedLoginName.length < 3 || normalizedLoginName.length > 64) return Response.json({ error: "INVALID_LOGIN_NAME" }, { status: 400 });
  if (password.length < 12 || password.length > 256) return Response.json({ error: "INVALID_PASSWORD_LENGTH" }, { status: 400 });

  const admins = await db.prepare(`SELECT id FROM admins WHERE active = 1`).all<{ id: string }>();
  if (admins.results.length === 0) return Response.json({ error: "ADMIN_NOT_FOUND" }, { status: 409 });
  if (admins.results.length !== 1) return Response.json({ error: "ADMIN_RECOVERY_AMBIGUOUS" }, { status: 409 });

  const now = new Date().toISOString();
  const passwordHash = await derivePasswordHash(password, crypto.getRandomValues(new Uint8Array(16)));
  await db.batch([
    db.prepare(`UPDATE admins SET login_name = ?1, password_hash = ?2, updated_at = ?3 WHERE id = ?4`)
      .bind(normalizedLoginName, passwordHash, now, admins.results[0].id),
    db.prepare(`UPDATE admin_sessions SET revoked_at = ?1 WHERE admin_id = ?2 AND revoked_at IS NULL`)
      .bind(now, admins.results[0].id),
    db.prepare(`DELETE FROM admin_login_limits`),
  ]);
  return Response.json({ ok: true });
}

async function loginClientHash(request: Request): Promise<string> {
  const address = request.headers.get("CF-Connecting-IP")?.trim() || "local-or-unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  return toHex(new Uint8Array(digest));
}

async function checkLoginLimit(db: D1Database, clientHash: string, now: number): Promise<Response | null> {
  const limit = await db.prepare(
    `SELECT blocked_until FROM admin_login_limits WHERE client_hash = ?1`,
  ).bind(clientHash).first<{ blocked_until: number | null }>();
  if (!limit?.blocked_until || limit.blocked_until <= now) return null;
  const retryAfter = Math.max(1, Math.ceil((limit.blocked_until - now) / 1000));
  return Response.json({ error: "RATE_LIMITED", retryAfter }, {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}

async function recordLoginFailure(db: D1Database, clientHash: string, now: number): Promise<void> {
  const windowCutoff = now - LOGIN_WINDOW_MS;
  await db.prepare(
    `INSERT INTO admin_login_limits (client_hash, window_started_at, failure_count, blocked_until)
     VALUES (?1, ?2, 1, NULL)
     ON CONFLICT(client_hash) DO UPDATE SET
       failure_count = CASE
         WHEN admin_login_limits.window_started_at <= ?3 THEN 1
         ELSE admin_login_limits.failure_count + 1
       END,
       window_started_at = CASE
         WHEN admin_login_limits.window_started_at <= ?3 THEN ?2
         ELSE admin_login_limits.window_started_at
       END,
       blocked_until = CASE
         WHEN admin_login_limits.window_started_at <= ?3 THEN NULL
         WHEN admin_login_limits.failure_count + 1 >= ?4 THEN ?5
         ELSE admin_login_limits.blocked_until
       END`,
  ).bind(clientHash, now, windowCutoff, LOGIN_MAX_FAILURES, now + LOGIN_BLOCK_MS).run();
}

export async function loginAdmin(request: Request, db: D1Database, loginName: string, password: string): Promise<Response> {
  const normalizedLoginName = loginName.trim();
  if (normalizedLoginName.length < 3 || normalizedLoginName.length > 64 || password.length < 12 || password.length > 256) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const clientHash = await loginClientHash(request);
  const now = Date.now();
  const rateLimited = await checkLoginLimit(db, clientHash, now);
  if (rateLimited) return rateLimited;
  const admin = await db.prepare(
    `SELECT id, password_hash FROM admins WHERE login_name = ?1 AND active = 1`,
  ).bind(normalizedLoginName).first<{ id: string; password_hash: string }>();
  if (!admin || !(await verifyPassword(password, admin.password_hash))) {
    await recordLoginFailure(db, clientHash, now);
    return Response.json({ error: "INVALID_CREDENTIALS" }, { status: 401 });
  }

  await db.prepare(`DELETE FROM admin_login_limits WHERE client_hash = ?1`).bind(clientHash).run();

  const settings = await db.prepare(
    `SELECT session_duration_minutes, reauth_grace_minutes FROM app_settings WHERE id = 'default'`,
  ).first<{ session_duration_minutes: number; reauth_grace_minutes: number }>();
  const sessionNow = Date.now();
  const sessionId = crypto.randomUUID();
  const issuedAt = new Date(sessionNow).toISOString();
  const expiresAt = new Date(sessionNow + (settings?.session_duration_minutes ?? 480) * 60_000).toISOString();
  const graceExpiresAt = new Date(sessionNow + (settings?.reauth_grace_minutes ?? 30) * 60_000).toISOString();
  await db.prepare(
    `INSERT INTO admin_sessions
      (id, admin_id, issued_at, last_seen_at, expires_at, reauth_grace_expires_at)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5)`,
  ).bind(sessionId, admin.id, issuedAt, expiresAt, graceExpiresAt).run();
  return Response.json({ token: sessionId, expiresAt });
}

export async function requireAdmin(request: Request, db: D1Database): Promise<AdminSession | Response> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const session = await db.prepare(
    `SELECT id, admin_id, last_seen_at, expires_at FROM admin_sessions
     WHERE id = ?1 AND revoked_at IS NULL`,
  ).bind(token).first<AdminSession>();
  if (!session || Date.parse(session.expires_at) <= Date.now()) {
    return Response.json({ error: "SESSION_EXPIRED" }, { status: 401 });
  }
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 60_000).toISOString();
  await db.prepare(`UPDATE admin_sessions SET last_seen_at = ?1 WHERE id = ?2 AND last_seen_at < ?3`)
    .bind(now.toISOString(), token, staleBefore).run();
  return session;
}

export async function logoutAdmin(request: Request, db: D1Database): Promise<Response> {
  const session = await requireAdmin(request, db);
  if (session instanceof Response) return session;
  await db.prepare(`UPDATE admin_sessions SET revoked_at = ?1 WHERE id = ?2`).bind(new Date().toISOString(), session.id).run();
  return Response.json({ ok: true });
}
