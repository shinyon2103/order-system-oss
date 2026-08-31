const CACHE_PREFIX = "order-system:kitchen-completion";
export const PENDING_KITCHEN_COMPLETION_RENDER_ID = "pending-completion-sync";

function cacheKey(deviceId) {
  return `${CACHE_PREFIX}:${deviceId}`;
}

export function savePendingKitchenCompletion(storage, completion) {
  if (
    !storage || !completion?.eventId || !completion?.deviceId || !completion?.orderId ||
    !completion?.operationId || !completion?.ticketNumber || !completion?.completedAt
  ) return false;
  storage.setItem(cacheKey(completion.deviceId), JSON.stringify(completion));
  return true;
}

export function loadPendingKitchenCompletion(storage, deviceId) {
  if (!storage || !deviceId) return null;
  const key = cacheKey(deviceId);
  try {
    const completion = JSON.parse(storage.getItem(key) || "null");
    if (
      !completion || completion.deviceId !== deviceId || !completion.eventId || !completion.orderId ||
      !completion.operationId || !completion.ticketNumber || !completion.completedAt
    ) {
      storage.removeItem(key);
      return null;
    }
    return completion;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function clearPendingKitchenCompletion(storage, deviceId) {
  if (!storage || !deviceId) return;
  storage.removeItem(cacheKey(deviceId));
}
