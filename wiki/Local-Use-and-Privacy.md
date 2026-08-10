# Local Use and Privacy

DEAR-OWL can analyze a count matrix on the user's computer without uploading
that matrix to an application server. The R/webR computation runs in the
browser, and analysis is locked to locally available files after preparation.

## Start the local application

Download or clone the complete repository. The `webr/` and `library/`
directories are required.

### Windows

Double-click `start-local.cmd`. The included PowerShell launcher needs no
Python or Node.js installation.

To use another port from a terminal:

```powershell
./start-local.cmd -Port 8767
```

### macOS and Linux

Open a terminal in the application directory and run:

```sh
sh start-local.sh
```

Python 3 is used when available; otherwise the launcher uses Node.js. To use a
different port, pass it as the first argument:

```sh
sh start-local.sh 8767
```

On macOS, `start-local.command` can also be used from Finder after making it
executable once:

```sh
chmod +x start-local.command
```

The launcher opens `http://127.0.0.1:8766/?mode=upload`. Keep the launcher
window open until the analysis is finished.

## Why a local launcher is required

Opening `index.html` with `file://` does not provide the security context needed
by JavaScript modules, module workers, WebAssembly, and Service Workers. The
launcher runs a small HTTP server bound only to `127.0.0.1`, which is the same
computer. It is not a remote upload service and is not exposed to the local
network.

## What stays local

- The selected count file is read by the browser File API.
- The count matrix is parsed in a browser worker.
- The matrix and selected samples remain in browser memory.
- webR and DESeq2 are loaded from the downloaded application directory through
  the loopback server.
- DEG analysis requests are restricted to cached/local files after analysis
  preparation succeeds.

The local launcher opens Upload count matrix mode by default. Published GExA
matrices are not bundled with the repository; they stay in the hosted server's
separate `/RNADB/Download/files/` directory. Use the hosted DEAR-OWL instance
when a GExA dataset is required.

## Uploaded matrix format

Use raw, non-negative integer counts with genes as rows:

```text
gene_id,control_1,control_2,treatment_1,treatment_2
gene0001,10,12,40,38
gene0002,20,18,25,29
```

CSV, TSV, TXT, and gzip-compressed files are accepted. Gene IDs and sample
names must be unique. TPM, FPKM, and other normalized expression values are not
valid DESeq2 inputs.

## Browser storage

The Service Worker caches the bundled runtime files needed by analysis. The app
requests persistent storage when the browser supports it. If persistence is
denied, analysis still works, but the browser may evict cached files later.

Clearing the site's cookies/data or storage removes these cached files. They
will be prepared again the next time DEAR-OWL is used.

## Troubleshooting

- **The page says a local launcher is required:** close the `file://` tab and
  run the operating-system launcher.
- **Port 8766 is already in use:** stop the other local session or select
  another port as shown above.
- **Analysis remains disabled:** wait for Analysis preparation to reach 100%.
  A cache or browser-storage error is shown if a required file cannot be stored.
- **The browser runs out of memory:** close other tabs, select fewer samples,
  and disable optional PCA or heatmap-style plots.
- **GExA loading returns 404 locally:** this is expected when the separate
  RNADB directory is not hosted at the local origin; use the hosted app.
