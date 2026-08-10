export function runAfterDomReady(documentObject, callback) {
  if (documentObject.readyState === "loading") {
    documentObject.addEventListener("DOMContentLoaded", callback, { once: true });
    return "waiting";
  }

  callback();
  return "started";
}
