const COMPLETION_KEYS = new Set(["Enter", " ", "Spacebar"]);

export function createKitchenCompletionKeyGuard({ cooldownMs = 2_000, now = () => Date.now() } = {}) {
  const heldKeys = new Set();
  let blockedUntil = 0;

  return {
    shouldTrigger(event, eligible = true) {
      const key = event?.key;
      if (!COMPLETION_KEYS.has(key)) return false;
      if (event.repeat || heldKeys.has(key)) return false;
      heldKeys.add(key);
      if (!eligible || now() < blockedUntil) return false;
      blockedUntil = now() + cooldownMs;
      return true;
    },
    release(event) {
      if (COMPLETION_KEYS.has(event?.key)) heldKeys.delete(event.key);
    },
  };
}

export function isKeyboardShortcutTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, button, [contenteditable='true']"));
}
