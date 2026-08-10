export const APP_CONFIG = {
  appVersion: "20260810-shared-prefilter",
  datasetCatalogUrl: "./config/datasets.json?v=20260717-gene-length",
  externalDataBaseUrl: "/RNADB/Download/files/",
  defaultPageSize: 100,
  maxPlotPoints: 50000,
  recommendedReplicates: 3
};

export const WEBR_CONFIG = {
  baseUrl: "./webr/",
  modulePath: "webr.js",
  libraryDataUrl: "./library/library.data.gz",
  libraryMetadataUrl: "./library/library.js.metadata",
  workerLibraryDataUrl: "./library/library-uncompressed.data",
  runtimeVersion: "20260714-1",
  libraryVersion: "20260714-1"
};

export const DEFAULT_PARAMETERS = {
  fdrThreshold: 0.05,
  log2FoldChangeThreshold: 1,
  preFiltering: true,
  preFilterMode: "total_count",
  minimumCount: 5,
  minimumSamples: 1,
  independentFiltering: true,
  fitType: "parametric",
  sfType: "ratio",
  cooksCutoff: true,
  test: "Wald"
};

export const DEFAULT_PLOTS = {
  ma: true,
  volcano: true,
  pca: false,
  sampleCorrelation: false,
  sampleDistance: false
};

export const SAMPLE_COLUMNS = [
  "sample_id",
  "BioProject",
  "BioSample",
  "sample_name",
  "treatment",
  "tissue",
  "stage",
  "cultivar",
  "line",
  "temperature",
  "attributes"
];

export const COLUMN_LABELS = {
  sample_id: "Sample ID",
  SRA: "Sample ID",
  BioProject: "BioProject",
  BioSample: "BioSample",
  sample_name: "Sample name",
  treatment: "Treatment",
  tissue: "Tissue / organ",
  stage: "Developmental stage",
  cultivar: "Cultivar / line",
  line: "Cultivar / line",
  temperature: "Temperature",
  attributes: "Other metadata"
};

export const RESULT_COLUMNS = [
  "gene_id",
  "direction",
  "significant",
  "baseMean",
  "log2FoldChange",
  "lfcSE",
  "stat",
  "pvalue",
  "padj",
  "control_tpm_mean",
  "treatment_tpm_mean",
  "control_tpm_median",
  "treatment_tpm_median",
  "arabidopsis_homolog",
  "rice_homolog",
  "gexa_link",
  "tgif_link"
];

export const RESULT_COLUMN_LABELS = {
  gene_id: "Gene ID",
  control_tpm_mean: "Control TPM mean",
  treatment_tpm_mean: "Treatment TPM mean",
  control_tpm_median: "Control TPM median",
  treatment_tpm_median: "Treatment TPM median",
  arabidopsis_homolog: "Arabidopsis homolog",
  rice_homolog: "Rice homolog",
  gexa_link: "GExA link",
  tgif_link: "TGIF-DB link"
};
