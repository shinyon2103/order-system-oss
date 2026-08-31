import { describe, expect, it } from "vitest";
import { parseRealtimeEventType, shouldRefreshProductCounts } from "../public/realtime-refresh.js";

describe("realtime refresh policy", () => {
  it.each(["order.created", "order.cancelled", "operation.undone"])(
    "refreshes product counts for %s",
    (eventType) => expect(shouldRefreshProductCounts(eventType)).toBe(true),
  );

  it.each(["order.cooking", "order.ready", "order.completed", "order.requeued"])(
    "skips product counts for %s",
    (eventType) => expect(shouldRefreshProductCounts(eventType)).toBe(false),
  );

  it("refreshes conservatively for initial, malformed, and future events", () => {
    expect(shouldRefreshProductCounts(null)).toBe(true);
    expect(shouldRefreshProductCounts("order.future-event")).toBe(true);
    expect(parseRealtimeEventType("not-json")).toBe(null);
  });

  it("parses event types without depending on payload details", () => {
    expect(parseRealtimeEventType(JSON.stringify({ type: "order.ready", order_id: "order-1" }))).toBe("order.ready");
  });
});
