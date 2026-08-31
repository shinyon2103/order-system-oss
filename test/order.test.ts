import { describe, expect, it } from "vitest";
import { canTransition } from "../src/domain/order";

describe("order transitions", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransition("WAITING", "COOKING")).toBe(true);
    expect(canTransition("WAITING", "CANCELLED")).toBe(true);
    expect(canTransition("COOKING", "READY")).toBe(true);
    expect(canTransition("READY", "COOKING")).toBe(true);
    expect(canTransition("READY", "COMPLETED")).toBe(true);
    expect(canTransition("READY", "CANCELLED")).toBe(true);
    expect(canTransition("COMPLETED", "CANCELLED")).toBe(true);
  });

  it("rejects invalid lifecycle changes", () => {
    expect(canTransition("WAITING", "READY")).toBe(false);
    expect(canTransition("COOKING", "CANCELLED")).toBe(false);
    expect(canTransition("COMPLETED", "WAITING")).toBe(false);
  });
});
