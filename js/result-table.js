import {
  APP_CONFIG,
  RESULT_COLUMN_LABELS,
  RESULT_COLUMNS
} from "./config.js";
import {
  escapeHtml,
  parseNumber
} from "./utils.js";

function numericSortValue(value) {
  const number = parseNumber(value);
  return number == null ? Number.POSITIVE_INFINITY : number;
}

function displayValue(value) {
  if (value == null || value === "" || Number.isNaN(value)) {
    return "NA";
  }

  const number = Number(value);
  if (Number.isFinite(number) && String(value).match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i)) {
    if (Math.abs(number) >= 10000 || (Math.abs(number) > 0 && Math.abs(number) < 0.001)) {
      return number.toExponential(3);
    }
    return Number.isInteger(number) ? String(number) : number.toPrecision(5);
  }

  return String(value);
}

function columnLabel(column) {
  return RESULT_COLUMN_LABELS[column] || column;
}

export class ResultTable {
  constructor(root) {
    this.root = root;
    this.rows = [];
    this.columns = RESULT_COLUMNS.slice();
    this.visibleColumns = new Set(this.columns);
    this.page = 0;
    this.sortColumn = "padj";
    this.sortDirection = "asc";
    this.filters = {
      gene: "",
      homolog: "",
      direction: "",
      padjMax: "",
      log2fcMin: "",
      baseMeanMin: ""
    };
    this.renderShell();
  }

  renderShell() {
    this.root.replaceChildren();

    const controls = document.createElement("div");
    controls.className = "result-controls";

    const geneSearch = document.createElement("input");
    geneSearch.type = "search";
    geneSearch.placeholder = "Search Gene ID";
    geneSearch.addEventListener("input", () => {
      this.filters.gene = geneSearch.value.trim().toLowerCase();
      this.page = 0;
      this.renderTable();
    });

    const homologSearch = document.createElement("input");
    homologSearch.type = "search";
    homologSearch.placeholder = "Search homolog";
    homologSearch.addEventListener("input", () => {
      this.filters.homolog = homologSearch.value.trim().toLowerCase();
      this.page = 0;
      this.renderTable();
    });

    const direction = document.createElement("select");
    for (const value of ["", "Up", "Down", "Not significant", "Filtered / NA"]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value || "All directions";
      direction.append(opt);
    }
    direction.addEventListener("change", () => {
      this.filters.direction = direction.value;
      this.page = 0;
      this.renderTable();
    });

    const padjMax = this.numberInput("padj <= ", "0.05", (value) => {
      this.filters.padjMax = value;
    });
    const log2fcMin = this.numberInput("|log2 fold change| >= ", "1", (value) => {
      this.filters.log2fcMin = value;
    });
    const baseMeanMin = this.numberInput("baseMean >= ", "10", (value) => {
      this.filters.baseMeanMin = value;
    });

    controls.append(geneSearch, homologSearch, direction, padjMax, log2fcMin, baseMeanMin);

    const columnDetails = document.createElement("details");
    columnDetails.className = "column-picker";
    const summary = document.createElement("summary");
    summary.textContent = "Display columns";
    const picker = document.createElement("div");
    picker.dataset.role = "column-picker";
    columnDetails.append(summary, picker);

    const tableWrap = document.createElement("div");
    tableWrap.className = "result-table-wrap";
    this.table = document.createElement("table");
    this.table.className = "result-table";
    tableWrap.append(this.table);

    this.status = document.createElement("div");
    this.status.className = "result-status";
    this.pager = document.createElement("div");
    this.pager.className = "table-pager";

    this.root.append(controls, columnDetails, this.status, tableWrap, this.pager);
    this.columnPicker = picker;
  }

  numberInput(labelText, placeholder, onChange) {
    const label = document.createElement("label");
    label.className = "numeric-filter";
    const span = document.createElement("span");
    span.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.placeholder = placeholder;
    input.addEventListener("input", () => {
      onChange(input.value);
      this.page = 0;
      this.renderTable();
    });
    label.append(span, input);
    return label;
  }

  setRows(rows) {
    this.rows = rows;
    const dynamicColumns = new Set(RESULT_COLUMNS);

    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key.startsWith("TPM:")) {
          dynamicColumns.add(key);
        }
      }
    }

    this.columns = [...dynamicColumns].filter((column) =>
      rows.some((row) => Object.prototype.hasOwnProperty.call(row, column))
    );
    this.visibleColumns = new Set(this.columns);
    this.page = 0;
    this.renderColumnPicker();
    this.renderTable();
  }

  renderColumnPicker() {
    this.columnPicker.replaceChildren();

    for (const column of this.columns) {
      const label = document.createElement("label");
      label.className = "inline-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.visibleColumns.has(column);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.visibleColumns.add(column);
        } else {
          this.visibleColumns.delete(column);
        }
        this.renderTable();
      });
      label.append(checkbox, document.createTextNode(` ${columnLabel(column)}`));
      this.columnPicker.append(label);
    }
  }

  filteredRows() {
    return this.rows.filter((row) => {
      if (this.filters.gene && !String(row.gene_id || "").toLowerCase().includes(this.filters.gene)) {
        return false;
      }

      const homologText = [
        row.arabidopsis_homolog,
        row.rice_homolog
      ].join(" ").toLowerCase();

      if (this.filters.homolog && !homologText.includes(this.filters.homolog)) {
        return false;
      }

      if (this.filters.direction && row.direction !== this.filters.direction) {
        return false;
      }

      if (this.filters.padjMax !== "") {
        const padj = parseNumber(row.padj);
        if (padj == null || padj > Number(this.filters.padjMax)) {
          return false;
        }
      }

      if (this.filters.log2fcMin !== "") {
        const log2fc = parseNumber(row.log2FoldChange);
        if (log2fc == null || Math.abs(log2fc) < Number(this.filters.log2fcMin)) {
          return false;
        }
      }

      if (this.filters.baseMeanMin !== "") {
        const baseMean = parseNumber(row.baseMean);
        if (baseMean == null || baseMean < Number(this.filters.baseMeanMin)) {
          return false;
        }
      }

      return true;
    });
  }

  sortedRows(rows) {
    const column = this.sortColumn;
    const direction = this.sortDirection === "asc" ? 1 : -1;

    return rows.slice().sort((a, b) => {
      if (["baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj"].includes(column)) {
        return (numericSortValue(a[column]) - numericSortValue(b[column])) * direction;
      }

      return String(a[column] || "").localeCompare(String(b[column] || "")) * direction;
    });
  }

  renderTable() {
    const filtered = this.sortedRows(this.filteredRows());
    const pageSize = APP_CONFIG.defaultPageSize;
    const maxPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
    this.page = Math.min(this.page, maxPage);
    const start = this.page * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);
    const visibleColumns = this.columns.filter((column) => this.visibleColumns.has(column));

    this.table.replaceChildren();
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    for (const column of visibleColumns) {
      const th = document.createElement("th");
      const button = document.createElement("button");
      const label = columnLabel(column);
      button.type = "button";
      button.className = "sort-button";
      button.textContent = column === this.sortColumn
        ? `${label} (${this.sortDirection})`
        : label;
      button.addEventListener("click", () => {
        if (this.sortColumn === column) {
          this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
        } else {
          this.sortColumn = column;
          this.sortDirection = "asc";
        }
        this.renderTable();
      });
      th.append(button);
      headRow.append(th);
    }

    thead.append(headRow);
    this.table.append(thead);

    const tbody = document.createElement("tbody");

    for (const row of pageRows) {
      const tr = document.createElement("tr");
      tr.dataset.geneId = row.gene_id;

      for (const column of visibleColumns) {
        const td = document.createElement("td");

        if ((column === "gexa_link" || column === "tgif_link") && row[column]) {
          const anchor = document.createElement("a");
          anchor.href = row[column];
          anchor.textContent = column === "gexa_link" ? "GExA" : "TGIF-DB";
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          td.append(anchor);
        } else {
          td.textContent = displayValue(row[column]);
          td.title = escapeHtml(row[column]);
        }

        tr.append(td);
      }

      tbody.append(tr);
    }

    if (pageRows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = Math.max(1, visibleColumns.length);
      td.textContent = "No result rows match the current filters.";
      tr.append(td);
      tbody.append(tr);
    }

    this.table.append(tbody);
    this.renderStatus(filtered.length);
    this.renderPager(filtered.length, maxPage);
  }

  renderStatus(filteredCount) {
    this.status.textContent = `${filteredCount.toLocaleString()} of ${this.rows.length.toLocaleString()} genes shown by current filters.`;
  }

  renderPager(filteredCount, maxPage) {
    this.pager.replaceChildren();
    const pageSize = APP_CONFIG.defaultPageSize;

    const label = document.createElement("span");
    label.textContent = `Page ${this.page + 1} of ${maxPage + 1} (${Math.min(filteredCount, this.page * pageSize + 1).toLocaleString()}-${Math.min(filteredCount, (this.page + 1) * pageSize).toLocaleString()})`;

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

    this.pager.append(label, previous, next);
  }

  focusGene(geneId) {
    this.filters.gene = geneId.toLowerCase();
    const input = this.root.querySelector('input[placeholder="Search Gene ID"]');
    if (input) {
      input.value = geneId;
    }
    this.page = 0;
    this.renderTable();
    this.root.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
