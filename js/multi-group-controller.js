import { SampleSelector } from "./sample-selector.js";
import {
  countBy,
  unique
} from "./utils.js";

const MIN_GROUPS = 3;
const MAX_GROUPS = 12;
export const MAX_MULTI_GROUP_CONTRASTS = 12;

const DEFAULT_GROUP_LABELS = [
  "Control",
  "Treatment A",
  "Treatment B"
];

function sampleId(sample) {
  return sample.sample_id || sample.SRA || sample.sample || sample.id;
}

function newGroup(index) {
  return {
    id: `g${index + 1}`,
    label: DEFAULT_GROUP_LABELS[index] || `Group ${index + 1}`,
    sampleIds: new Set()
  };
}

function option(label, value = label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function contrastId(numeratorId, denominatorId) {
  return `${numeratorId}_vs_${denominatorId}`;
}

function labelForContrast(numerator, denominator) {
  return `${numerator.label} vs ${denominator.label}`;
}

export function buildGroupedColDataCsv(groups) {
  const rows = ["sample,group"];

  for (const group of groups) {
    for (const sample of group.samples) {
      rows.push(`${sampleId(sample)},${group.id}`);
    }
  }

  return `${rows.join("\r\n")}\r\n`;
}

export class MultiGroupController {
  constructor({
    root,
    selectorRoot,
    onChange
  }) {
    this.root = root;
    this.selectorRoot = selectorRoot;
    this.onChange = onChange;
    this.rows = [];
    this.groups = Array.from({ length: MIN_GROUPS }, (_, index) => newGroup(index));
    this.activeGroupId = this.groups[0].id;
    this.scope = "reference_vs_all";
    this.referenceId = this.groups[0].id;
    this.runGlobal = true;
    this.engine = "deseq2";
    this.customContrasts = [];
    this.renderShell();
  }

  renderShell() {
    this.root.replaceChildren();

    const head = document.createElement("div");
    head.className = "step-head compact-step-head";
    const title = document.createElement("h3");
    title.textContent = "Multi-group sample groups";
    head.append(title);

    this.groupGrid = document.createElement("div");
    this.groupGrid.className = "multi-group-grid";

    const actions = document.createElement("div");
    actions.className = "sample-actions";
    this.addGroupButton = document.createElement("button");
    this.addGroupButton.type = "button";
    this.addGroupButton.textContent = "Add group";
    this.addGroupButton.addEventListener("click", () => {
      if (this.groups.length >= MAX_GROUPS) {
        return;
      }
      this.groups.push(newGroup(this.groups.length));
      this.renderGroups();
      this.renderContrastControls();
      this.emitChange();
    });
    actions.append(this.addGroupButton);

    this.contrastPanel = document.createElement("div");
    this.contrastPanel.className = "contrast-panel";

    this.root.append(head, this.groupGrid, actions, this.contrastPanel);

    this.selector = new SampleSelector({
      root: this.selectorRoot,
      title: "Assign samples to the active group",
      role: "multi",
      getBlockedIds: () => this.assignedSampleIds(this.activeGroupId),
      onChange: (selectedRows) => {
        const activeGroup = this.activeGroup();
        activeGroup.sampleIds = new Set(selectedRows.map(sampleId));
        this.renderGroups();
        this.renderContrastControls();
        this.emitChange();
      }
    });

    this.renderGroups();
    this.renderContrastControls();
  }

  setRows(rows) {
    this.rows = rows.map((row) => ({
      ...row,
      sample_id: sampleId(row)
    }));
    for (const group of this.groups) {
      group.sampleIds.clear();
    }
    this.activeGroupId = this.groups[0].id;
    this.selector.setRows(this.rows);
    this.selector.setSelectedIds(this.activeGroup().sampleIds);
    this.renderGroups();
    this.renderContrastControls();
    this.emitChange();
  }

  setEngine(engine) {
    this.engine = engine;
    this.renderContrastControls();
  }

  activeGroup() {
    return this.groups.find((group) => group.id === this.activeGroupId) || this.groups[0];
  }

  assignedSampleIds(exceptGroupId = null) {
    const ids = new Set();

    for (const group of this.groups) {
      if (group.id === exceptGroupId) {
        continue;
      }
      for (const id of group.sampleIds) {
        ids.add(id);
      }
    }

    return ids;
  }

  samplesForGroup(group) {
    return this.rows.filter((row) => group.sampleIds.has(sampleId(row)));
  }

  selectGroup(groupId) {
    this.activeGroupId = groupId;
    this.selector.setSelectedIds(this.activeGroup().sampleIds);
    this.renderGroups();
    this.renderContrastControls();
    this.emitChange();
  }

  removeGroup(groupId) {
    if (this.groups.length <= MIN_GROUPS) {
      return;
    }
    this.groups = this.groups.filter((group) => group.id !== groupId);
    this.customContrasts = this.customContrasts.filter((contrast) =>
      contrast.numeratorId !== groupId && contrast.denominatorId !== groupId
    );
    if (!this.groups.some((group) => group.id === this.referenceId)) {
      this.referenceId = this.groups[0].id;
    }
    if (!this.groups.some((group) => group.id === this.activeGroupId)) {
      this.activeGroupId = this.groups[0].id;
      this.selector.setSelectedIds(this.activeGroup().sampleIds);
    }
    this.renderGroups();
    this.renderContrastControls();
    this.emitChange();
  }

  clearGroup(groupId) {
    const group = this.groups.find((entry) => entry.id === groupId);
    if (!group) {
      return;
    }
    group.sampleIds.clear();
    if (group.id === this.activeGroupId) {
      this.selector.setSelectedIds(group.sampleIds);
    }
    this.renderGroups();
    this.renderContrastControls();
    this.emitChange();
  }

  renderGroups() {
    this.groupGrid.replaceChildren();
    this.addGroupButton.disabled = this.groups.length >= MAX_GROUPS;

    for (const group of this.groups) {
      const samples = this.samplesForGroup(group);
      const card = document.createElement("div");
      card.className = "multi-group-card";
      card.classList.toggle("is-active", group.id === this.activeGroupId);

      const label = document.createElement("label");
      label.className = "multi-group-label";
      const labelText = document.createElement("span");
      labelText.textContent = "Group label";
      const input = document.createElement("input");
      input.value = group.label;
      input.maxLength = 80;
      input.addEventListener("input", () => {
        group.label = input.value;
        this.renderContrastControls();
        this.emitChange();
      });
      label.append(labelText, input);

      const count = document.createElement("strong");
      count.className = "multi-group-count";
      count.textContent = `${samples.length} samples`;

      const summary = document.createElement("p");
      summary.className = "muted";
      summary.textContent = samples.length
        ? `BioProject: ${countBy(samples.map((sample) => sample.BioProject))}`
        : "No samples assigned.";

      const warning = document.createElement("p");
      warning.className = "replicate-warning";
      warning.textContent = samples.length > 0 && samples.length < 3
        ? "Three or more biological replicates are recommended."
        : "";
      warning.hidden = !warning.textContent;

      const actions = document.createElement("div");
      actions.className = "sample-actions";
      const select = document.createElement("button");
      select.type = "button";
      select.textContent = group.id === this.activeGroupId ? "Active group" : "Select samples";
      select.disabled = group.id === this.activeGroupId;
      select.addEventListener("click", () => this.selectGroup(group.id));

      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "Clear group";
      clear.disabled = samples.length === 0;
      clear.addEventListener("click", () => this.clearGroup(group.id));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove group";
      remove.disabled = this.groups.length <= MIN_GROUPS;
      remove.addEventListener("click", () => this.removeGroup(group.id));
      actions.append(select, clear, remove);

      card.append(label, count, summary, warning, actions);
      this.groupGrid.append(card);
    }
  }

  renderContrastControls() {
    this.contrastPanel.replaceChildren();

    const title = document.createElement("h3");
    title.textContent = "Pairwise contrasts";

    const controls = document.createElement("div");
    controls.className = "contrast-controls";

    const referenceLabel = document.createElement("label");
    const referenceText = document.createElement("span");
    referenceText.textContent = "Reference group";
    const referenceSelect = document.createElement("select");
    for (const group of this.groups) {
      referenceSelect.append(option(group.label || group.id, group.id));
    }
    referenceSelect.value = this.referenceId;
    referenceSelect.addEventListener("change", () => {
      this.referenceId = referenceSelect.value;
      this.renderContrastControls();
      this.emitChange();
    });
    referenceLabel.append(referenceText, referenceSelect);

    const scopeLabel = document.createElement("label");
    const scopeText = document.createElement("span");
    scopeText.textContent = "Comparison scope";
    const scopeSelect = document.createElement("select");
    scopeSelect.append(
      option("Reference vs all", "reference_vs_all"),
      option("All pairwise", "all_pairwise"),
      option("Custom contrasts", "custom")
    );
    scopeSelect.value = this.scope;
    scopeSelect.addEventListener("change", () => {
      this.scope = scopeSelect.value;
      this.renderContrastControls();
      this.emitChange();
    });
    scopeLabel.append(scopeText, scopeSelect);

    const globalLabel = document.createElement("label");
    globalLabel.className = "inline-check run-global-control";
    const globalCheckbox = document.createElement("input");
    globalCheckbox.type = "checkbox";
    globalCheckbox.checked = this.runGlobal;
    globalCheckbox.disabled = this.engine === "javascript";
    globalCheckbox.addEventListener("change", () => {
      this.runGlobal = globalCheckbox.checked;
      this.emitChange();
    });
    globalLabel.append(globalCheckbox, document.createTextNode(" Run global LRT"));
    globalLabel.hidden = this.engine === "javascript";

    controls.append(referenceLabel, scopeLabel, globalLabel);

    this.contrastPanel.append(title, controls);

    if (this.engine === "javascript") {
      const note = document.createElement("p");
      note.className = "manual-note compact-note";
      note.textContent = "Ultrafast pairwise Z-test runs selected contrasts only. No global test is performed.";
      this.contrastPanel.append(note);
    }

    if (this.scope === "custom") {
      this.contrastPanel.append(this.renderCustomContrastEditor());
    }

    const preview = document.createElement("div");
    preview.className = "contrast-preview";
    const heading = document.createElement("strong");
    heading.textContent = "Contrast preview";
    const list = document.createElement("ul");
    const contrasts = this.getContrasts();

    if (contrasts.length === 0) {
      const item = document.createElement("li");
      item.textContent = "No contrasts selected.";
      list.append(item);
    } else {
      for (const contrast of contrasts) {
        const item = document.createElement("li");
        item.textContent = `${contrast.label}: positive log2FC means higher expression in ${contrast.numeratorLabel}.`;
        list.append(item);
      }
    }

    const cap = document.createElement("p");
    cap.className = "muted";
    cap.textContent = `${contrasts.length} of ${MAX_MULTI_GROUP_CONTRASTS} contrasts selected.`;

    preview.append(heading, list, cap);
    this.contrastPanel.append(preview);
  }

  renderCustomContrastEditor() {
    const editor = document.createElement("div");
    editor.className = "custom-contrast-editor";

    const rows = document.createElement("div");
    rows.className = "custom-contrast-list";

    for (const contrast of this.customContrasts) {
      const row = document.createElement("div");
      row.className = "custom-contrast-row";

      const numerator = document.createElement("select");
      const denominator = document.createElement("select");

      for (const group of this.groups) {
        numerator.append(option(group.label || group.id, group.id));
        denominator.append(option(group.label || group.id, group.id));
      }

      numerator.value = contrast.numeratorId;
      denominator.value = contrast.denominatorId;

      numerator.addEventListener("change", () => {
        contrast.numeratorId = numerator.value;
        this.renderContrastControls();
        this.emitChange();
      });
      denominator.addEventListener("change", () => {
        contrast.denominatorId = denominator.value;
        this.renderContrastControls();
        this.emitChange();
      });

      const versus = document.createElement("span");
      versus.textContent = "vs";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        this.customContrasts = this.customContrasts.filter((entry) => entry !== contrast);
        this.renderContrastControls();
        this.emitChange();
      });

      row.append(numerator, versus, denominator, remove);
      rows.append(row);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add custom contrast";
    add.disabled = this.customContrasts.length >= MAX_MULTI_GROUP_CONTRASTS;
    add.addEventListener("click", () => {
      const numerator = this.groups[1] || this.groups[0];
      const denominator = this.groups[0];
      this.customContrasts.push({
        numeratorId: numerator.id,
        denominatorId: denominator.id
      });
      this.renderContrastControls();
      this.emitChange();
    });

    editor.append(rows, add);
    return editor;
  }

  getGroups() {
    return this.groups.map((group) => ({
      id: group.id,
      label: group.label.trim(),
      samples: this.samplesForGroup(group)
    }));
  }

  getContrasts() {
    const byId = new Map(this.groups.map((group) => [group.id, group]));
    const contrasts = [];

    const addContrast = (numeratorId, denominatorId) => {
      if (numeratorId === denominatorId) {
        return;
      }
      const numerator = byId.get(numeratorId);
      const denominator = byId.get(denominatorId);
      if (!numerator || !denominator) {
        return;
      }
      const id = contrastId(numeratorId, denominatorId);
      if (contrasts.some((contrast) => contrast.id === id)) {
        return;
      }
      contrasts.push({
        id,
        numeratorId,
        denominatorId,
        numeratorLabel: numerator.label.trim() || numerator.id,
        denominatorLabel: denominator.label.trim() || denominator.id,
        label: labelForContrast(numerator, denominator)
      });
    };

    if (this.scope === "reference_vs_all") {
      for (const group of this.groups) {
        if (group.id !== this.referenceId) {
          addContrast(group.id, this.referenceId);
        }
      }
    } else if (this.scope === "all_pairwise") {
      for (let numeratorIndex = 1; numeratorIndex < this.groups.length; numeratorIndex += 1) {
        for (let denominatorIndex = 0; denominatorIndex < numeratorIndex; denominatorIndex += 1) {
          addContrast(this.groups[numeratorIndex].id, this.groups[denominatorIndex].id);
        }
      }
    } else {
      for (const contrast of this.customContrasts) {
        addContrast(contrast.numeratorId, contrast.denominatorId);
      }
    }

    return contrasts;
  }

  validate({ plots = {}, parameters = {} } = {}) {
    const errors = [];
    const warnings = [];
    const groups = this.getGroups();
    const labels = groups.map((group) => group.label);
    const labelSet = new Set(labels.map((label) => label.toLowerCase()));
    const allSamples = groups.flatMap((group) => group.samples);
    const sampleIds = allSamples.map(sampleId);
    const duplicateSampleIds = sampleIds.filter((id, index) => sampleIds.indexOf(id) !== index);
    const contrasts = this.getContrasts();
    const bioProjects = unique(allSamples.map((sample) => sample.BioProject));

    if (groups.length < MIN_GROUPS) {
      errors.push("At least 3 groups are required for multi-group comparison.");
    }

    if (labels.some((label) => !label)) {
      errors.push("Group labels must not be empty.");
    }

    if (labelSet.size !== labels.length) {
      errors.push("Group labels must be unique.");
    }

    for (const group of groups) {
      if (group.samples.length < 2) {
        errors.push(`${group.label || group.id} requires at least 2 samples.`);
      } else if (group.samples.length < 3) {
        warnings.push(`${group.label} has fewer than 3 biological replicates. The analysis can run with 2, but 3 or more are recommended.`);
      }
    }

    if (duplicateSampleIds.length > 0) {
      errors.push("The same sample cannot be assigned to multiple groups.");
    }

    if (contrasts.length < 1) {
      errors.push("At least 1 pairwise contrast is required.");
    }

    if (contrasts.length > MAX_MULTI_GROUP_CONTRASTS) {
      errors.push(`No more than ${MAX_MULTI_GROUP_CONTRASTS} contrasts can be run at once.`);
    }

    if (bioProjects.length > 1) {
      warnings.push("Caution: Samples from different BioProjects may contain strong batch effects. Whenever possible, compare groups within the same BioProject.");
    }

    if (this.engine === "javascript") {
      warnings.push("Ultrafast pairwise Z-test does not run a global/omnibus test.");
    } else {
      if (allSamples.length > 30 && (plots.pca || plots.sampleCorrelation || plots.sampleDistance)) {
        warnings.push("More than 30 samples selected. PCA and heatmaps may be slow in the browser.");
      }
      if (allSamples.length > 50 && (plots.sampleCorrelation || plots.sampleDistance)) {
        warnings.push("More than 50 samples selected. Sample heatmaps may be memory intensive.");
      }
      if (allSamples.length > 100 && (plots.sampleCorrelation || plots.sampleDistance)) {
        warnings.push("More than 100 samples selected. Heatmap generation may be slow and memory intensive.");
      }
      if (parameters.sfType === "ratio") {
        warnings.push("For sparse multi-group GExA matrices, poscounts is usually safer than ratio size-factor estimation.");
      }
    }

    return {
      ready: errors.length === 0,
      errors,
      warnings,
      groups,
      contrasts,
      runGlobal: this.engine === "javascript" ? false : this.runGlobal,
      totalSamples: allSamples.length,
      bioProjects
    };
  }

  emitChange() {
    this.onChange?.();
  }
}
