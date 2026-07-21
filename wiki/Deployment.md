# Deployment

DEG on Web is a static web application.

Deploy all files in the repository to the target static web directory.

## Required Headers

webR performs best when the page is cross-origin isolated. On Apache-compatible
hosting, keep `.htaccess` in the deployed directory.

The file sets:

- `Cross-Origin-Opener-Policy`
- `Cross-Origin-Embedder-Policy`
- `Cross-Origin-Resource-Policy`

After deployment, check in the browser console:

```javascript
window.crossOriginIsolated
```

The expected value is `true`.

## Runtime Files

The repository includes:

- `webr/`
- `library/library.data.gz`
- `library/library-uncompressed.data`
- library metadata files

Do not remove these files unless the runtime configuration in `js/config.js` is
updated.

## External Data Files

The app expects public data files under the path configured in `js/config.js`.
Update `externalDataBaseUrl` if the data files move.
