import { timingSafeStringEqual } from "./secure-compare";

export type DeviceRole = "RECEPTION" | "KITCHEN" | "DELIVERY" | "DISPLAY" | "ADMIN";

export type AuthenticatedDevice = {
  id: string;
  role: DeviceRole;
  display_name: string;
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashDeviceKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return toHex(new Uint8Array(digest));
}

export function generateDeviceKey(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

export async function requireDevice(
  request: Request,
  db: D1Database,
  allowedRoles: DeviceRole[],
): Promise<AuthenticatedDevice | Response> {
  const deviceId = request.headers.get("X-Device-ID")?.trim();
  const deviceKey = request.headers.get("X-Device-Key")?.trim();
  if (!deviceId || !deviceKey) return Response.json({ error: "DEVICE_AUTH_REQUIRED" }, { status: 401 });

  const device = await db.prepare(
    `SELECT id, role, display_name, device_key_hash, active
     FROM devices WHERE id = ?1`,
  ).bind(deviceId).first<AuthenticatedDevice & { device_key_hash: string | null; active: number }>();
  const suppliedHash = await hashDeviceKey(deviceKey);
  const credentialsMatch = await timingSafeStringEqual(suppliedHash, device?.device_key_hash ?? "");
  if (!device || !device.active || !device.device_key_hash || !credentialsMatch) {
    return Response.json({ error: "INVALID_DEVICE_CREDENTIALS" }, { status: 401 });
  }
  if (!allowedRoles.includes(device.role)) {
    return Response.json({ error: "DEVICE_ROLE_FORBIDDEN" }, { status: 403 });
  }
  const now = new Date();
  const staleBefore = new Date(now.getTime() - 60_000).toISOString();
  await db.prepare(`UPDATE devices SET last_seen_at = ?1 WHERE id = ?2 AND (last_seen_at IS NULL OR last_seen_at < ?3)`).bind(now.toISOString(), device.id, staleBefore).run();
  return { id: device.id, role: device.role, display_name: device.display_name };
}
