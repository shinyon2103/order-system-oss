const CACHE_PREFIX = "order-system:kitchen-assignment";
const MAX_CACHE_AGE_MS = 36 * 60 * 60 * 1000;

function cacheKey(eventId, deviceId) {
  return `${CACHE_PREFIX}:${eventId}:${deviceId}`;
}

export function saveKitchenAssignment(storage, { eventId, deviceId, assignment, away = false, savedAt = Date.now() }) {
  if (!storage || !eventId || !deviceId || !assignment?.id) return;
  storage.setItem(cacheKey(eventId, deviceId), JSON.stringify({ eventId, deviceId, assignment, away: Boolean(away), savedAt }));
}

export function loadKitchenAssignment(storage, { eventId, deviceId, now = Date.now() }) {
  if (!storage || !eventId || !deviceId) return null;
  const key = cacheKey(eventId, deviceId);
  try {
    const cached = JSON.parse(storage.getItem(key) || "null");
    if (
      !cached || cached.eventId !== eventId || cached.deviceId !== deviceId ||
      !cached.assignment?.id || !Number.isFinite(cached.savedAt) ||
      now - cached.savedAt > MAX_CACHE_AGE_MS
    ) {
      storage.removeItem(key);
      return null;
    }
    return cached;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function clearKitchenAssignment(storage, { eventId, deviceId }) {
  if (!storage || !eventId || !deviceId) return;
  storage.removeItem(cacheKey(eventId, deviceId));
}
