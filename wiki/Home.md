# DEAR-OWL Wiki

DEAR-OWL (Differential Expression Analysis Resource on the Web, Lite) performs
plant RNA-seq differential expression analysis in the browser. The same code
base supports a hosted GExA-connected web application and a locally runnable
application for user-supplied count matrices.

An uploaded count matrix stays in the browser. Once data loading and analysis
preparation finish, DEAR-OWL runs DESeq2 or the fast pairwise Z-test with
network access locked to browser-local files.

Its three central promises are that uploaded count data is not sent to the
server, analysis does not communicate after preparation, and the application
can run locally on Windows, macOS, and Linux. GExA datasets are fetched before
analysis only when a user selects them.

## Documentation

- [User Guide](User-Guide.md)
- [Local Use and Privacy](Local-Use-and-Privacy.md)
- [Dataset Catalog](Dataset-Catalog.md)
- [Deployment](Deployment.md)
- [Development](Development.md)

## Analysis principle

As a rule, compare samples within the same BioProject. This reduces unwanted
variation caused by differences in laboratory work, sequencing, and data
processing. Match tissue, developmental stage, cultivar, genotype, and other
important covariates whenever possible.

Before running an analysis, confirm the design from BioProject, BioSample, and
SRA records and, when possible, from the original publication. DEAR-OWL makes
the computation accessible, but it cannot correct a confounded experimental
design.
