const ZOOM_KEYS = new Set(["+", "-", "=", "0"]);

export function shouldBlockZoomKey(event) {
  return Boolean((event.ctrlKey || event.metaKey) && ZOOM_KEYS.has(event.key));
}

export function installPageZoomGuard(documentTarget = document, windowTarget = window) {
  const prevent = (event) => event.preventDefault();

  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    documentTarget.addEventListener(type, prevent, { passive: false });
  }
  documentTarget.addEventListener("touchmove", (event) => {
    if (event.touches?.length > 1) event.preventDefault();
  }, { passive: false });
  documentTarget.addEventListener("wheel", (event) => {
    if (event.ctrlKey) event.preventDefault();
  }, { passive: false });
  windowTarget.addEventListener("keydown", (event) => {
    if (shouldBlockZoomKey(event)) event.preventDefault();
  });
}
