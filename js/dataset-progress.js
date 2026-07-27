const DEFAULT_STAGE = "Preparing dataset...";
const COMPLETE_STAGE = "Dataset ready";
const ERROR_STAGE = "Dataset loading failed";

export const DATASET_LOAD_PROGRESS_INITIAL_STATE = Object.freeze({
  active: false,
  mode: "indeterminate",
  stage: "",
  loadedBytes: null,
  totalBytes: null,
  percent: null,
  estimated: false,
  completed: false,
  error: false
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function calculateProgressPercent(loadedBytes, totalBytes) {
  const loaded = finiteNumber(loadedBytes);
  const total = finiteNumber(totalBytes);

  if (loaded === null || total === null || total <= 0) {
    return null;
  }

  return clamp(loaded / total * 100, 0, 100);
}

export function formatProgressBytes(bytes) {
  const value = finiteNumber(bytes);

  if (value === null || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let scaled = value;
  let unitIndex = 0;

  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }

  return `${scaled.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function stageFromMessage(message) {
  const text = String(message || "");

  if (/dataset ready|ready:/i.test(text)) {
    return COMPLETE_STAGE;
  }
  if (/fail|error/i.test(text)) {
    return ERROR_STAGE;
  }
  if (/configuration|catalog|manifest/i.test(text)) {
    return "Loading dataset configuration";
  }
  if (/gene (?:list|order|information)/i.test(text)) {
    return "Loading gene information";
  }
  if (/header/i.test(text)) {
    return "Preparing count matrix header";
  }
  if (/download/i.test(text)) {
    return "Downloading dataset files";
  }
  if (/decod|decompress|gunzip/i.test(text)) {
    return "Decompressing data";
  }
  if (/parse|sample metadata|sample information|samples scanned|reading sample/i.test(text)) {
    return "Now loading datasets...";
  }
  if (/validat/i.test(text)) {
    return "Validating dataset";
  }
  if (/loaded/i.test(text)) {
    return "Finalizing dataset";
  }

  return text || DEFAULT_STAGE;
}

function displayStage(stage) {
  return /^Parsing sample/i.test(String(stage || ""))
    ? "Now loading datasets..."
    : String(stage || DEFAULT_STAGE);
}

function estimatedPercentForStage(stage, progressPercent, fallbackPercent = null) {
  const display = displayStage(stage);

  if (display === COMPLETE_STAGE) {
    return 100;
  }
  if (display === ERROR_STAGE) {
    return null;
  }
  if (display === "Downloading dataset files") {
    const filePercent = progressPercent === null ? 0 : progressPercent;
    return clamp(1 + filePercent * 0.54, 1, 55);
  }
  if (display === "Now loading datasets...") {
    if (progressPercent !== null) {
      return clamp(1 + progressPercent * 0.84, 1, 85);
    }
    return fallbackPercent ?? 1;
  }

  const estimates = new Map([
    [DEFAULT_STAGE, 0],
    ["Preparing dataset...", 0],
    ["Loading dataset configuration", 1],
    ["Loading sample metadata", 1],
    ["Preparing count matrix", 1],
    ["Preparing count matrix header", 1],
    ["Loading gene information", 1],
    ["Decompressing data", 1],
    ["Validating dataset", 86],
    ["Finalizing dataset", 94]
  ]);

  return estimates.get(display) ?? 1;
}

export function normalizeDatasetProgressEvent(progress, fallback = {}) {
  const isObject = progress && typeof progress === "object";
  const message = isObject
    ? String(progress.message || progress.stage || fallback.message || fallback.stage || DEFAULT_STAGE)
    : String(progress || fallback.message || fallback.stage || DEFAULT_STAGE);
  const stage = displayStage(isObject
    ? progress.stage || stageFromMessage(message)
    : stageFromMessage(message));
  const loadedBytes = isObject
    ? finiteNumber(progress.loadedBytes ?? progress.loaded)
    : null;
  const totalBytes = isObject
    ? finiteNumber(progress.totalBytes ?? progress.total)
    : null;
  const calculatedPercent = calculateProgressPercent(loadedBytes, totalBytes);
  const explicitPercent = isObject ? finiteNumber(progress.percent) : null;
  const canUseExplicitPercent = explicitPercent !== null &&
    (progress.mode === "determinate" || totalBytes !== null);
  const measuredPercent = canUseExplicitPercent
    ? clamp(explicitPercent, 0, 100)
    : calculatedPercent;
  const fallbackPercent = finiteNumber(fallback.percent);
  const estimatedPercent = estimatedPercentForStage(stage, measuredPercent, fallbackPercent);
  const percent = measuredPercent === 100 && stage === COMPLETE_STAGE
    ? 100
    : estimatedPercent;

  return {
    message,
    stage,
    loadedBytes,
    totalBytes,
    percent,
    estimated: stage !== COMPLETE_STAGE,
    mode: percent === null ? "indeterminate" : "determinate"
  };
}

function setText(element, value) {
  if (element) {
    element.textContent = value;
  }
}

function setAttribute(element, name, value) {
  if (element) {
    element.setAttribute(name, value);
  }
}

function removeAttribute(element, name) {
  if (element) {
    element.removeAttribute(name);
  }
}

function toggleClass(element, className, force) {
  if (element?.classList) {
    element.classList.toggle(className, force);
  }
}

function roundedPercent(percent, estimated = false) {
  if (percent === null) {
    return "";
  }
  const text = `${Math.round(percent)}%`;
  return estimated ? `Estimated progress: ${text}` : text;
}

function bytesText(state) {
  if (state.loadedBytes === null) {
    return "";
  }
  if (state.totalBytes !== null && state.totalBytes > 0) {
    return `${formatProgressBytes(state.loadedBytes)} / ${formatProgressBytes(state.totalBytes)}`;
  }
  return `${formatProgressBytes(state.loadedBytes)} loaded`;
}

export function createDatasetLoadProgressController(elements, options = {}) {
  const root = elements.root || elements.datasetLoadProgress;
  const label = elements.label || elements.datasetLoadProgressLabel;
  const percent = elements.percent || elements.datasetLoadProgressPercent;
  const track = elements.track || elements.datasetLoadProgressTrack;
  const bar = elements.bar || elements.datasetLoadProgressBar;
  const stage = elements.stage || elements.datasetLoadProgressStage;
  const bytes = elements.bytes || elements.datasetLoadProgressBytes;
  const live = elements.live || elements.datasetLoadProgressLive;
  const hideDelayMs = Number.isFinite(options.hideDelayMs) ? options.hideDelayMs : 600;
  const scheduleFrame = options.scheduleFrame ||
    ((callback) => (typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(callback)
      : setTimeout(callback, 16)));
  const cancelFrame = options.cancelFrame ||
    ((handle) => {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(handle);
      } else {
        clearTimeout(handle);
      }
    });
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;

  let state = { ...DATASET_LOAD_PROGRESS_INITIAL_STATE };
  let activeLoadId = 0;
  let hideTimer = null;
  let frameHandle = null;
  let lastLiveStage = "";
  let lastLivePercent = null;

  function clearHideTimer() {
    if (hideTimer !== null) {
      clearTimer(hideTimer);
      hideTimer = null;
    }
  }

  function clearFrame() {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
  }

  function updateLiveText(force = false) {
    if (!live) {
      return;
    }

    const livePercent = state.percent === null ? null : Math.round(state.percent);
    const percentChanged = livePercent !== null &&
      (lastLivePercent === null || Math.abs(livePercent - lastLivePercent) >= 10);
    const stageChanged = state.stage !== lastLiveStage;

    if (!force && !stageChanged && !percentChanged) {
      return;
    }

    live.textContent = livePercent === null
      ? state.stage
      : `${livePercent} percent${state.estimated ? " estimated" : ""}, ${state.stage}`;
    lastLiveStage = state.stage;
    lastLivePercent = livePercent;
  }

  function render(forceLive = false) {
    frameHandle = null;

    if (!root) {
      return;
    }

    root.hidden = !state.active && !state.completed && !state.error;
    toggleClass(root, "is-determinate", state.mode === "determinate" && !state.error);
    toggleClass(root, "is-indeterminate", state.mode === "indeterminate" && !state.completed && !state.error);
    toggleClass(root, "is-complete", state.completed);
    toggleClass(root, "is-error", state.error);

    setText(label, state.stage || DEFAULT_STAGE);
    setText(percent, roundedPercent(state.percent, state.estimated));
    setText(stage, state.completed || state.error ? "" : state.stage);
    setText(bytes, bytesText(state));

    if (bar) {
      bar.style.width = state.mode === "determinate" && state.percent !== null
        ? `${clamp(state.percent, 0, 100)}%`
        : "";
    }

    setAttribute(track, "aria-valuemin", "0");
    setAttribute(track, "aria-valuemax", "100");
    if (state.mode === "determinate" && state.percent !== null) {
      const now = String(Math.round(state.percent));
      setAttribute(track, "aria-valuenow", now);
      setAttribute(
        track,
        "aria-valuetext",
        `${now} percent${state.estimated ? " estimated" : ""}, ${state.stage}`
      );
    } else {
      removeAttribute(track, "aria-valuenow");
      setAttribute(track, "aria-valuetext", state.stage || DEFAULT_STAGE);
    }

    updateLiveText(forceLive || state.completed || state.error);
  }

  function scheduleRender(forceLive = false) {
    if (frameHandle !== null) {
      return;
    }
    frameHandle = scheduleFrame(() => render(forceLive));
  }

  function isCurrent(loadId) {
    return loadId === activeLoadId;
  }

  function start(loadId, progress = null) {
    clearHideTimer();
    clearFrame();
    activeLoadId = loadId;
    const event = normalizeDatasetProgressEvent(progress || {
      message: DEFAULT_STAGE,
      stage: DEFAULT_STAGE,
      mode: "indeterminate"
    });
    state = {
      ...DATASET_LOAD_PROGRESS_INITIAL_STATE,
      active: true,
      mode: event.mode,
      stage: event.stage,
      loadedBytes: event.loadedBytes,
      totalBytes: event.totalBytes,
      percent: event.percent,
      estimated: event.estimated
    };
    lastLiveStage = "";
    lastLivePercent = null;
    render(true);
  }

  function update(loadId, progress) {
    if (!isCurrent(loadId)) {
      return false;
    }

    const event = normalizeDatasetProgressEvent(progress, state);
    const nextPercent = event.percent === null
      ? null
      : Math.max(event.percent, state.percent ?? 0);
    const keepMeasuredBytes = event.stage === "Now loading datasets..." &&
      event.totalBytes === null &&
      state.stage === event.stage &&
      state.totalBytes !== null;
    state = {
      ...state,
      active: true,
      completed: false,
      error: false,
      mode: nextPercent === null ? "indeterminate" : "determinate",
      stage: event.stage,
      loadedBytes: keepMeasuredBytes ? state.loadedBytes : event.loadedBytes,
      totalBytes: keepMeasuredBytes ? state.totalBytes : event.totalBytes,
      percent: nextPercent,
      estimated: event.estimated
    };
    scheduleRender();
    return true;
  }

  function complete(loadId, progress = null) {
    if (!isCurrent(loadId)) {
      return false;
    }

    clearHideTimer();
    clearFrame();
    const event = normalizeDatasetProgressEvent(progress || {
      message: COMPLETE_STAGE,
      stage: COMPLETE_STAGE,
      mode: "determinate",
      percent: 100
    }, state);
    state = {
      ...state,
      active: false,
      completed: true,
      error: false,
      mode: "determinate",
      stage: COMPLETE_STAGE,
      loadedBytes: event.loadedBytes ?? state.loadedBytes,
      totalBytes: event.totalBytes ?? state.totalBytes,
      percent: 100,
      estimated: false
    };
    render(true);

    const completedLoadId = loadId;
    hideTimer = setTimer(() => {
      if (!isCurrent(completedLoadId) || !state.completed) {
        return;
      }
      state = { ...DATASET_LOAD_PROGRESS_INITIAL_STATE };
      root.hidden = true;
      hideTimer = null;
    }, hideDelayMs);
    return true;
  }

  function fail(loadId, error = null) {
    if (!isCurrent(loadId)) {
      return false;
    }
    if (error?.name === "AbortError") {
      return false;
    }

    clearHideTimer();
    clearFrame();
    state = {
      ...state,
      active: false,
      completed: false,
      error: true,
      mode: "indeterminate",
      stage: ERROR_STAGE,
      percent: null,
      estimated: false
    };
    render(true);
    return true;
  }

  function reset(loadId = null) {
    if (loadId !== null && !isCurrent(loadId)) {
      return false;
    }

    clearHideTimer();
    clearFrame();
    state = { ...DATASET_LOAD_PROGRESS_INITIAL_STATE };
    if (root) {
      root.hidden = true;
      toggleClass(root, "is-determinate", false);
      toggleClass(root, "is-indeterminate", false);
      toggleClass(root, "is-complete", false);
      toggleClass(root, "is-error", false);
    }
    return true;
  }

  return {
    start,
    update,
    complete,
    fail,
    reset,
    isCurrent,
    getState: () => ({ ...state }),
    getActiveLoadId: () => activeLoadId
  };
}
