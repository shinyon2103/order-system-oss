import { describe, expect, it } from "vitest";
import { calculateServerClockOffset, serverAdjustedIsoNow } from "../public/server-clock.js";

describe("server-adjusted browser clock", () => {
  it("calculates and applies the offset from device authentication", () => {
    const clientNow = Date.parse("2026-08-21T02:55:00.000Z");
    const offset = calculateServerClockOffset("2026-08-21T03:00:00.000Z", clientNow);

    expect(offset).toBe(5 * 60_000);
    expect(serverAdjustedIsoNow(offset, clientNow + 10_000)).toBe("2026-08-21T03:00:10.000Z");
  });

  it("falls back safely when the stored values are invalid", () => {
    expect(calculateServerClockOffset("invalid", 1000)).toBe(0);
    expect(serverAdjustedIsoNow(Number.NaN, 1000)).toBe("1970-01-01T00:00:01.000Z");
  });
});
