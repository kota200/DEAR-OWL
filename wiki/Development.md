# Development

## Important files

- `index.html`: main application interface.
- `help.html`: in-app user manual.
- `js/app.js`: application orchestration.
- `js/data-loader.js`: catalog, GExA streaming, and upload loading.
- `js/offline-support.js`: Service Worker messaging and network lock.
- `js/webr-manager.js`: shared webR/DESeq2 preparation and runtime reuse.
- `js/deseq-runner.js`: two-group DESeq2 execution.
- `js/multi-group-runner.js`: multi-group DESeq2 execution.
- `js/fast-runner.js` and `js/multi-group-fast-runner.js`: screening engine.
- `js/result-table.js` and `js/multi-group-results.js`: result presentation.
- `config/datasets.json`: external GExA dataset catalog.
- `sw.js`: cache management and offline-only analysis enforcement.
- `scripts/serve-local.*`: operating-system local launch support.

## Local development server

Use the same launchers provided to end users:

```powershell
./start-local.cmd
```

```sh
sh start-local.sh
```

They serve the repository from `127.0.0.1` with the headers required by webR.
For automated browser work, the test helper is also available:

```sh
node tests/serve-cross-origin-isolated.mjs 8766
```

Never use `file://` as a functional test environment.

## Syntax and automated checks

Check every JavaScript module:

```powershell
Get-ChildItem -LiteralPath ./js -Filter *.js -Recurse | ForEach-Object {
  node --check $_.FullName
}
node --check ./sw.js
```

Run the automated suites:

```sh
node tests/unit-tests.mjs
node tests/offline-service-worker-tests.mjs
node tests/validate-staged-r.mjs
node tests/validate-runner-r.mjs
```

The runner validation uses a local R parser when an R installation is
available. `tests/multi-group-browser-smoke.html` provides an additional
browser smoke test for multi-group UI and result flows.

## Data-loading invariants

- GExA source files remain outside the repository under the configured
  `externalDataBaseUrl`.
- The app must not load all catalog datasets at startup.
- The selected compressed matrix may be cached, but the decompressed full
  matrix must not be retained in memory.
- Only selected sample count vectors should be materialized for analysis.
- Uploaded matrices must never be posted to a remote application server.

## Offline-analysis invariants

- Data loading and Analysis preparation remain separate progress stages.
- Run buttons remain disabled until required files are cached and webR/DESeq2
  is ready.
- Analysis reuses the prepared webR runtime rather than initializing a second
  channel.
- The Service Worker network lock must be enabled during a run.
- A missing cached asset must fail locally instead of falling through to the
  network.

## Release checklist

- Run JavaScript syntax checks and all applicable automated tests.
- Open `index.html` through a launcher/test server and confirm no console error.
- Confirm `help.html` and every README/Wiki link.
- Confirm local launch on Windows and at least one macOS/Linux-compatible
  environment.
- Confirm an uploaded matrix remains local and can be analyzed after
  preparation.
- Confirm the GExA catalog loads from the hosted deployment.
- Confirm one large GExA dataset shows independent Data loading and Analysis
  preparation progress.
- Confirm repeated analysis reuses the prepared runtime and cached selection.
- Confirm the analysis network lock with browser developer tools.
- Confirm two-group and multi-group results/downloads.
- Confirm `.htaccess`, `sw.js`, `webr/`, and `library/` are included in the
  release.
