const MAX_OFFLINE_ACCEPTED_AT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OFFLINE_ACCEPTED_AT_FUTURE_MS = 5 * 60 * 1000;

export function normalizeAcceptedAt(
  mode: "ONLINE" | "OFFLINE",
  submittedAcceptedAt: string,
  nowMs = Date.now(),
): string {
  const serverNow = new Date(nowMs).toISOString();
  if (mode === "ONLINE") return serverNow;

  const submittedMs = Date.parse(submittedAcceptedAt);
  if (
    !Number.isFinite(submittedMs) ||
    submittedMs < nowMs - MAX_OFFLINE_ACCEPTED_AT_AGE_MS ||
    submittedMs > nowMs + MAX_OFFLINE_ACCEPTED_AT_FUTURE_MS
  ) {
    return serverNow;
  }

  return new Date(submittedMs).toISOString();
}
