import {
  type SheetWorkbookCell,
  type SheetWorkbookCellStyle,
  type SheetWorkbookColumn,
  type SheetWorkbookPayload,
  type SheetWorkbookRichTextRun,
  type SheetWorkbookRow,
  type SheetWorkbookSheet,
} from "../../shared/mirror";

const URL_PATTERN = /(https?:\/\/[^\s<]+)/g;

const HYPERLINK_COLORS = new Set([
  "#0000ff",
  "#1155cc",
  "#0563c1",
  "#0000ee",
  "#0066cc",
]);

type VisibleColumn = {
  index: number;
  letter: string;
  key: string;
  label: string;
  widthPx: number;
  stickyLeft: number | null;
};

type MergeLookups = {
  ownerByCoveredCell: Map<string, string>;
  mergeByStartCell: Map<string, { startRow: number; endRow: number; startCol: number; endCol: number }>;
};

type TableCell = {
  rowIndex: number;
  column: VisibleColumn;
  sourceCell: SheetWorkbookCell;
  address: string;
  ownerAddress: string;
  display: string;
};

type TableRow = {
  index: number;
  cells: TableCell[];
  searchText: string;
};

type NotesBlock = {
  numberCell: SheetWorkbookCell | null;
  bodyCell: SheetWorkbookCell | null;
};

type LegendBlock = {
  labelCell: SheetWorkbookCell | null;
  bodyCell: SheetWorkbookCell | null;
};

type TableGroup = {
  number: number;
  ownerAddress: string;
  rows: TableRow[];
};

type CatalogSheetModel = {
  headerRow: SheetWorkbookRow;
  visibleColumns: VisibleColumn[];
  rows: TableRow[];
  groups: TableGroup[];
  groupedColumnIndexes: Set<number>;
  numberColumnWidth: number;
  headerHtml: string;
  colgroupHtml: string;
};

type NotesSheetModel = {
  title: string;
  titleCell: SheetWorkbookCell | null;
  legendTitle: string;
  legendTitleCell: SheetWorkbookCell | null;
  notes: NotesBlock[];
  legend: LegendBlock[];
};

export type RenderSheetWorkbookGridResult = {
  html: string;
  matchCount: number;
  firstMatchAddress: string | null;
};

const catalogSheetModelCache = new WeakMap<SheetWorkbookSheet, CatalogSheetModel>();
const notesSheetModelCache = new WeakMap<SheetWorkbookSheet, NotesSheetModel>();

export function resolveSheetWorkbookSheet(
  workbook: SheetWorkbookPayload,
  slug: string | null | undefined,
): SheetWorkbookSheet {
  const normalized = String(slug ?? "").trim().toLowerCase();
  return (
    workbook.sheets.find((sheet) => sheet.slug === normalized) ??
    workbook.sheets[0] ?? {
      id: 0,
      name: "Sheet",
      slug: "sheet",
      rowCount: 0,
      columnCount: 0,
      columns: [],
      rows: [],
      merges: [],
      images: [],
    }
  );
}

export function renderSheetWorkbookStyleRules(styles: SheetWorkbookCellStyle[]) {
  return styles
    .map((style, index) => {
      const light = renderSheetWorkbookStyleDeclaration(style, false);
      const dark = renderSheetWorkbookStyleDeclaration(style, true);
      return `
        :root[data-theme="light"] .sheet-style-${index} { ${light} }
        :root:not([data-theme="light"]) .sheet-style-${index} { ${dark} }
      `;
    })
    .join("");
}

export function renderSheetWorkbookGrid(
  _workbook: SheetWorkbookPayload,
  sheet: SheetWorkbookSheet,
  searchQuery: string,
): RenderSheetWorkbookGridResult {
  if (sheet.slug === "notes") {
    return renderNotesSheet(sheet, searchQuery);
  }

  return renderCatalogLikeSheet(sheet, searchQuery);
}

function renderCatalogLikeSheet(sheet: SheetWorkbookSheet, searchQuery: string): RenderSheetWorkbookGridResult {
  const { visibleColumns, groups, groupedColumnIndexes, numberColumnWidth, headerHtml, colgroupHtml } =
    getCatalogSheetModel(sheet);
  const query = searchQuery.trim().toLowerCase();
  const filteredGroups = query
    ? groups.filter((group) => group.rows.some((row) => row.searchText.includes(query)))
    : groups;

  const rowsHtml = filteredGroups.length
    ? filteredGroups
        .map((group) =>
          group.rows
            .map((row, rowOffset) => {
              const numberCellHtml =
                rowOffset === 0
                  ? compactHtml(`
                      <td
                        class="sheet-table__cell sheet-table__cell--number"
                        rowspan="${group.rows.length}"
                        style="width:${numberColumnWidth}px; min-width:${numberColumnWidth}px; max-width:${numberColumnWidth}px;"
                      >
                        <div class="sheet-cell-body"><div class="sheet-cell-text">${group.number}</div></div>
                      </td>
                    `)
                  : "";
              const cellsHtml = row.cells
                .map((cell) => {
                  const shouldGroupCell =
                    groupedColumnIndexes.has(cell.column.index) &&
                    group.rows.length > 1 &&
                    group.rows.every(
                      (candidate) =>
                        candidate.cells.find((candidateCell) => candidateCell.column.index === cell.column.index)?.ownerAddress ===
                        cell.ownerAddress,
                    );

                  if (shouldGroupCell && rowOffset > 0) {
                    return "";
                  }

                  const classes = [
                    "sheet-table__cell",
                    `sheet-style-${cell.sourceCell.styleId}`,
                    cell.column.stickyLeft !== null ? "sheet-table__cell--frozen" : "",
                    shouldGroupCell ? "sheet-table__cell--grouped" : "",
                  ].filter(Boolean);

                  return compactHtml(`
                    <td
                      class="${classes.join(" ")}"
                      data-sheet-cell="${escapeHtml(cell.address)}"
                      style="width:${cell.column.widthPx}px; min-width:${cell.column.widthPx}px; max-width:${cell.column.widthPx}px;${cell.column.stickyLeft !== null ? ` left:${cell.column.stickyLeft}px;` : ""}"
                      ${shouldGroupCell ? `rowspan="${group.rows.length}"` : ""}
                    >
                      ${renderTableCellBody(cell)}
                    </td>
                  `);
                })
                .join("");

              return `<tr class="sheet-table__row">${numberCellHtml}${cellsHtml}</tr>`;
            })
            .join(""),
        )
        .join("")
    : `<tr><td class="sheet-table__empty" colspan="${visibleColumns.length + 1}">No rows matched that filter.</td></tr>`;

  return {
    html: compactHtml(`
      <div class="sheet-table-shell">
        <div class="sheet-table-scroll">
          <table class="sheet-table" aria-label="${escapeHtml(sheet.name)} sheet">
            <colgroup>${colgroupHtml}</colgroup>
            <thead><tr>${headerHtml}</tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `),
    matchCount: filteredGroups.reduce((sum, group) => sum + group.rows.length, 0),
    firstMatchAddress: filteredGroups[0]?.rows[0]?.cells[0]?.address ?? null,
  };
}

function renderNotesSheet(sheet: SheetWorkbookSheet, searchQuery: string): RenderSheetWorkbookGridResult {
  const query = searchQuery.trim().toLowerCase();
  const { title, titleCell, legendTitle, legendTitleCell, notes, legend } = getNotesSheetModel(sheet);

  let matchCount = 0;
  let firstMatchAddress: string | null = null;

  const matchesQuery = (cell: SheetWorkbookCell | null) => {
    if (!query || !cell) {
      return !query;
    }
    return cell.display.toLowerCase().includes(query);
  };

  const filteredNotes = query
    ? notes.filter((note) => matchesQuery(note.numberCell) || matchesQuery(note.bodyCell))
    : notes;
  const filteredLegend = query
    ? legend.filter((item) => matchesQuery(item.labelCell) || matchesQuery(item.bodyCell))
    : legend;

  const notesHtml = filteredNotes
    .map((note) => {
      matchCount += 1;
      firstMatchAddress ||= note.bodyCell?.address ?? note.numberCell?.address ?? null;

      return compactHtml(`
        <tr class="sheet-notes-table__row">
          <td class="sheet-notes-table__number${note.numberCell ? ` sheet-style-${note.numberCell.styleId}` : ""}">
            ${note.numberCell ? renderPlainCellMarkup(note.numberCell) : ""}
          </td>
          <td class="sheet-notes-table__body${note.bodyCell ? ` sheet-style-${note.bodyCell.styleId}` : ""}"${
            note.bodyCell ? ` data-sheet-cell="${escapeHtml(note.bodyCell.address)}"` : ""
          }>
            ${note.bodyCell ? renderCellBody(note.bodyCell) : ""}
          </td>
        </tr>
      `);
    })
    .join("");

  const legendHtml = filteredLegend
    .map((item) => {
      matchCount += 1;
      firstMatchAddress ||= item.bodyCell?.address ?? item.labelCell?.address ?? null;

      return compactHtml(`
        <tr class="sheet-legend-table__row">
          <td class="sheet-legend-table__label${item.labelCell ? ` sheet-style-${item.labelCell.styleId}` : ""}">
            ${item.labelCell ? renderPlainCellMarkup(item.labelCell) : ""}
          </td>
          <td class="sheet-legend-table__body${item.bodyCell ? ` sheet-style-${item.bodyCell.styleId}` : ""}"${
            item.bodyCell ? ` data-sheet-cell="${escapeHtml(item.bodyCell.address)}"` : ""
          }>
            ${item.bodyCell ? renderCellBody(item.bodyCell) : ""}
          </td>
        </tr>
      `);
    })
    .join("");

  const emptyState =
    !filteredNotes.length && !filteredLegend.length
      ? `<div class="sheet-notes__empty">No notes matched that filter.</div>`
      : "";

  return {
    html: compactHtml(`
      <div class="sheet-notes-sheet">
        <section class="sheet-notes-section">
          <table class="sheet-notes-table" aria-label="${escapeHtml(title)}">
            <colgroup>
              <col class="sheet-notes-table__number-col" />
              <col class="sheet-notes-table__body-col" />
            </colgroup>
            <thead>
              <tr>
                <th class="sheet-notes-table__title${titleCell ? ` sheet-style-${titleCell.styleId}` : ""}" colspan="2">${escapeHtml(title)}</th>
              </tr>
            </thead>
            <tbody>
              ${notesHtml}
            </tbody>
          </table>
        </section>

        <section class="sheet-notes-section">
          <table class="sheet-legend-table" aria-label="${escapeHtml(legendTitle)}">
            <colgroup>
              <col class="sheet-legend-table__label-col" />
              <col class="sheet-legend-table__body-col" />
            </colgroup>
            <thead>
              <tr>
                <th class="sheet-legend-table__title${legendTitleCell ? ` sheet-style-${legendTitleCell.styleId}` : ""}" colspan="2">${escapeHtml(legendTitle)}</th>
              </tr>
            </thead>
            <tbody>
              ${legendHtml}
            </tbody>
          </table>
        </section>
        ${emptyState}
      </div>
    `),
    matchCount,
    firstMatchAddress,
  };
}

function getCatalogSheetModel(sheet: SheetWorkbookSheet): CatalogSheetModel {
  const cached = catalogSheetModelCache.get(sheet);
  if (cached) {
    return cached;
  }

  const headerRow = findSheetHeaderRow(sheet);
  const visibleColumns = buildVisibleColumns(sheet, headerRow);
  const lookups = buildMergeLookups(sheet);
  const sourceCells = buildSourceCellMap(sheet);
  const rows = buildTableRows(sheet, headerRow, visibleColumns, lookups, sourceCells);
  const groups = buildTableGroups(rows);
  const groupedColumnIndexes = new Set(visibleColumns.slice(0, 2).map((column) => column.index));
  const numberColumnWidth = 56;
  const headerHtml = renderCatalogHeaderHtml(headerRow, visibleColumns, numberColumnWidth);
  const colgroupHtml = renderCatalogColgroupHtml(visibleColumns, numberColumnWidth);

  const model: CatalogSheetModel = {
    headerRow,
    visibleColumns,
    rows,
    groups,
    groupedColumnIndexes,
    numberColumnWidth,
    headerHtml,
    colgroupHtml,
  };
  catalogSheetModelCache.set(sheet, model);
  return model;
}

function getNotesSheetModel(sheet: SheetWorkbookSheet): NotesSheetModel {
  const cached = notesSheetModelCache.get(sheet);
  if (cached) {
    return cached;
  }

  const model = buildNotesCollections(sheet);
  notesSheetModelCache.set(sheet, model);
  return model;
}

function renderCatalogHeaderHtml(
  headerRow: SheetWorkbookRow,
  visibleColumns: VisibleColumn[],
  numberColumnWidth: number,
) {
  return [
    compactHtml(`
      <th
        class="sheet-table__head sheet-table__head--number"
        scope="col"
        style="width:${numberColumnWidth}px; min-width:${numberColumnWidth}px; max-width:${numberColumnWidth}px;"
      >
        <div class="sheet-cell-body"><div class="sheet-cell-text">#</div></div>
      </th>
    `),
    ...visibleColumns.map((column) => {
      const headerCell = headerRow.cells.find((cell) => cell.col === column.index);
      if (!headerCell) {
        return "";
      }

      return compactHtml(`
        <th
          class="sheet-table__head sheet-style-${headerCell.styleId}${column.stickyLeft !== null ? " sheet-table__head--frozen" : ""}"
          scope="col"
          style="width:${column.widthPx}px; min-width:${column.widthPx}px; max-width:${column.widthPx}px;${column.stickyLeft !== null ? ` left:${column.stickyLeft}px;` : ""}"
        >
          <div class="sheet-cell-body"><div class="sheet-cell-text">${escapeHtml(column.label)}</div></div>
        </th>
      `);
    }),
  ].join("");
}

function renderCatalogColgroupHtml(visibleColumns: VisibleColumn[], numberColumnWidth: number) {
  return [
    `<col style="width:${numberColumnWidth}px" data-sheet-column="number" />`,
    ...visibleColumns.map((column) => `<col style="width:${column.widthPx}px" data-sheet-column="${escapeHtml(column.letter)}" />`),
  ].join("");
}

function buildSourceCellMap(sheet: SheetWorkbookSheet) {
  const sourceCells = new Map<string, SheetWorkbookCell>();
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      sourceCells.set(`${row.index}:${cell.col}`, cell);
    }
  }
  return sourceCells;
}

function buildTableRows(
  sheet: SheetWorkbookSheet,
  headerRow: SheetWorkbookRow,
  visibleColumns: VisibleColumn[],
  lookups: MergeLookups,
  sourceCells: Map<string, SheetWorkbookCell>,
): TableRow[] {
  return sheet.rows
    .filter((row) => row.index > headerRow.index && !row.hidden && row.cells.some((cell) => cell.display.trim()))
    .map((row) => {
      const cells = visibleColumns.map((column) => resolveTableCell(row.index, column, sourceCells, lookups, sheet));
      const searchText = cells.map((cell) => cell.display.toLowerCase()).join(" ");
      return {
        index: row.index,
        cells,
        searchText,
      };
    });
}

function resolveTableCell(
  rowIndex: number,
  column: VisibleColumn,
  sourceCells: Map<string, SheetWorkbookCell>,
  lookups: MergeLookups,
  sheet: SheetWorkbookSheet,
): TableCell {
  const directKey = `${rowIndex}:${column.index}`;
  const directCell = sourceCells.get(directKey);
  const ownerKey = lookups.ownerByCoveredCell.get(directKey);
  const ownerCell = ownerKey ? sourceCells.get(ownerKey) : null;

  if (ownerKey && ownerCell) {
    return {
      rowIndex,
      column,
      sourceCell: ownerCell,
      address: directCell?.address ?? `${column.letter}${rowIndex}`,
      ownerAddress: ownerCell.address,
      display: ownerCell.display,
    };
  }

  if (directCell) {
    return {
      rowIndex,
      column,
      sourceCell: directCell,
      address: directCell.address,
      ownerAddress: directCell.address,
      display: directCell.display,
    };
  }

  const fallbackCell = createBlankCell(rowIndex, column, sheet);
  return {
    rowIndex,
    column,
    sourceCell: fallbackCell,
    address: fallbackCell.address,
    ownerAddress: fallbackCell.address,
    display: "",
  };
}

function buildTableGroups(rows: TableRow[]): TableGroup[] {
  const groups: TableGroup[] = [];
  for (const row of rows) {
    const titleCell = row.cells[0];
    const ownerAddress = titleCell?.ownerAddress ?? titleCell?.address ?? `${row.index}`;
    const previousGroup = groups[groups.length - 1];
    if (previousGroup && previousGroup.ownerAddress === ownerAddress) {
      previousGroup.rows.push(row);
      continue;
    }

    groups.push({
      number: groups.length + 1,
      ownerAddress,
      rows: [row],
    });
  }
  return groups;
}

function buildVisibleColumns(sheet: SheetWorkbookSheet, headerRow: SheetWorkbookRow): VisibleColumn[] {
  const columnMap = new Map(sheet.columns.map((column) => [column.index, column]));
  const headerCells = [...headerRow.cells].filter((cell) => cell.display.trim()).sort((left, right) => left.col - right.col);
  const stickyCount = Math.max(0, sheet.frozenColumns ?? 0);
  let stickyLeft = 0;

  return headerCells.map((headerCell, visibleIndex) => {
    const label = headerCell.display.trim();
    const key = normalizeKey(label);
    const sheetColumn = columnMap.get(headerCell.col) ?? makeFallbackColumn(headerCell.col);
    const widthPx = getPreferredColumnWidth(key, sheetColumn.width);
    const sticky = visibleIndex < stickyCount ? stickyLeft : null;
    if (sticky !== null) {
      stickyLeft += widthPx;
    }

    return {
      index: sheetColumn.index,
      letter: sheetColumn.letter,
      key,
      label,
      widthPx,
      stickyLeft: sticky,
    };
  });
}

function getPreferredColumnWidth(key: string, rawWidth: number | null | undefined) {
  switch (key) {
    case "title":
      return 314;
    case "alternate-title":
      return 318;
    case "best-release":
      return 252;
    case "alternate-release":
      return 252;
    case "dual-audio":
      return 108;
    case "notes":
      return 560;
    case "comparisons":
      return 280;
    case "updated":
      return 116;
    default:
      return Math.max(72, Math.min(360, toSheetColumnPixels(rawWidth)));
  }
}

function buildMergeLookups(sheet: SheetWorkbookSheet): MergeLookups {
  const ownerByCoveredCell = new Map<string, string>();
  const mergeByStartCell = new Map<string, { startRow: number; endRow: number; startCol: number; endCol: number }>();

  for (const merge of sheet.merges) {
    const startKey = `${merge.startRow}:${merge.startCol}`;
    mergeByStartCell.set(startKey, merge);

    for (let row = merge.startRow; row <= merge.endRow; row += 1) {
      for (let col = merge.startCol; col <= merge.endCol; col += 1) {
        if (row === merge.startRow && col === merge.startCol) {
          continue;
        }
        ownerByCoveredCell.set(`${row}:${col}`, startKey);
      }
    }
  }

  return {
    ownerByCoveredCell,
    mergeByStartCell,
  };
}

function buildNotesCollections(sheet: SheetWorkbookSheet) {
  const legendHeaderRow =
    sheet.rows.find((row) => normalizeCellText(getCellForColumn(row, 2)?.display) === "legend") ?? null;

  const titleCell = firstNonEmptyCell(sheet.rows.find((row) => row.index === 1) ?? null, [2, 3, 4]);
  const legendTitleCell = firstNonEmptyCell(legendHeaderRow, [2, 3, 4]);
  const title = titleCell?.display.trim() || "Notes";
  const legendTitle = legendTitleCell?.display.trim() || "Legend";

  const notes = sheet.rows
    .filter(
      (row) =>
        row.index > 1 &&
        (!legendHeaderRow || row.index < legendHeaderRow.index) &&
        !!getCellForColumn(row, 2)?.display.trim(),
    )
    .map(
      (row): NotesBlock => ({
        numberCell: getCellForColumn(row, 2),
        bodyCell: firstNonEmptyCell(row, [3, 4]),
      }),
    );

  const legend = legendHeaderRow
    ? sheet.rows
        .filter((row) => row.index > legendHeaderRow.index && !!getCellForColumn(row, 2)?.display.trim())
        .map(
          (row): LegendBlock => ({
            labelCell: getCellForColumn(row, 2),
            bodyCell: firstNonEmptyCell(row, [4, 3]),
          }),
        )
    : [];

  return {
    title,
    titleCell,
    legendTitle,
    legendTitleCell,
    notes,
    legend,
  };
}

function findSheetHeaderRow(sheet: SheetWorkbookSheet): SheetWorkbookRow {
  return (
    sheet.rows.find((row) => {
      const labels = row.cells.map((cell) => normalizeCellText(cell.display));
      return labels.includes("title") && labels.includes("best release");
    }) ??
    sheet.rows.find((row) => row.cells.filter((cell) => cell.display.trim()).length >= Math.min(4, sheet.columnCount)) ??
    sheet.rows[0] ?? {
      index: 1,
      cells: [],
    }
  );
}

function renderTableCellBody(cell: TableCell) {
  if (cell.column.key === "dual-audio") {
    return renderDualAudioCell(cell);
  }
  if (cell.column.key === "comparisons") {
    return renderComparisonCell(cell);
  }
  if (cell.column.key === "updated") {
    return renderUpdatedCell(cell);
  }
  return renderCellBody(cell.sourceCell);
}

function renderDualAudioCell(cell: TableCell) {
  const values = cell.display
    .split(/[|/]/g)
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    return `<div class="sheet-cell-body"><span class="sheet-cell-muted">-</span></div>`;
  }

  return `<div class="sheet-cell-body"><div class="sheet-cell-text">${values.map((value) => escapeHtml(value)).join(" / ")}</div></div>`;
}

function renderComparisonCell(cell: TableCell) {
  const urls = extractUrls(cell.display);
  if (urls.length === 0) {
    return `<div class="sheet-cell-body"><span class="sheet-cell-muted">-</span></div>`;
  }

  return compactHtml(`
    <div class="sheet-cell-body">
      <div class="sheet-links">
        ${urls
          .map(
            (url) =>
              `<a class="sheet-links__item" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`,
          )
          .join("")}
      </div>
    </div>
  `);
}

function renderUpdatedCell(cell: TableCell) {
  if (!cell.display.trim()) {
    return `<div class="sheet-cell-body"><span class="sheet-cell-muted">-</span></div>`;
  }
  return renderCellBody(cell.sourceCell);
}

function renderCellBody(cell: SheetWorkbookCell) {
  const html = renderCellText(cell);
  if (!html) {
    return `<div class="sheet-cell-body"><span class="sheet-cell-muted">-</span></div>`;
  }

  return `<div class="sheet-cell-body" data-sheet-cell="${escapeHtml(cell.address)}"><div class="sheet-cell-text">${html}</div></div>`;
}

function renderPlainCellMarkup(cell: SheetWorkbookCell) {
  const html = renderCellText(cell);
  if (!html) {
    return `<span class="sheet-cell-muted">-</span>`;
  }
  return `<div class="sheet-cell-text" data-sheet-cell="${escapeHtml(cell.address)}">${html}</div>`;
}

function renderCellText(cell: SheetWorkbookCell) {
  const richTextHtml = cell.richText ? renderRichText(cell.richText, cell.hyperlink ?? null) : "";
  return richTextHtml || renderPlainText(cell.display, cell.hyperlink ?? null);
}

function renderRichText(richText: SheetWorkbookRichTextRun[], hyperlink: string | null) {
  const fullText = richText.map((run) => run.text).join("");
  const hasRunLevelHyperlinks = richText.some((run) => Boolean(run.hyperlink));
  const rendered = richText
    .map((run) => {
      const style = renderInlineRichTextStyle(run);
      if (run.hyperlink) {
        return `<a class="sheet-link" href="${escapeHtml(run.hyperlink)}" target="_blank" rel="noreferrer"${style ? ` style="${style}"` : ""}>${escapeHtml(run.text).replace(/\n/g, "<br />")}</a>`;
      }

      const linked = renderAutoLinkedText(run.text, style);
      return linked || `<span${style ? ` style="${style}"` : ""}>${escapeHtml(run.text).replace(/\n/g, "<br />")}</span>`;
    })
    .join("");

  if (hyperlink && !hasRunLevelHyperlinks && !URL_PATTERN.test(fullText)) {
    URL_PATTERN.lastIndex = 0;
    return `<a class="sheet-link" href="${escapeHtml(hyperlink)}" target="_blank" rel="noreferrer">${rendered}</a>`;
  }

  URL_PATTERN.lastIndex = 0;
  return rendered;
}

function renderPlainText(text: string, hyperlink: string | null) {
  if (!text) {
    return "";
  }

  const linked = renderAutoLinkedText(text, "");
  if (linked) {
    return linked;
  }

  if (hyperlink) {
    return `<a class="sheet-link" href="${escapeHtml(hyperlink)}" target="_blank" rel="noreferrer">${escapeHtml(text).replace(/\n/g, "<br />")}</a>`;
  }

  return escapeHtml(text).replace(/\n/g, "<br />");
}

function renderAutoLinkedText(text: string, inlineStyle: string) {
  if (!URL_PATTERN.test(text)) {
    URL_PATTERN.lastIndex = 0;
    return "";
  }

  URL_PATTERN.lastIndex = 0;
  let html = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = URL_PATTERN.exec(text))) {
    const [url] = match;
    const before = text.slice(lastIndex, match.index);
    if (before) {
      html += `<span${inlineStyle ? ` style="${inlineStyle}"` : ""}>${escapeHtml(before).replace(/\n/g, "<br />")}</span>`;
    }
    html += `<a class="sheet-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"${inlineStyle ? ` style="${inlineStyle}"` : ""}>${escapeHtml(url)}</a>`;
    lastIndex = match.index + url.length;
  }

  const trailing = text.slice(lastIndex);
  if (trailing) {
    html += `<span${inlineStyle ? ` style="${inlineStyle}"` : ""}>${escapeHtml(trailing).replace(/\n/g, "<br />")}</span>`;
  }

  URL_PATTERN.lastIndex = 0;
  return html;
}

function renderInlineRichTextStyle(run: SheetWorkbookRichTextRun) {
  const declarations = [];
  if (run.bold) {
    declarations.push("font-weight:700");
  }
  if (run.italic) {
    declarations.push("font-style:italic");
  }

  const isLinkColor = run.color && HYPERLINK_COLORS.has(run.color.toLowerCase());

  if (run.underline || run.strike) {
    const lines = [];
    if (run.underline && !isLinkColor) {
      lines.push("underline");
    }
    if (run.strike) {
      lines.push("line-through");
    }
    if (lines.length > 0) {
      declarations.push(`text-decoration-line:${lines.join(" ")}`);
    }
  }
  if (run.color && !isLinkColor) {
    declarations.push(`color:${run.color}`);
  }
  if (run.fontName) {
    declarations.push(`font-family:${renderSheetFontFamily(run.fontName)}`);
  }
  if (run.fontSize) {
    declarations.push(`font-size:${run.fontSize}pt`);
  }
  return declarations.join(";");
}

function renderSheetWorkbookStyleDeclaration(style: SheetWorkbookCellStyle, isDark: boolean) {
  const declarations = [];
  if (style.fontName) {
    declarations.push(`font-family:${renderSheetFontFamily(style.fontName)}`);
  }
  if (style.fontSize) {
    declarations.push(`font-size:${style.fontSize}pt`);
  }
  if (style.fontWeight) {
    declarations.push(`font-weight:${style.fontWeight}`);
  }
  if (style.italic) {
    declarations.push("font-style:italic");
  }

  const isLinkColor = style.textColor && HYPERLINK_COLORS.has(style.textColor.toLowerCase());

  if (style.underline || style.strike) {
    const lines = [];
    if (style.underline && !isLinkColor) {
      lines.push("underline");
    }
    if (style.strike) {
      lines.push("line-through");
    }
    if (lines.length > 0) {
      declarations.push(`text-decoration-line:${lines.join(" ")}`);
    }
  }

  const hasBg = style.backgroundColor && style.backgroundColor.toLowerCase() !== "#ffffff";
  const isWhiteBg = style.backgroundColor && style.backgroundColor.toLowerCase() === "#ffffff";

  if (isDark) {
    // In dark mode: keep colored backgrounds, use white text for readability
    if (hasBg) {
      declarations.push(`background:${style.backgroundColor} !important`);
      // White text + dark outline for readability on colored backgrounds
      declarations.push(`color:#ffffff !important`);
      declarations.push(`text-shadow:0 0 2px rgba(0,0,0,0.8), 0 1px 3px rgba(0,0,0,0.6)`);
    } else if (isWhiteBg) {
      // White bg -> transparent in dark mode
      declarations.push(`background:transparent !important`);
      declarations.push(`color:var(--sheet-text) !important`);
    } else {
      // No bg set
      if (style.textColor && !isLinkColor && style.textColor.toLowerCase() !== "#000000") {
        declarations.push(`color:${style.textColor} !important`);
      } else if (style.textColor) {
        declarations.push(`color:var(--sheet-text) !important`);
      }
    }
  } else {
    // Light mode: render as-is
    if (style.textColor && !isLinkColor) {
      declarations.push(`color:${style.textColor} !important`);
    }
    if (style.backgroundColor) {
      declarations.push(`background:${style.backgroundColor} !important`);
    }
  }

  if (style.horizontalAlign) {
    declarations.push(`text-align:${style.horizontalAlign}`);
  }
  if (style.verticalAlign) {
    declarations.push(`vertical-align:${style.verticalAlign}`);
  }
  if (style.wrap) {
    declarations.push("white-space:pre-wrap");
  }
  // Do NOT render individual cell borders from spreadsheet data.
  // The table already has uniform 1px teal borders on every th/td.
  // Rendering the spreadsheet's "thick" 3px borders causes massive vertical bloat.
  return declarations.join(";");
}

function createBlankCell(rowIndex: number, column: VisibleColumn, sheet: SheetWorkbookSheet): SheetWorkbookCell {
  return {
    col: column.index,
    address: `${column.letter}${rowIndex}`,
    display: "",
    styleId: inferBlankStyleId(sheet),
  };
}

function inferBlankStyleId(sheet: SheetWorkbookSheet) {
  return sheet.rows[0]?.cells[0]?.styleId ?? 0;
}

function getCellForColumn(row: SheetWorkbookRow | null, columnIndex: number) {
  return row?.cells.find((cell) => cell.col === columnIndex) ?? null;
}

function firstNonEmptyCell(row: SheetWorkbookRow | null, columns: number[]) {
  for (const column of columns) {
    const cell = getCellForColumn(row, column);
    if (cell?.display.trim()) {
      return cell;
    }
  }
  return null;
}

function makeFallbackColumn(index: number): SheetWorkbookColumn {
  return {
    index,
    letter: toSheetColumnLetter(index),
    width: null,
  };
}

function toSheetColumnLetter(index: number) {
  let current = index;
  let result = "";
  while (current > 0) {
    const offset = (current - 1) % 26;
    result = String.fromCharCode(65 + offset) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result || "A";
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeCellText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function extractUrls(value: string) {
  const matches = value.match(URL_PATTERN);
  return matches ? [...new Set(matches)] : [];
}

function renderSheetFontFamily(name: string) {
  if (name === "Roboto") {
    return `"Roboto","Helvetica Neue",Arial,sans-serif`;
  }
  if (name === "Lexend Deca") {
    return `"Lexend Deca","Roboto","Helvetica Neue",Arial,sans-serif`;
  }
  if (name === "Arial") {
    return `Arial,"Helvetica Neue",sans-serif`;
  }
  return `"${name.replace(/"/g, "")}","Roboto","Helvetica Neue",Arial,sans-serif`;
}

function toSheetColumnPixels(width: number | null | undefined) {
  const source = typeof width === "number" && Number.isFinite(width) ? width : 12.63;
  return Math.max(44, Math.round(source * 7 + 5));
}

function compactHtml(value: string) {
  return value.replace(/>\s+</g, "><").trim();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
