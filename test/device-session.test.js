import { describe, expect, it } from "vitest";
import { clearDeviceCredentials, loadDeviceCredentials, saveDeviceCredentials } from "../public/device-session.js";

function store(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe("per-window device credentials", () => {
  it("moves a legacy shared credential into the current tab only", () => {
    const session = store();
    const legacy = store({ "order-system:device-id": "RECEPTION-01", "order-system:device-key": "key", "order-system:device-role": "RECEPTION" });

    expect(loadDeviceCredentials(session, legacy)).toMatchObject({ deviceId: "RECEPTION-01", deviceRole: "RECEPTION" });
    expect(legacy.getItem("order-system:device-key")).toBeNull();
  });

  it("keeps each tab credential independent and clears only its own session", () => {
    const receptionTab = store();
    const kitchenTab = store();
    saveDeviceCredentials(receptionTab, { deviceId: "RECEPTION-01", deviceKey: "reception-key", deviceRole: "RECEPTION", deviceReauthGraceExpiresAt: "", serverClockOffsetMs: 0 });
    saveDeviceCredentials(kitchenTab, { deviceId: "KITCHEN-01", deviceKey: "kitchen-key", deviceRole: "KITCHEN", deviceReauthGraceExpiresAt: "", serverClockOffsetMs: 0 });

    clearDeviceCredentials(receptionTab);
    expect(loadDeviceCredentials(receptionTab, store())).toMatchObject({ deviceId: "" });
    expect(loadDeviceCredentials(kitchenTab, store())).toMatchObject({ deviceId: "KITCHEN-01", deviceRole: "KITCHEN" });
  });
});
