import { describe, expect, it } from "vitest";
import { isNetworkUnavailable, prepareOfflineOrder, sortPendingOrders } from "../public/offline-sync.js";

describe("offline order synchronization", () => {
  it("sends pending orders in accepted time order with a stable request ID fallback", () => {
    const pending = [
      { requestId: "c", acceptedAt: "2026-08-21T01:00:02.000Z" },
      { requestId: "b", acceptedAt: "2026-08-21T01:00:01.000Z" },
      { requestId: "a", acceptedAt: "2026-08-21T01:00:01.000Z" },
    ];

    expect(sortPendingOrders(pending).map(({ requestId }) => requestId)).toEqual(["a", "b", "c"]);
    expect(pending.map(({ requestId }) => requestId)).toEqual(["c", "b", "a"]);
  });

  it("only treats an unreachable server as an offline-queue fallback", () => {
    expect(isNetworkUnavailable({ code: "NETWORK_UNAVAILABLE" })).toBe(true);
    expect(isNetworkUnavailable({ code: "INTERNAL_ERROR", status: 503 })).toBe(true);
    expect(isNetworkUnavailable({ code: "INVALID_MENU_SELECTION" })).toBe(false);
    expect(isNetworkUnavailable({ code: "INVALID_MENU_SELECTION", status: 400 })).toBe(false);
    expect(isNetworkUnavailable(new Error("failed"))).toBe(false);
  });

  it("keeps the displayed offline number when an online request falls back to the queue", () => {
    const onlineAttempt = { mode: "ONLINE", requestId: "request-1", items: [] };

    expect(prepareOfflineOrder(onlineAttempt, "OFF-", 1000)).toEqual({
      mode: "OFFLINE",
      requestId: "request-1",
      ticketNumber: "OFF-1000",
      items: [],
    });
    expect(onlineAttempt.mode).toBe("ONLINE");
  });
});
