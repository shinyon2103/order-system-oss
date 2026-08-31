import { describe, expect, it } from "vitest";
import { normalizeAcceptedAt } from "../src/domain/order-time";

const NOW = Date.parse("2026-08-21T03:00:00.000Z");

describe("order acceptance time", () => {
  it("uses Worker time for online orders", () => {
    expect(normalizeAcceptedAt("ONLINE", "2020-01-01T00:00:00.000Z", NOW)).toBe("2026-08-21T03:00:00.000Z");
  });

  it("preserves a reasonable offline acceptance time", () => {
    expect(normalizeAcceptedAt("OFFLINE", "2026-08-21T02:30:00.000Z", NOW)).toBe("2026-08-21T02:30:00.000Z");
  });

  it("clamps stale or future offline times to Worker time", () => {
    expect(normalizeAcceptedAt("OFFLINE", "2026-08-14T02:59:59.999Z", NOW)).toBe("2026-08-21T03:00:00.000Z");
    expect(normalizeAcceptedAt("OFFLINE", "2026-08-21T03:05:00.001Z", NOW)).toBe("2026-08-21T03:00:00.000Z");
  });
});
