import { describe, expect, it } from "vitest";
import { PENDING_KITCHEN_COMPLETION_RENDER_ID, clearPendingKitchenCompletion, loadPendingKitchenCompletion, savePendingKitchenCompletion } from "../public/kitchen-offline-completion.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("offline kitchen completion", () => {
  it("uses a render identity distinct from the empty waiting state", () => {
    expect(PENDING_KITCHEN_COMPLETION_RENDER_ID).not.toBe("");
  });

  it("persists a stable operation for synchronization after reconnection", () => {
    const storage = memoryStorage();
    const completion = {
      eventId: "event-1",
      deviceId: "KITCHEN-01",
      orderId: "order-1",
      ticketNumber: "101",
      operationId: "operation-1",
      source: "button",
      completedAt: "2026-08-27T12:00:00.000Z",
    };
    expect(savePendingKitchenCompletion(storage, completion)).toBe(true);
    expect(loadPendingKitchenCompletion(storage, "KITCHEN-01")).toEqual(completion);
    expect(loadPendingKitchenCompletion(storage, "KITCHEN-02")).toBeNull();
  });

  it("keeps the completion until an acknowledged sync clears it", () => {
    const storage = memoryStorage();
    const completion = { eventId: "event-1", deviceId: "KITCHEN-01", orderId: "order-1", ticketNumber: "101", operationId: "operation-1", completedAt: "2026-08-27T12:00:00.000Z" };
    savePendingKitchenCompletion(storage, completion);
    expect(loadPendingKitchenCompletion(storage, "KITCHEN-01")).not.toBeNull();
    clearPendingKitchenCompletion(storage, "KITCHEN-01");
    expect(loadPendingKitchenCompletion(storage, "KITCHEN-01")).toBeNull();
  });

  it("rejects incomplete and malformed records", () => {
    const storage = memoryStorage();
    expect(savePendingKitchenCompletion(storage, { deviceId: "KITCHEN-01" })).toBe(false);
    storage.setItem("order-system:kitchen-completion:KITCHEN-01", "{");
    expect(loadPendingKitchenCompletion(storage, "KITCHEN-01")).toBeNull();
  });
});
