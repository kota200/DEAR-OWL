# Development

## Local Checks

Use Node.js to run syntax checks and tests:

```powershell
Get-ChildItem -LiteralPath .\js -Filter *.js | ForEach-Object { node --check $_.FullName }
node .\tests\unit-tests.mjs
node .\tests\validate-runner-r.mjs
```

## Local Server

Use the cross-origin-isolated helper server:

```powershell
node .\tests\serve-cross-origin-isolated.mjs 8766 ..
```

Then open:

```text
http://127.0.0.1:8766/DEG-on-Web/
```

## Important Files

- `index.html`: main application page
- `help.html`: user help page
- `js/app.js`: application orchestration
- `js/data-loader.js`: dataset loading
- `js/deseq-runner.js`: DESeq2 execution through webR
- `js/result-table.js`: result table UI
- `js/plots.js`: SVG plot generation
- `config/datasets.json`: dataset catalog

## Release Checklist

Before publishing changes:

- Run syntax checks.
- Run unit tests.
- Confirm `help.html` loads.
- Confirm `index.html` loads.
- Confirm the dataset catalog points to the correct public data location.
- Confirm cross-origin isolation headers on the deployed site.
