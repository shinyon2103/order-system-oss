export function calculateServerClockOffset(authenticatedAt, clientNow = Date.now()) {
  const authenticatedMs = Date.parse(authenticatedAt || "");
  if (!Number.isFinite(authenticatedMs) || !Number.isFinite(clientNow)) return 0;
  return authenticatedMs - clientNow;
}

export function serverAdjustedIsoNow(offsetMs, clientNow = Date.now()) {
  const safeOffset = Number.isFinite(offsetMs) ? offsetMs : 0;
  const safeClientNow = Number.isFinite(clientNow) ? clientNow : Date.now();
  return new Date(safeClientNow + safeOffset).toISOString();
}
