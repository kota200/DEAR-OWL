import {
  countBy,
  unique
} from "./utils.js";
import {
  COLUMN_LABELS,
  SAMPLE_COLUMNS
} from "./config.js";

const PAGE_SIZE = 80;

function sampleId(row) {
  return row.sample_id || row.SRA || row.sample || row.id;
}

function columnValue(row, column) {
  return row[column] == null || row[column] === "" ? "NA" : String(row[column]);
}

function option(label, value = label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

export class SampleSelector {
  constructor({
    root,
    title,
    role,
    onChange,
    getBlockedIds = () => new Set()
  }) {
    this.root = root;
    this.title = title;
    this.role = role;
    this.onChange = onChange;
    this.getBlockedIds = getBlockedIds;
    this.rows = [];
    this.columns = [];
    this.selected = new Set();
    this.filters = {
      search: "",
      BioProject: "",
      tissue: "",
      treatment: "",
      cultivar: "",
      selectedOnly: false
    };
    this.page = 0;
    this.renderShell();
  }

  renderShell() {
    this.root.replaceChildren();

    const heading = document.createElement("div");
    heading.className = `selector-heading selector-heading-${this.role}`;
    heading.innerHTML = `
      <div>
        <h3>${this.title}</h3>
        <p>At least 2 samples are required. Three or more biological replicates are recommended.</p>
      </div>
      <div class="selector-count" data-role="count">0 selected</div>
    `;

    const controls = document.createElement("div");
    controls.className = "sample-controls";

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search sample metadata";
    search.addEventListener("input", () => {
      this.filters.search = search.value.trim().toLowerCase();
      this.page = 0;
      this.renderTable();
    });

    controls.append(search);

    for (const column of ["BioProject", "tissue", "treatment", "cultivar"]) {
      const select = document.createElement("select");
      select.dataset.filterColumn = column;
      select.append(option(`All ${COLUMN_LABELS[column] || column}`, ""));
      select.addEventListener("change", () => {
        this.filters[column] = select.value;
        this.page = 0;
        this.renderTable();
      });
      controls.append(select);
    }

    const selectedOnlyLabel = document.createElement("label");
    selectedOnlyLabel.className = "inline-check";
    const selectedOnly = document.createElement("input");
    selectedOnly.type = "checkbox";
    selectedOnly.addEventListener("change", () => {
      this.filters.selectedOnly = selectedOnly.checked;
      this.page = 0;
      this.renderTable();
    });
    selectedOnlyLabel.append(selectedOnly, document.createTextNode(" Selected only"));
    controls.append(selectedOnlyLabel);

    const actions = document.createElement("div");
    actions.className = "sample-actions";

    const selectVisible = document.createElement("button");
    selectVisible.type = "button";
    selectVisible.textContent = "Select all visible";
    selectVisible.addEventListener("click", () => {
      const blocked = this.getBlockedIds();
      for (const row of this.filteredRows()) {
        const id = sampleId(row);
        if (!blocked.has(id)) {
          this.selected.add(id);
        }
      }
      this.emitChange();
    });

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear selection";
    clear.addEventListener("click", () => {
      this.selected.clear();
      this.emitChange();
    });

    actions.append(selectVisible, clear);

    const summary = document.createElement("div");
    summary.className = "selection-summary";
    summary.dataset.role = "summary";

    const tableWrap = document.createElement("div");
    tableWrap.className = "sample-table-wrap";
    const table = document.createElement("table");
    table.className = "sample-table";
    tableWrap.append(table);

    const pager = document.createElement("div");
    pager.className = "table-pager";
    pager.dataset.role = "pager";

    this.root.append(heading, controls, actions, summary, tableWrap, pager);
    this.table = table;
    this.countEl = heading.querySelector("[data-role='count']");
    this.summaryEl = summary;
    this.pagerEl = pager;
  }

  setRows(rows) {
    this.rows = rows.map((row) => ({
      ...row,
      sample_id: sampleId(row)
    }));
    this.selected.clear();
    this.page = 0;
    this.columns = SAMPLE_COLUMNS.filter((column) =>
      this.rows.some((row) => row[column] != null && row[column] !== "")
    );

    if (!this.columns.includes("sample_id")) {
      this.columns.unshift("sample_id");
    }

    this.updateFilterOptions();
    this.renderTable();
  }

  updateFilterOptions() {
    for (const column of ["BioProject", "tissue", "treatment", "cultivar"]) {
      const select = this.root.querySelector(`select[data-filter-column="${column}"]`);
      const current = select.value;
      select.replaceChildren(option(`All ${COLUMN_LABELS[column] || column}`, ""));

      for (const value of unique(this.rows.map((row) => row[column])).sort()) {
        select.append(option(value));
      }

      select.value = unique(this.rows.map((row) => row[column])).includes(current) ? current : "";
      select.disabled = !this.columns.includes(column);
    }
  }

  filteredRows() {
    const blocked = this.getBlockedIds();
    return this.rows.filter((row) => {
      const id = sampleId(row);

      if (this.filters.selectedOnly && !this.selected.has(id)) {
        return false;
      }

      for (const column of ["BioProject", "tissue", "treatment", "cultivar"]) {
        if (this.filters[column] && row[column] !== this.filters[column]) {
          return false;
        }
      }

      if (this.filters.search) {
        const haystack = Object.values(row).join(" ").toLowerCase();
        if (!haystack.includes(this.filters.search)) {
          return false;
        }
      }

      return !blocked.has(id) || this.selected.has(id);
    });
  }

  renderTable() {
    const filtered = this.filteredRows();
    const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
    this.page = Math.min(this.page, maxPage);
    const start = this.page * PAGE_SIZE;
    const pageRows = filtered.slice(start, start + PAGE_SIZE);
    const blocked = this.getBlockedIds();

    this.table.replaceChildren();

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const selectHead = document.createElement("th");
    selectHead.textContent = "Select";
    headRow.append(selectHead);

    for (const column of this.columns) {
      const th = document.createElement("th");
      th.textContent = COLUMN_LABELS[column] || column;
      headRow.append(th);
    }

    thead.append(headRow);
    this.table.append(thead);

    const tbody = document.createElement("tbody");

    for (const row of pageRows) {
      const id = sampleId(row);
      const tr = document.createElement("tr");
      const selectCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selected.has(id);
      checkbox.disabled = blocked.has(id) && !this.selected.has(id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selected.add(id);
        } else {
          this.selected.delete(id);
        }
        this.emitChange();
      });
      selectCell.append(checkbox);
      tr.append(selectCell);

      for (const column of this.columns) {
        const td = document.createElement("td");
        td.textContent = columnValue(row, column);
        tr.append(td);
      }

      tbody.append(tr);
    }

    if (pageRows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = this.columns.length + 1;
      td.textContent = "No samples match the current filters.";
      tr.append(td);
      tbody.append(tr);
    }

    this.table.append(tbody);
    this.renderSummary(filtered.length);
    this.renderPager(filtered.length, maxPage);
  }

  renderSummary(filteredCount) {
    const selectedRows = this.getSelected();
    this.countEl.textContent = `${selectedRows.length} selected`;

    if (selectedRows.length === 0) {
      this.summaryEl.textContent = `${filteredCount.toLocaleString()} samples visible.`;
      return;
    }

    const parts = [
      `BioProject: ${countBy(selectedRows.map((row) => row.BioProject))}`,
      `Tissue: ${countBy(selectedRows.map((row) => row.tissue))}`,
      `Treatment: ${countBy(selectedRows.map((row) => row.treatment))}`
    ];

    this.summaryEl.textContent = parts.join(" | ");
  }

  renderPager(filteredCount, maxPage) {
    this.pagerEl.replaceChildren();

    const label = document.createElement("span");
    label.textContent = `Showing ${Math.min(filteredCount, this.page * PAGE_SIZE + 1).toLocaleString()}-${Math.min(filteredCount, (this.page + 1) * PAGE_SIZE).toLocaleString()} of ${filteredCount.toLocaleString()}`;

    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "Previous";
    previous.disabled = this.page === 0;
    previous.addEventListener("click", () => {
      this.page -= 1;
      this.renderTable();
    });

    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next";
    next.disabled = this.page >= maxPage;
    next.addEventListener("click", () => {
      this.page += 1;
      this.renderTable();
    });

    this.pagerEl.append(label, previous, next);
  }

  emitChange() {
    this.renderTable();
    this.onChange?.(this.getSelected());
  }

  refreshBlockedState() {
    this.renderTable();
  }

  getSelected() {
    return this.rows.filter((row) => this.selected.has(sampleId(row)));
  }

  getSelectedIds() {
    return new Set(this.getSelected().map((row) => sampleId(row)));
  }
}
