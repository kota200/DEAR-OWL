import { WEBR_CONFIG } from "./config.js?v=20260727-defaults";
import {
  fetchArrayBufferWithProgress,
  formatError,
  gunzipArrayBuffer
} from "./utils.js";

const REQUIRED_PACKAGES = [
  "DESeq2",
  "locfit",
  "Rcpp",
  "RcppArmadillo",
  "Biobase",
  "BiocGenerics",
  "BiocParallel",
  "S4Vectors",
  "IRanges",
  "XVector",
  "S4Arrays",
  "SparseArray",
  "DelayedArray",
  "Matrix",
  "MatrixGenerics",
  "Seqinfo",
  "GenomicRanges",
  "SummarizedExperiment",
  "matrixStats",
  "ggplot2"
];

const PACKAGES_TO_LOAD = [
  "BiocGenerics",
  "S4Vectors",
  "IRanges",
  "XVector",
  "S4Arrays",
  "SparseArray",
  "DelayedArray",
  "Matrix",
  "MatrixGenerics",
  "Seqinfo",
  "GenomicRanges",
  "Biobase",
  "SummarizedExperiment",
  "BiocParallel",
  "matrixStats",
  "locfit",
  "ggplot2",
  "Rcpp",
  "RcppArmadillo",
  "DESeq2"
];

// R.js creates these files lazily. They must be present in Cache Storage
// before analysis enables the offline-only network lock, otherwise a later
// DESeq2 code path can fail inside the worker while trying to mount an
// Emscripten filesystem image.
const WEBR_LAZY_FILE_PATHS = [
  "vfs/usr/lib/R/library/translations/DESCRIPTION",
  "vfs/etc/ssl/cert.pem",
  "vfs/etc/fonts/fonts.conf",
  "vfs/usr/share/fonts/NotoSans-Bold.ttf",
  "vfs/usr/share/fonts/NotoSans-BoldItalic.ttf",
  "vfs/usr/share/fonts/NotoSans-Italic.ttf",
  "vfs/usr/share/fonts/NotoSans-Regular.ttf",
  "vfs/usr/share/fonts/NotoSansMono-Bold.ttf",
  "vfs/usr/share/fonts/NotoSansMono-Regular.ttf",
  "vfs/usr/share/fonts/NotoSerif-Bold.ttf",
  "vfs/usr/share/fonts/NotoSerif-BoldItalic.ttf",
  "vfs/usr/share/fonts/NotoSerif-Italic.ttf",
  "vfs/usr/share/fonts/NotoSerif-Regular.ttf",
  "vfs/var/cache/fontconfig/3830d5c3ddfd5cd38a049b759396e72e-le32d8.cache-9",
  "vfs/var/cache/fontconfig/CACHEDIR.TAG"
];

const WEBR_LAZY_IMAGE_PATHS = [
  "vfs/usr/lib/R/doc.data.gz",
  "vfs/usr/lib/R/library/base/demo.data.gz",
  "vfs/usr/lib/R/library/base/help.data.gz",
  "vfs/usr/lib/R/library/base/html.data.gz",
  "vfs/usr/lib/R/library/compiler/help.data.gz",
  "vfs/usr/lib/R/library/compiler/html.data.gz",
  "vfs/usr/lib/R/library/datasets/help.data.gz",
  "vfs/usr/lib/R/library/datasets/html.data.gz",
  "vfs/usr/lib/R/library/graphics/demo.data.gz",
  "vfs/usr/lib/R/library/graphics/help.data.gz",
  "vfs/usr/lib/R/library/graphics/html.data.gz",
  "vfs/usr/lib/R/library/grDevices/afm.data.gz",
  "vfs/usr/lib/R/library/grDevices/demo.data.gz",
  "vfs/usr/lib/R/library/grDevices/enc.data.gz",
  "vfs/usr/lib/R/library/grDevices/fonts.data.gz",
  "vfs/usr/lib/R/library/grDevices/help.data.gz",
  "vfs/usr/lib/R/library/grDevices/html.data.gz",
  "vfs/usr/lib/R/library/grDevices/libs.data.gz",
  "vfs/usr/lib/R/library/grid/doc.data.gz",
  "vfs/usr/lib/R/library/grid/help.data.gz",
  "vfs/usr/lib/R/library/grid/html.data.gz",
  "vfs/usr/lib/R/library/methods/help.data.gz",
  "vfs/usr/lib/R/library/methods/html.data.gz",
  "vfs/usr/lib/R/library/parallel.data.gz",
  "vfs/usr/lib/R/library/splines/help.data.gz",
  "vfs/usr/lib/R/library/splines/html.data.gz",
  "vfs/usr/lib/R/library/stats/demo.data.gz",
  "vfs/usr/lib/R/library/stats/doc.data.gz",
  "vfs/usr/lib/R/library/stats/help.data.gz",
  "vfs/usr/lib/R/library/stats/html.data.gz",
  "vfs/usr/lib/R/library/stats4/help.data.gz",
  "vfs/usr/lib/R/library/stats4/html.data.gz",
  "vfs/usr/lib/R/library/tcltk.data.gz",
  "vfs/usr/lib/R/library/tools/help.data.gz",
  "vfs/usr/lib/R/library/tools/html.data.gz",
  "vfs/usr/lib/R/library/tools/misc.data.gz",
  "vfs/usr/lib/R/library/translations.data.gz",
  "vfs/usr/lib/R/library/utils/doc.data.gz",
  "vfs/usr/lib/R/library/utils/help.data.gz",
  "vfs/usr/lib/R/library/utils/html.data.gz",
  "vfs/usr/lib/R/library/utils/misc.data.gz",
  "vfs/usr/lib/R/library/webr/help.data.gz",
  "vfs/usr/lib/R/library/webr/html.data.gz",
  "vfs/usr/lib/R/share.data.gz",
  "vfs/usr/share/gdal.data.gz",
  "vfs/usr/share/proj.data.gz",
  "vfs/usr/share/udunits.data.gz"
];

export function getWebRChannelSupport(runtime = globalThis) {
  const crossOriginIsolated = runtime.crossOriginIsolated === true;
  const sharedArrayBufferAvailable = typeof runtime.SharedArrayBuffer === "function";

  return {
    crossOriginIsolated,
    sharedArrayBufferAvailable,
    channelType: crossOriginIsolated && sharedArrayBufferAvailable
      ? "SharedArrayBuffer"
      : "PostMessage"
  };
}

export function chooseWebRChannel({
  forcePostMessage = false,
  managerStatus = "not-started",
  currentChannel = null,
  supportedChannel = "PostMessage"
} = {}) {
  if (forcePostMessage) {
    return "PostMessage";
  }

  if (["initializing", "ready"].includes(managerStatus) && currentChannel) {
    return currentChannel;
  }

  return supportedChannel;
}

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function parsePackageList(text) {
  return new Set(
    text
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
}

const APP_BASE_URL = new URL("../", import.meta.url);

function appUrl(path) {
  return new URL(path, APP_BASE_URL).href;
}

function versionedUrl(path, version) {
  const url = new URL(path, APP_BASE_URL);
  url.searchParams.set("v", version);
  return url.href;
}

export function getWebROfflineAssetUrls(channelType = getWebRChannelSupport().channelType) {
  const baseUrl = appUrl(WEBR_CONFIG.baseUrl);
  const workerLibraryMetadataUrl = WEBR_CONFIG.workerLibraryDataUrl.replace(
    /\.data(?:\.gz)?(?:[?#].*)?$/,
    ".js.metadata"
  );

  const commonUrls = [
    new URL(WEBR_CONFIG.modulePath, baseUrl).href,
    new URL("webr-worker.js", baseUrl).href,
    new URL("R.js", baseUrl).href,
    new URL("R.wasm", baseUrl).href,
    new URL("libRblas.so", baseUrl).href,
    new URL("libRlapack.so", baseUrl).href
  ];
  const lazyFilesystemUrls = [
    ...WEBR_LAZY_FILE_PATHS.map((path) => new URL(path, baseUrl).href),
    ...WEBR_LAZY_IMAGE_PATHS.flatMap((path) => [
      new URL(path, baseUrl).href,
      new URL(path.replace(/\.data(?:\.gz)?$/, ".js.metadata"), baseUrl).href
    ])
  ];

  if (channelType === "SharedArrayBuffer") {
    return [
      ...commonUrls,
      ...lazyFilesystemUrls,
      versionedUrl(WEBR_CONFIG.workerLibraryDataUrl, WEBR_CONFIG.libraryVersion),
      versionedUrl(workerLibraryMetadataUrl, WEBR_CONFIG.libraryVersion)
    ];
  }

  return [
    ...commonUrls,
    ...lazyFilesystemUrls,
    versionedUrl(WEBR_CONFIG.libraryDataUrl, WEBR_CONFIG.libraryVersion),
    versionedUrl(WEBR_CONFIG.libraryMetadataUrl, WEBR_CONFIG.libraryVersion)
  ];
}

function rString(value) {
  return JSON.stringify(String(value));
}

async function loadRPackage(webR, packageName) {
  const packageLiteral = JSON.stringify(packageName);
  const rCode = `
    tryCatch(
      {
        suppressPackageStartupMessages(
          library(
            ${packageLiteral},
            character.only = TRUE
          )
        )

        paste0(
          "OK|",
          as.character(
            packageVersion(
              ${packageLiteral}
            )
          )
        )
      },
      error = function(e) {
        paste0(
          "ERROR|",
          conditionMessage(e)
        )
      }
    )
  `;

  const result = await webR.evalRString(rCode);

  if (result.startsWith("ERROR|")) {
    throw new Error(`Package: ${packageName}\nR error: ${result.substring("ERROR|".length)}`);
  }

  if (!result.startsWith("OK|")) {
    throw new Error(`Package: ${packageName}\nUnknown result: ${result}`);
  }

  return result.substring("OK|".length);
}

export class WebRManager {
  constructor() {
    const channelSupport = getWebRChannelSupport();
    this.webR = null;
    this.status = "not-started";
    this.initializationPromise = null;
    this.loadedVersions = {};
    this.runtimeInformation = null;
    this.channelType = channelSupport.channelType;
    this.crossOriginIsolated = channelSupport.crossOriginIsolated;
    this.sharedArrayBufferAvailable = channelSupport.sharedArrayBufferAvailable;
    this.lastMessage = "webR not started";
    this.failureStage = null;
    this.listeners = new Set();
  }

  onStatus(listener) {
    this.listeners.add(listener);
    listener({ status: this.status, message: this.lastMessage });
    return () => this.listeners.delete(listener);
  }

  emit(message, detail = {}) {
    this.lastMessage = message;
    const payload = {
      status: this.status,
      message,
      ...detail
    };

    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  resetAfterFailure() {
    if (this.status === "failed") {
      this.webR = null;
      this.initializationPromise = null;
      this.loadedVersions = {};
      this.runtimeInformation = null;
      const channelSupport = getWebRChannelSupport();
      this.channelType = channelSupport.channelType;
      this.crossOriginIsolated = channelSupport.crossOriginIsolated;
      this.sharedArrayBufferAvailable = channelSupport.sharedArrayBufferAvailable;
      this.status = "not-started";
      this.lastMessage = "webR not started";
      this.failureStage = null;
    }
  }

  async initialize({ forcePostMessage = false } = {}) {
    const channelSupport = getWebRChannelSupport();
    const requestedChannelType = chooseWebRChannel({
      forcePostMessage,
      managerStatus: this.status,
      currentChannel: this.channelType,
      supportedChannel: channelSupport.channelType
    });

    if (this.status === "ready" && this.webR && this.channelType === requestedChannelType) {
      return this.webR;
    }

    if (this.status === "ready" && this.webR) {
      try {
        this.webR.close();
      } catch {
        // A ready runtime can be replaced even if its worker already closed.
      }
      this.webR = null;
      this.initializationPromise = null;
      this.loadedVersions = {};
      this.runtimeInformation = null;
      this.status = "not-started";
    }

    if (this.status === "initializing" && this.initializationPromise) {
      return this.initializationPromise;
    }

    this.resetAfterFailure();
    this.status = "initializing";
    this.failureStage = null;
    this.initializationPromise = this.performInitialization(requestedChannelType);

    try {
      this.webR = await this.initializationPromise;
      this.status = "ready";
      this.emit("webR and DESeq2 are ready");
      return this.webR;
    } catch (error) {
      this.failureStage = this.lastMessage;
      const failedRuntime = this.webR;
      this.webR = null;
      try {
        failedRuntime?.close();
      } catch {
        // The failed worker may already be closed.
      }
      this.status = "failed";
      this.emit("webR initialization failed", { error });
      this.initializationPromise = null;
      throw error;
    }
  }

  async performInitialization(requestedChannelType) {
    this.emit("Loading webR");

    const baseUrl = appUrl(WEBR_CONFIG.baseUrl);
    const moduleUrl = new URL(WEBR_CONFIG.modulePath, baseUrl).href;
    const { WebR, ChannelType } = await import(moduleUrl);
    const channelSupport = getWebRChannelSupport();
    this.channelType = requestedChannelType || channelSupport.channelType;
    this.crossOriginIsolated = channelSupport.crossOriginIsolated;
    this.sharedArrayBufferAvailable = channelSupport.sharedArrayBufferAvailable;

    const selectedChannelType = this.channelType === "SharedArrayBuffer"
      ? ChannelType.SharedArrayBuffer
      : ChannelType.PostMessage;

    this.emit(`Using webR ${this.channelType} channel`, {
      ...channelSupport,
      channelType: this.channelType
    });

    const webR = new WebR({
      baseUrl,
      channelType: selectedChannelType
    });
    this.webR = webR;

    await webR.init();
    this.emit("webR initialized");

    this.runtimeInformation = await webR.evalRString(`
      paste(
        R.version.string,
        R.version$platform,
        sep = "\\n"
      )
    `);

    this.emit("Creating DESeq2 library mount point");

    try {
      await webR.FS.mkdir("/deseq2-library");
    } catch (error) {
      this.emit("DESeq2 library mount point already exists", {
        detail: formatError(error)
      });
    }

    if (this.channelType === "SharedArrayBuffer") {
      const librarySourceUrl = new URL(
        WEBR_CONFIG.workerLibraryDataUrl,
        APP_BASE_URL
      ).href;
      this.emit("Mounting uncompressed DESeq2 library inside the webR worker");
      await webR.evalRVoid(`
        suppressMessages(
          webr::mount(
            mountpoint = "/deseq2-library",
            source = ${rString(librarySourceUrl)},
            type = "workerfs"
          )
        )
      `);
    } else {
      this.emit("Loading DESeq2 library image");

      const libraryDataUrl = versionedUrl(
        WEBR_CONFIG.libraryDataUrl,
        WEBR_CONFIG.libraryVersion
      );
      const libraryMetadataUrl = versionedUrl(
        WEBR_CONFIG.libraryMetadataUrl,
        WEBR_CONFIG.libraryVersion
      );
      const [libraryBuffer, metadataResponse] = await Promise.all([
        fetchArrayBufferWithProgress(
          libraryDataUrl,
          (progress) => {
            this.emit("Loading DESeq2 library image", {
              loaded: progress.loaded,
              total: progress.total
            });
          },
          { cache: "force-cache" }
        ),
        fetch(libraryMetadataUrl, { cache: "force-cache" })
      ]);

      if (!metadataResponse.ok) {
        throw new Error(`Failed to fetch library metadata: HTTP ${metadataResponse.status}`);
      }

      const uncompressedLibraryBuffer = await gunzipArrayBuffer(libraryBuffer);
      const libraryBlob = new Blob(
        [uncompressedLibraryBuffer],
        { type: "application/octet-stream" }
      );
      const metadata = await metadataResponse.json();
      this.emit("Mounting DESeq2 library");
      await webR.FS.mount(
        "WORKERFS",
        {
          packages: [
            {
              blob: libraryBlob,
              metadata
            }
          ]
        },
        "/deseq2-library"
      );
    }

    this.emit("Checking mounted packages");

    const packageText = await webR.evalRString(`
      paste(
        sort(
          list.files(
            "/deseq2-library"
          )
        ),
        collapse = ", "
      )
    `);

    const mountedPackages = parsePackageList(packageText);
    const missingPackages = REQUIRED_PACKAGES.filter((packageName) => !mountedPackages.has(packageName));

    if (missingPackages.length > 0) {
      throw new Error(`The DESeq2 filesystem image is missing packages:\n${missingPackages.join("\n")}`);
    }

    this.emit("Configuring R library paths");

    await webR.evalRVoid(`
      .libPaths(
        unique(
          c(
            "/deseq2-library",
            .libPaths()
          )
        )
      )
    `);

    this.emit("Loading R packages");

    for (let packageIndex = 0; packageIndex < PACKAGES_TO_LOAD.length; packageIndex += 1) {
      const packageName = PACKAGES_TO_LOAD[packageIndex];
      this.emit(`Loading R package: ${packageName}`, {
        packageIndex: packageIndex + 1,
        packageCount: PACKAGES_TO_LOAD.length
      });
      await nextPaint();
      this.loadedVersions[packageName] = await loadRPackage(webR, packageName);
    }

    this.emit("DESeq2 loaded", {
      versions: this.loadedVersions,
      runtimeInformation: this.runtimeInformation
    });

    return webR;
  }

  getRuntimeSummary() {
    return {
      webRVersion: "0.6.0",
      rVersion: this.runtimeInformation || null,
      deseq2Version: this.loadedVersions.DESeq2 || null,
      locfitVersion: this.loadedVersions.locfit || null,
      channelType: this.channelType,
      crossOriginIsolated: this.crossOriginIsolated,
      sharedArrayBufferAvailable: this.sharedArrayBufferAvailable,
      managerStatus: this.status,
      managerMessage: this.lastMessage,
      failureStage: this.failureStage
    };
  }

  getChannelSummary() {
    if (this.status === "not-started" || this.status === "failed") {
      const channelSupport = getWebRChannelSupport();
      this.channelType = channelSupport.channelType;
      this.crossOriginIsolated = channelSupport.crossOriginIsolated;
      this.sharedArrayBufferAvailable = channelSupport.sharedArrayBufferAvailable;
    }

    return {
      channelType: this.channelType,
      crossOriginIsolated: this.crossOriginIsolated,
      sharedArrayBufferAvailable: this.sharedArrayBufferAvailable
    };
  }
}

const WEBR_MANAGER_GLOBAL_KEY = Symbol.for("dear-owl.webr-manager.singleton");

if (!globalThis[WEBR_MANAGER_GLOBAL_KEY]) {
  Object.defineProperty(globalThis, WEBR_MANAGER_GLOBAL_KEY, {
    value: new WebRManager(),
    configurable: false,
    enumerable: false,
    writable: false
  });
}

// Query strings create separate ES module instances. Keeping the manager on a
// global Symbol makes app.js and the unchanged DEG runners share one webR.
export const webrManager = globalThis[WEBR_MANAGER_GLOBAL_KEY];
