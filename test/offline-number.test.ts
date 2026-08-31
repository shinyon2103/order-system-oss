import { describe, expect, it } from "vitest";
import { formatOfflineNumber } from "../src/client/offline-number";

describe("offline number allocation", () => {
  it("formats a configured offline number", () => {
    expect(formatOfflineNumber({ offlinePrefix: "OFF-", offlineStartNumber: 1000 }, 1000)).toBe("OFF-1000");
  });
});
