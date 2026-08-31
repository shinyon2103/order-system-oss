import { describe, expect, it } from "vitest";
import { clearKitchenAssignment, loadKitchenAssignment, saveKitchenAssignment } from "../public/kitchen-offline-cache.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

describe("kitchen offline assignment cache", () => {
  it("restores an assignment only for the same event and kitchen device", () => {
    const storage = memoryStorage();
    const assignment = { id: "order-1", ticket_number: "101", items: [{ item_name: "焼きそば", quantity: 2 }] };
    saveKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01", assignment, savedAt: 1_000 });

    expect(loadKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01", now: 2_000 })?.assignment).toEqual(assignment);
    expect(loadKitchenAssignment(storage, { eventId: "event-2", deviceId: "KITCHEN-01", now: 2_000 })).toBeNull();
    expect(loadKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-02", now: 2_000 })).toBeNull();
  });

  it("drops expired, malformed, and completed assignments", () => {
    const storage = memoryStorage();
    saveKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01", assignment: { id: "order-1" }, savedAt: 1_000 });
    expect(loadKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01", now: 36 * 60 * 60 * 1000 + 1_001 })).toBeNull();

    storage.setItem("order-system:kitchen-assignment:event-1:KITCHEN-01", "{");
    expect(loadKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01" })).toBeNull();

    saveKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01", assignment: { id: "order-1" } });
    clearKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01" });
    expect(loadKitchenAssignment(storage, { eventId: "event-1", deviceId: "KITCHEN-01" })).toBeNull();
  });
});
