#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
const noBrowser = args.includes("--no-browser");
const portArgument = args.find((value) => /^\d+$/.test(value));
const port = Number(portArgument || 8766);

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Port must be an integer between 1024 and 65535.");
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".data", "application/octet-stream"],
  [".gz", "application/gzip"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".metadata", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".so", "application/octet-stream"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
  [".wasm", "application/wasm"]
]);

function isolatedHeaders(contentType) {
  return {
    "Cache-Control": "no-cache",
    "Content-Type": contentType,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin"
  };
}

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const commandArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => {
      console.warn(`Open this URL in a browser: ${url}`);
    });
    child.unref();
  } catch {
    console.warn(`Open this URL in a browser: ${url}`);
  }
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, isolatedHeaders("text/plain; charset=utf-8"));
      response.end("Method not allowed");
      return;
    }
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const decodedPath = decodeURIComponent(url.pathname);
    let filePath = resolve(root, `.${decodedPath}`);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      response.writeHead(403, isolatedHeaders("text/plain; charset=utf-8"));
      response.end("Forbidden");
      return;
    }

    let fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, "index.html");
      fileStat = await stat(filePath);
    }
    if (!fileStat.isFile()) {
      throw new Error("Not a file");
    }

    const contentType = mimeTypes.get(extname(filePath).toLowerCase())
      || "application/octet-stream";
    response.writeHead(200, {
      ...isolatedHeaders(contentType),
      "Content-Length": fileStat.size
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, isolatedHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
  }
});

server.on("error", (error) => {
  console.error(`DEAR-OWL could not listen on port ${port}: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  const localUrl = `http://127.0.0.1:${port}/?mode=upload`;
  console.log("\nDEAR-OWL is running only on this computer.");
  console.log(localUrl);
  console.log("Keep this terminal open. Press Ctrl+C to stop.");
  console.log("Uploaded count matrices are not sent to a remote server.\n");
  if (!noBrowser) {
    openBrowser(localUrl);
  }
});
