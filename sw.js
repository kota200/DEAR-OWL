const CACHE_VERSION = "20260810-shared-prefilter-10";
const CACHE_PREFIX = "dear-owl-local-";
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;
const DATA_CACHE = `${CACHE_PREFIX}data-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./help.html",
  "./css/deseq-app.css",
  "./config/datasets.json",
  "./js/app.js",
  "./js/app-bootstrap-20260810-shared-webr-manager.js",
  "./js/config.js",
  "./js/data-loader.js",
  "./js/dataset-progress.js",
  "./js/deseq-runner.js",
  "./js/deseq-staged-runner.js",
  "./js/dom-ready.js",
  "./js/download.js",
  "./js/fast-ztest.js",
  "./js/intersections.js",
  "./js/local-launch-guard.js",
  "./js/multi-group-controller.js",
  "./js/multi-group-fast-runner.js",
  "./js/multi-group-results.js",
  "./js/multi-group-runner.js",
  "./js/multi-group-staged-runner.js",
  "./js/offline-support.js",
  "./js/plots.js",
  "./js/result-table.js",
  "./js/sample-selector.js",
  "./js/utils.js",
  "./js/webr-manager.js",
  "./js/workers/matrix-parser-worker.js"
].map((path) => new URL(path, self.location.href).href);

const pendingWrites = new Set();
const cacheFailures = [];
const lockedClients = new Set();

async function networkIsLocked() {
  if (lockedClients.size === 0) {
    return false;
  }
  const liveClients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window"
  });
  const liveIds = new Set(liveClients.map((client) => client.id));
  for (const clientId of lockedClients) {
    if (!liveIds.has(clientId)) {
      lockedClients.delete(clientId);
    }
  }
  return lockedClients.size > 0;
}

function reply(event, payload) {
  const port = event.ports?.[0];
  if (port) {
    port.postMessage(payload);
  }
}

function cacheNameForUrl(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname.startsWith(scopePath) ? STATIC_CACHE : DATA_CACHE;
}

async function matchCached(request) {
  const names = [cacheNameForUrl(new URL(request.url)), STATIC_CACHE, DATA_CACHE];
  for (const name of [...new Set(names)]) {
    const cache = await caches.open(name);
    const exact = await cache.match(request);
    if (exact) {
      return exact;
    }
  }
  return null;
}

function trackCacheWrite(promise, url) {
  const tracked = promise
    .catch((error) => {
      cacheFailures.push(`${url}: ${error?.message || String(error)}`);
    })
    .finally(() => {
      pendingWrites.delete(tracked);
    });
  pendingWrites.add(tracked);
  return tracked;
}

function cacheable(response) {
  return response && response.ok && response.type !== "error";
}

function cacheNetworkResponse(request, response) {
  if (!cacheable(response)) {
    return null;
  }
  const copy = response.clone();
  const write = (async () => {
    const cache = await caches.open(cacheNameForUrl(new URL(request.url)));
    await cache.put(request, copy);
  })();
  return trackCacheWrite(write, request.url);
}

async function cacheFirst(request) {
  const cached = await matchCached(request);
  if (cached) {
    return cached;
  }

  if (await networkIsLocked()) {
    return new Response("Local analysis blocked an uncached network request.", {
      status: 504,
      statusText: "Offline cache miss",
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  const response = await fetch(request);
  cacheNetworkResponse(request, response);
  return response;
}

async function navigationResponse(request) {
  if (await networkIsLocked()) {
    return await cacheFirst(request);
  }

  try {
    const response = await fetch(request);
    cacheNetworkResponse(request, response);
    return response;
  } catch (error) {
    return await matchCached(request) ||
      await caches.match(new URL("./index.html", self.location.href).href) ||
      Promise.reject(error);
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && ![STATIC_CACHE, DATA_CACHE].includes(name))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") {
    const responsePromise = (async () => {
      if (await networkIsLocked()) {
        return new Response("Network writes are disabled during local analysis.", {
          status: 504,
          statusText: "Offline analysis"
        });
      }
      return await fetch(request);
    })();
    event.respondWith(responsePromise);
    event.waitUntil(responsePromise.catch(() => {}));
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }

  if (url.origin !== self.location.origin) {
    if (lockedClients.size > 0) {
      event.respondWith(new Response("External network access is disabled during local analysis.", {
        status: 504,
        statusText: "Offline analysis"
      }));
    }
    return;
  }

  const responsePromise =
    request.mode === "navigate"
      ? navigationResponse(request)
      : cacheFirst(request);
  event.respondWith(responsePromise);
  event.waitUntil((async () => {
    try {
      await responsePromise;
      await Promise.all([...pendingWrites]);
    } catch {
      // The response path reports network failures to the requesting client.
    }
  })());
});

async function cacheUrls(urls) {
  let cached = 0;
  for (const value of urls) {
    const url = new URL(value, self.location.href);
    if (url.origin !== self.location.origin) {
      throw new Error(`Refusing to cache a cross-origin analysis file: ${url.href}`);
    }
    const request = new Request(url.href, { credentials: "same-origin" });
    const existing = await matchCached(request);
    if (existing) {
      cached += 1;
      continue;
    }
    const response = await fetch(request);
    if (!response.ok) {
      throw new Error(`Failed to cache ${url.href}: HTTP ${response.status}`);
    }
    const cache = await caches.open(cacheNameForUrl(url));
    await cache.put(request, response);
    cached += 1;
  }
  return cached;
}

async function keepOnlyDatasetUrls(urls) {
  const keep = new Set(urls.map((value) => new URL(value, self.location.href).href));
  const cache = await caches.open(DATA_CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => !keep.has(request.url))
      .map((request) => cache.delete(request))
  );
}

self.addEventListener("message", (event) => {
  const sourceId = event.source?.id || "unknown";
  const type = event.data?.type;

  event.waitUntil((async () => {
    try {
      if (type === "PING") {
        await networkIsLocked();
        reply(event, { ok: true, cacheVersion: CACHE_VERSION });
        return;
      }

      if (type === "CACHE_URLS") {
        if (await networkIsLocked()) {
          throw new Error("Another DEAR-OWL analysis is using the offline-only network lock.");
        }
        const cached = await cacheUrls(event.data.urls || []);
        reply(event, { ok: true, cached });
        return;
      }

      if (type === "SET_DATASET_URLS") {
        await keepOnlyDatasetUrls(event.data.urls || []);
        reply(event, { ok: true });
        return;
      }

      if (type === "WAIT_FOR_CACHE") {
        await Promise.all([...pendingWrites]);
        const failures = cacheFailures.splice(0, cacheFailures.length);
        reply(event, { ok: true, failures });
        return;
      }

      if (type === "SET_OFFLINE_ONLY") {
        if (event.data.enabled) {
          lockedClients.add(sourceId);
        } else {
          lockedClients.delete(sourceId);
        }
        reply(event, { ok: true, enabled: lockedClients.size > 0 });
        return;
      }

      reply(event, { ok: false, error: `Unknown local analysis worker message: ${type}` });
    } catch (error) {
      reply(event, { ok: false, error: error?.message || String(error) });
    }
  })());
});
