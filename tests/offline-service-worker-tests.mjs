import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function requestUrl(value) {
  return typeof value === "string" ? value : value.url;
}

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async match(request, options = {}) {
    const wanted = new URL(requestUrl(request));
    for (const [key, response] of this.entries) {
      const candidate = new URL(key);
      const matches = options.ignoreSearch
        ? candidate.origin === wanted.origin && candidate.pathname === wanted.pathname
        : candidate.href === wanted.href;
      if (matches) {
        return response.clone();
      }
    }
    return undefined;
  }

  async put(request, response) {
    this.entries.set(requestUrl(request), response.clone());
  }

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async delete(request) {
    return this.entries.delete(requestUrl(request));
  }

  async addAll() {
    throw new Error("The install handler is not used by this focused test.");
  }
}

const handlers = new Map();
const cacheMap = new Map();
const liveClients = [{ id: "client-1" }];
let networkCalls = 0;
let networkUnavailable = false;

const cacheStorage = {
  async open(name) {
    if (!cacheMap.has(name)) {
      cacheMap.set(name, new MemoryCache());
    }
    return cacheMap.get(name);
  },
  async keys() {
    return [...cacheMap.keys()];
  },
  async delete(name) {
    return cacheMap.delete(name);
  },
  async match(request, options) {
    for (const cache of cacheMap.values()) {
      const response = await cache.match(request, options);
      if (response) {
        return response;
      }
    }
    return undefined;
  }
};

const workerLocation = new URL("https://example.test/deseq2_local/sw.js");
const context = vm.createContext({
  URL,
  Request,
  Response,
  Promise,
  Set,
  Map,
  console,
  caches: cacheStorage,
  fetch: async (request) => {
    networkCalls += 1;
    if (networkUnavailable) {
      throw new Error("Network unavailable");
    }
    return new Response(`network:${requestUrl(request)}`, { status: 200 });
  }
});

context.self = {
  location: workerLocation,
  registration: { scope: "https://example.test/deseq2_local/" },
  clients: {
    async claim() {},
    async matchAll() {
      return liveClients;
    }
  },
  async skipWaiting() {},
  addEventListener(type, handler) {
    handlers.set(type, handler);
  }
};

const source = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
vm.runInContext(source, context, { filename: "sw.js" });

async function dispatchMessage(data) {
  const waits = [];
  let reply = null;
  handlers.get("message")({
    data,
    source: { id: "client-1" },
    ports: [{ postMessage(value) { reply = value; } }],
    waitUntil(promise) { waits.push(Promise.resolve(promise)); }
  });
  await Promise.all(waits);
  return reply;
}

async function dispatchFetch(url) {
  const waits = [];
  let responsePromise = null;
  handlers.get("fetch")({
    request: new Request(url),
    respondWith(value) { responsePromise = Promise.resolve(value); },
    waitUntil(promise) { waits.push(Promise.resolve(promise)); }
  });
  assert.ok(responsePromise, `service worker did not handle ${url}`);
  const response = await responsePromise;
  await Promise.all(waits);
  return response;
}

const cachedUrl = "https://example.test/deseq2_local/webr/R.wasm";
const uncachedUrl = "https://example.test/RNADB/Download/files/counts.csv.gz";

let response = await dispatchFetch(cachedUrl);
assert.equal(response.status, 200);
assert.equal(networkCalls, 1);

let message = await dispatchMessage({ type: "SET_OFFLINE_ONLY", enabled: true });
assert.equal(message.ok, true);
assert.equal(message.enabled, true);

response = await dispatchFetch(cachedUrl);
assert.equal(response.status, 200, "cached runtime remains available while locked");
assert.equal(networkCalls, 1, "cached runtime did not touch the network");

response = await dispatchFetch(uncachedUrl);
assert.equal(response.status, 504, "an uncached analysis request is rejected locally");
assert.equal(networkCalls, 1, "offline-only mode never falls through to the network");

message = await dispatchMessage({ type: "SET_OFFLINE_ONLY", enabled: false });
assert.equal(message.ok, true);
assert.equal(message.enabled, false);

response = await dispatchFetch(uncachedUrl);
assert.equal(response.status, 200);
assert.equal(networkCalls, 2, "network access resumes after analysis");

const catalogUrl = "https://example.test/deseq2_local/config/datasets.json";
const catalogNetworkStart = networkCalls;
response = await dispatchFetch(catalogUrl);
assert.equal(response.status, 200);
assert.equal(networkCalls, catalogNetworkStart + 1);

response = await dispatchFetch(catalogUrl);
assert.equal(response.status, 200);
assert.equal(
  networkCalls,
  catalogNetworkStart + 2,
  "the dataset catalog checks the network even when a cached copy exists"
);

networkUnavailable = true;
response = await dispatchFetch(catalogUrl);
assert.equal(response.status, 200, "the cached dataset catalog remains available offline");
assert.equal(
  await response.text(),
  `network:${catalogUrl}`,
  "the last successful catalog is used when the network fails"
);
networkUnavailable = false;

const lazyRuntimeUrls = [
  "https://example.test/deseq2_local/webr/vfs/usr/lib/R/library/parallel.js.metadata",
  "https://example.test/deseq2_local/webr/vfs/usr/lib/R/library/parallel.data.gz"
];
const lazyRuntimeNetworkStart = networkCalls;
message = await dispatchMessage({ type: "CACHE_URLS", urls: lazyRuntimeUrls });
assert.equal(message.ok, true);
assert.equal(message.cached, lazyRuntimeUrls.length);
assert.equal(networkCalls, lazyRuntimeNetworkStart + lazyRuntimeUrls.length);

message = await dispatchMessage({ type: "SET_OFFLINE_ONLY", enabled: true });
assert.equal(message.ok, true);
const lockedRuntimeNetworkStart = networkCalls;
for (const url of lazyRuntimeUrls) {
  response = await dispatchFetch(url);
  assert.equal(response.status, 200, "a cached lazy webR filesystem asset remains available while locked");
}
assert.equal(
  networkCalls,
  lockedRuntimeNetworkStart,
  "webR lazy filesystem images never require network access during analysis"
);
await dispatchMessage({ type: "SET_OFFLINE_ONLY", enabled: false });

console.log("offline service worker tests passed");
