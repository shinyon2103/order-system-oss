import { describe, expect, it } from "vitest";
import { kitchenAlertButtonState, shouldPlayKitchenAlert } from "../public/kitchen-alert.js";

describe("kitchen assignment alerts", () => {
  it("plays only for a different assigned order after audio is ready", () => {
    expect(shouldPlayKitchenAlert({ previousOrderId: null, nextOrderId: "order-1", preferred: true, ready: true })).toBe(true);
    expect(shouldPlayKitchenAlert({ previousOrderId: "order-1", nextOrderId: "order-2", preferred: true, ready: true })).toBe(true);
    expect(shouldPlayKitchenAlert({ previousOrderId: "order-1", nextOrderId: "order-1", preferred: true, ready: true })).toBe(false);
    expect(shouldPlayKitchenAlert({ previousOrderId: null, nextOrderId: null, preferred: true, ready: true })).toBe(false);
    expect(shouldPlayKitchenAlert({ previousOrderId: null, nextOrderId: "order-1", preferred: true, ready: false })).toBe(false);
    expect(shouldPlayKitchenAlert({ previousOrderId: null, nextOrderId: "order-1", preferred: false, ready: true })).toBe(false);
  });

  it("distinguishes unsupported, remembered, enabled, and disabled states", () => {
    expect(kitchenAlertButtonState({ supported: false, preferred: true, ready: false })).toEqual({ label: "通知音は利用できません", pressed: false, tone: "unavailable" });
    expect(kitchenAlertButtonState({ supported: true, preferred: true, ready: false })).toEqual({ label: "通知音を準備", pressed: false, tone: "attention" });
    expect(kitchenAlertButtonState({ supported: true, preferred: true, ready: true })).toEqual({ label: "通知音：オン", pressed: true, tone: "ready" });
    expect(kitchenAlertButtonState({ supported: true, preferred: false, ready: false })).toEqual({ label: "通知音：オフ", pressed: false, tone: "off" });
  });
});
