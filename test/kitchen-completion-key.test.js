import { describe, expect, it } from "vitest";
import { createKitchenCompletionKeyGuard } from "../public/kitchen-completion-key.js";

describe("kitchen completion keyboard guard", () => {
  it("accepts Enter and Space but ignores held-key repeats", () => {
    let time = 1_000;
    const guard = createKitchenCompletionKeyGuard({ now: () => time });
    expect(guard.shouldTrigger({ key: "Enter", repeat: false })).toBe(true);
    expect(guard.shouldTrigger({ key: "Enter", repeat: true })).toBe(false);
    time += 3_000;
    expect(guard.shouldTrigger({ key: "Enter", repeat: false })).toBe(false);
    guard.release({ key: "Enter" });
    expect(guard.shouldTrigger({ key: "Enter", repeat: false })).toBe(true);
  });

  it("blocks rapid presses across both assigned keys", () => {
    let time = 5_000;
    const guard = createKitchenCompletionKeyGuard({ cooldownMs: 2_000, now: () => time });
    expect(guard.shouldTrigger({ key: " ", repeat: false })).toBe(true);
    guard.release({ key: " " });
    time += 100;
    expect(guard.shouldTrigger({ key: "Enter", repeat: false })).toBe(false);
    guard.release({ key: "Enter" });
    time += 2_000;
    expect(guard.shouldTrigger({ key: "Enter", repeat: false })).toBe(true);
  });

  it("does not arm a completion while no order is eligible", () => {
    const guard = createKitchenCompletionKeyGuard();
    expect(guard.shouldTrigger({ key: " ", repeat: false }, false)).toBe(false);
  });
});
