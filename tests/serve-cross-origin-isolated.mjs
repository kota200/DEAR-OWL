import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const port = Number(process.argv[2] || 8766);
const root = resolve(process.argv[3] || process.cwd());
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
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

server.listen(port, "127.0.0.1", () => {
  console.log(`Cross-origin-isolated static server: http://127.0.0.1:${port}/deseq2/`);
});
