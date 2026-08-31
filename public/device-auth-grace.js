export function isOfflineDeviceAuthValid({ role, expectedRole, reauthGraceExpiresAt }, now = Date.now()) {
  const expiresAt = Date.parse(reauthGraceExpiresAt || "");
  return Boolean(role && role === expectedRole && Number.isFinite(expiresAt) && now <= expiresAt);
}
