const PRODUCT_COUNT_EVENT_TYPES = new Set([
  "order.created",
  "order.cancelled",
  "operation.undone",
]);

const KNOWN_EVENT_TYPES = new Set([
  ...PRODUCT_COUNT_EVENT_TYPES,
  "order.cooking",
  "order.ready",
  "order.completed",
  "order.requeued",
]);

export function parseRealtimeEventType(data) {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data);
    return typeof parsed?.type === "string" ? parsed.type : null;
  } catch {
    return null;
  }
}

export function shouldRefreshProductCounts(eventType) {
  return eventType === null
    || PRODUCT_COUNT_EVENT_TYPES.has(eventType)
    || !KNOWN_EVENT_TYPES.has(eventType);
}
