const SERVICE_WORKER_VERSION = "20260810-shared-prefilter-10";
const APP_VERSION = "20260810-shared-prefilter";
const RELOAD_KEY = `dear-owl-worker-reload-${SERVICE_WORKER_VERSION}`;

function waitForWorkerActivation(worker) {
  if (!worker || worker.state === "activated") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener("statechange", onStateChange);
      reject(new Error("Timed out while activating the updated local analysis worker."));
    }, 30000);

    function onStateChange() {
      if (worker.state === "activated") {
        clearTimeout(timeout);
        worker.removeEventListener("statechange", onStateChange);
        resolve();
      } else if (worker.state === "redundant") {
        clearTimeout(timeout);
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("The updated local analysis worker became redundant."));
      }
    }

    worker.addEventListener("statechange", onStateChange);
  });
}

async function prepareCurrentWorker() {
  if (!("serviceWorker" in navigator) || !["http:", "https:"].includes(location.protocol)) {
    return true;
  }

  const workerUrl = new URL(`../sw.js?v=${SERVICE_WORKER_VERSION}`, import.meta.url);
  const scopeUrl = new URL("../", import.meta.url);
  const registration = await navigator.serviceWorker.register(workerUrl, { scope: scopeUrl.href });
  const targetWorker = [
    registration.installing,
    registration.waiting,
    registration.active
  ].find((worker) => worker?.scriptURL === workerUrl.href);

  await waitForWorkerActivation(targetWorker);

  if (navigator.serviceWorker.controller?.scriptURL === workerUrl.href) {
    sessionStorage.removeItem(RELOAD_KEY);
    return true;
  }

  if (sessionStorage.getItem(RELOAD_KEY) !== "1") {
    sessionStorage.setItem(RELOAD_KEY, "1");
    location.reload();
    return false;
  }

  // Never leave the page blank if a browser declines to replace its controller.
  sessionStorage.removeItem(RELOAD_KEY);
  return true;
}

let startApplication = true;
try {
  startApplication = await prepareCurrentWorker();
} catch (error) {
  console.warn("DEAR-OWL could not pre-activate its updated local analysis worker.", error);
}

if (startApplication) {
  await import(`./app.js?v=${APP_VERSION}`);
}
