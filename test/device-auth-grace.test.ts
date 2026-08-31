import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-native JavaScript module is exercised directly by Vitest.
import { isOfflineDeviceAuthValid } from "../public/device-auth-grace.js";

describe("offline device authentication grace", () => {
  const now = Date.parse("2026-08-21T00:00:00.000Z");

  it("allows the matching role through the server-issued deadline", () => {
    expect(isOfflineDeviceAuthValid({ role: "RECEPTION", expectedRole: "RECEPTION", reauthGraceExpiresAt: "2026-08-21T00:30:00.000Z" }, now)).toBe(true);
    expect(isOfflineDeviceAuthValid({ role: "RECEPTION", expectedRole: "RECEPTION", reauthGraceExpiresAt: "2026-08-21T00:00:00.000Z" }, now)).toBe(true);
  });

  it("rejects expired, missing, or wrong-role authentication", () => {
    expect(isOfflineDeviceAuthValid({ role: "RECEPTION", expectedRole: "RECEPTION", reauthGraceExpiresAt: "2026-08-20T23:59:59.999Z" }, now)).toBe(false);
    expect(isOfflineDeviceAuthValid({ role: "RECEPTION", expectedRole: "RECEPTION", reauthGraceExpiresAt: "" }, now)).toBe(false);
    expect(isOfflineDeviceAuthValid({ role: "DELIVERY", expectedRole: "RECEPTION", reauthGraceExpiresAt: "2026-08-21T00:30:00.000Z" }, now)).toBe(false);
  });
});
