# Deployment

DEAR-OWL is a static browser application with a bundled webR runtime and DESeq2
library image. The same repository can be deployed to a web server or started
on one computer with the included loopback launchers.

## Hosted deployment

Deploy the complete repository to the target static web directory:

```text
public_html/
  deseq2/
    .htaccess
    index.html
    help.html
    sw.js
    config/
    css/
    js/
    library/
    scripts/
    tests/
    webr/
```

Do not place GExA count, TPM, gene-length, or annotation data in this directory.
They remain in the server's separate RNADB download directory.

## External GExA data

`js/config.js` defines:

```javascript
externalDataBaseUrl: "/RNADB/Download/files/"
```

The leading slash makes this path relative to the hosted origin, not to the
`deseq2/` directory. `config/datasets.json` lists the expected external file
names. If the server data location changes, update `externalDataBaseUrl`; do not
add a repository `data/` directory.

## Required application files

The repository uses local runtime assets:

```javascript
baseUrl: "./webr/",
libraryDataUrl: "./library/library.data.gz",
libraryMetadataUrl: "./library/library.js.metadata",
workerLibraryDataUrl: "./library/library-uncompressed.data"
```

Keep `webr/`, all referenced `library/` data and metadata files, `sw.js`, and
the module files under `js/`. Missing runtime assets leave the run buttons
disabled rather than allowing an analysis to fall back to the network.

## HTTP headers

On Apache-compatible hosting, upload the hidden `.htaccess` file. It configures
the cross-origin isolation/resource headers used by the webR runtime:

- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Embedder-Policy`
- `Cross-Origin-Resource-Policy`

Confirm that the upload tool includes hidden files. After deployment, inspect
the browser console and response headers. `window.crossOriginIsolated` should
be `true` on hosts that support the included Apache configuration.

## Service Worker and cache updates

`sw.js` caches runtime and dataset resources and enforces the analysis
network lock. It must be served from the application root so its scope covers
the entire app.

When changing cached application/runtime assets, update the relevant app/cache
version identifiers and test a fresh browser profile as well as an upgrade from
the preceding version. A hard refresh alone does not always remove existing
Cache Storage or an older Service Worker; use the browser's site-data controls
when testing a completely clean installation.

## Local distribution

Distribute the complete repository, including `start-local.cmd`,
`start-local.sh`, `start-local.command`, `scripts/`, `webr/`, and `library/`.
The local launchers bind only to `127.0.0.1` and open Upload count matrix mode.

Do not advertise direct `file://` use. Browser security restrictions prevent
the required modules, workers, WebAssembly, and Service Worker from operating
correctly without the loopback server.

See [Local Use and Privacy](Local-Use-and-Privacy.md) for operating-system
instructions and the precise privacy boundary.

## Deployment checklist

- Upload the complete application, including `.htaccess` and `sw.js`.
- Confirm the webR and DESeq2 library files return 200 responses with correct
  MIME and content behavior.
- Confirm `config/datasets.json` loads and the dataset dropdown is populated.
- Confirm external RNADB files resolve from `/RNADB/Download/files/`.
- Confirm Data loading and Analysis preparation reach 100%.
- Confirm analysis reports that it is locked to local files.
- Test an uploaded matrix and at least one GExA dataset.
- Test two-group and multi-group designs as applicable.
- Test with a clean browser profile and with an existing Service Worker cache.
