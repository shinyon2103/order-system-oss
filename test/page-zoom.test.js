import { describe, expect, it, vi } from "vitest";
import { installPageZoomGuard, shouldBlockZoomKey } from "../public/page-zoom.js";

describe("page zoom guard", () => {
  it("blocks browser zoom keyboard shortcuts", () => {
    expect(shouldBlockZoomKey({ ctrlKey: true, metaKey: false, key: "+" })).toBe(true);
    expect(shouldBlockZoomKey({ ctrlKey: false, metaKey: true, key: "0" })).toBe(true);
    expect(shouldBlockZoomKey({ ctrlKey: false, metaKey: false, key: "+" })).toBe(false);
  });

  it("prevents pinch, gesture, wheel, and keyboard zoom events", () => {
    const documentListeners = new Map();
    const windowListeners = new Map();
    const documentTarget = { addEventListener: vi.fn((type, listener) => documentListeners.set(type, listener)) };
    const windowTarget = { addEventListener: vi.fn((type, listener) => windowListeners.set(type, listener)) };
    installPageZoomGuard(documentTarget, windowTarget);

    for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
      const event = { preventDefault: vi.fn() };
      documentListeners.get(type)(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    const pinch = { touches: [{}, {}], preventDefault: vi.fn() };
    documentListeners.get("touchmove")(pinch);
    expect(pinch.preventDefault).toHaveBeenCalledOnce();

    const wheel = { ctrlKey: true, preventDefault: vi.fn() };
    documentListeners.get("wheel")(wheel);
    expect(wheel.preventDefault).toHaveBeenCalledOnce();

    const key = { ctrlKey: true, metaKey: false, key: "=", preventDefault: vi.fn() };
    windowListeners.get("keydown")(key);
    expect(key.preventDefault).toHaveBeenCalledOnce();
  });
});
