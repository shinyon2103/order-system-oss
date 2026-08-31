import { describe, expect, it } from "vitest";
import { timingSafeStringEqual } from "../src/secure-compare";

describe("timing-safe string comparison", () => {
  it("accepts identical values", async () => {
    await expect(timingSafeStringEqual("same-secret", "same-secret")).resolves.toBe(true);
  });

  it("rejects different values even when their lengths differ", async () => {
    await expect(timingSafeStringEqual("secret", "different-secret-value")).resolves.toBe(false);
  });
});
