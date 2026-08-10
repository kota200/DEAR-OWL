const SERVICE_WORKER_VERSION = "20260810-shared-prefilter-10";
const MESSAGE_TIMEOUT_MS = 120000;

let initializationPromise = null;

function unavailableMessage() {
  return [
    "Local analysis storage is not available in this browser.",
    "Open DEAR-OWL from HTTPS (or localhost) in a current Chrome or Edge browser."
  ].join(" ");
}

function waitForController() {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve(navigator.serviceWorker.controller);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      reject(new Error("The local analysis worker did not take control of this page."));
    }, 15000);

    function onControllerChange() {
      if (!navigator.serviceWorker.controller) {
        return;
      }
      clearTimeout(timeout);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      resolve(navigator.serviceWorker.controller);
    }

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  });
}

function sendMessage(type, detail = {}, timeoutMs = MESSAGE_TIMEOUT_MS) {
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    return Promise.reject(new Error("The local analysis worker is not controlling this page."));
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      reject(new Error(`Timed out while waiting for the local analysis worker: ${type}`));
    }, timeoutMs);

    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      const response = event.data || {};
      if (response.ok === false) {
        reject(new Error(response.error || `Local analysis worker failed: ${type}`));
        return;
      }
      resolve(response);
    };

    controller.postMessage({ type, ...detail }, [channel.port2]);
  });
}

async function requestPersistentStorage() {
  if (!navigator.storage) {
    return { persisted: false, usage: null, quota: null };
  }

  let persisted = typeof navigator.storage.persisted === "function"
    ? await navigator.storage.persisted()
    : false;

  if (!persisted && typeof navigator.storage.persist === "function") {
    try {
      persisted = await navigator.storage.persist();
    } catch {
      // Browsers may decline persistence without preventing Cache Storage use.
    }
  }

  let estimate = {};
  if (typeof navigator.storage.estimate === "function") {
    try {
      estimate = await navigator.storage.estimate();
    } catch {
      // Storage estimates are informative only.
    }
  }

  return {
    persisted,
    usage: Number.isFinite(estimate.usage) ? estimate.usage : null,
    quota: Number.isFinite(estimate.quota) ? estimate.quota : null
  };
}

export function initializeOfflineSupport() {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    if (!("serviceWorker" in navigator) || !("caches" in globalThis)) {
      throw new Error(unavailableMessage());
    }

    const serviceWorkerUrl = new URL(`../sw.js?v=${SERVICE_WORKER_VERSION}`, import.meta.url);
    const serviceWorkerScope = new URL("../", import.meta.url);
    await navigator.serviceWorker.register(serviceWorkerUrl, { scope: serviceWorkerScope.href });
    await navigator.serviceWorker.ready;
    await waitForController();
    const storage = await requestPersistentStorage();
    await sendMessage("PING");
    return storage;
  })();

  return initializationPromise;
}

export async function cacheOfflineUrls(urls) {
  const normalized = [...new Set(
    (urls || [])
      .filter(Boolean)
      .map((url) => new URL(url, document.baseURI).href)
  )];

  if (normalized.length === 0) {
    return { cached: 0 };
  }

  return await sendMessage("CACHE_URLS", { urls: normalized }, 10 * 60 * 1000);
}

export async function selectOfflineDataset(urls) {
  const normalized = [...new Set(
    (urls || [])
      .filter(Boolean)
      .map((url) => new URL(url, document.baseURI).href)
  )];
  return await sendMessage("SET_DATASET_URLS", { urls: normalized });
}

export async function waitForOfflineCacheIdle() {
  const response = await sendMessage("WAIT_FOR_CACHE", {}, 10 * 60 * 1000);
  const failures = response.failures || [];
  if (failures.length > 0) {
    throw new Error([
      "The browser could not retain every file required for local analysis.",
      ...failures.slice(0, 5)
    ].join("\n"));
  }
  return response;
}

export async function setAnalysisNetworkLock(enabled) {
  return await sendMessage("SET_OFFLINE_ONLY", { enabled: Boolean(enabled) });
}
