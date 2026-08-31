import { describe, expect, it } from "vitest";
import { createClientId } from "../public/client-id.js";

describe("client ID generation", () => {
  it("uses randomUUID when the browser provides it", () => {
    const expected = "11111111-2222-4333-8444-555555555555";
    expect(createClientId({ randomUUID: () => expected })).toBe(expected);
  });

  it("creates an RFC 4122 version 4 UUID from getRandomValues", () => {
    const cryptoApi = {
      getRandomValues(bytes) {
        bytes.forEach((_, index) => { bytes[index] = index; });
        return bytes;
      },
    };

    const id = createClientId(cryptoApi);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });
});
