export type TableAlign = "left" | "center" | "right" | null;

export interface TableCell {
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

export interface TableModel {
  readonly header: readonly TableCell[];
  readonly align: readonly TableAlign[];
  readonly rows: readonly (readonly TableCell[])[];
}

export function splitTableRow(line: string, offset = 0): TableCell[] {
  const cells: TableCell[] = [];
  let start = 0;
  let escaped = false;
  const bounds: number[] = [];
  for (let index = 0; index < line.length; index++) {
    const code = line.charCodeAt(index);
    if (code === 124 && !escaped) bounds.push(index);
    escaped = !escaped && code === 92;
  }
  const trimmedStart = line.length - line.trimStart().length;
  const trimmedEnd = line.trimEnd().length;
  const pipes = bounds.filter(
    (index) => index >= trimmedStart && index < trimmedEnd,
  );
  const leading = pipes[0] === trimmedStart;
  const trailing =
    pipes.length > 0 &&
    pipes[pipes.length - 1] === trimmedEnd - 1 &&
    !(leading && pipes.length === 1);
  const separators = pipes.slice(leading ? 1 : 0, trailing ? -1 : undefined);
  start = leading ? trimmedStart + 1 : trimmedStart;
  const end = trailing ? trimmedEnd - 1 : trimmedEnd;
  for (const separator of [...separators, end]) {
    const raw = line.slice(start, separator);
    const left = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const from = offset + start + left;
    cells.push({ text, from, to: from + text.length });
    start = separator + 1;
  }
  return cells;
}

export function parseAlignment(line: string): TableAlign[] {
  return splitTableRow(line).map((cell) => {
    const left = cell.text.startsWith(":");
    const right = cell.text.endsWith(":") && cell.text.length > 1;
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

const CODE_SPAN = /(`+)(.+?)\1/g;
const CODE_SLOT = /\u0000(\d+)\u0000/g;

const INLINE_RULES: readonly (readonly [RegExp, string])[] = [
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\*\*(.+?)\*\*/g, "$1"],
  [/__(.+?)__/g, "$1"],
  [/==(.+?)==/g, "$1"],
  [/~~(.+?)~~/g, "$1"],
  [/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1$2"],
  [/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1$2"],
  [/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"],
];

export function stripInlineMarkdown(text: string): string {
  const code: string[] = [];
  let result = text.replace(
    CODE_SPAN,
    (_match, _ticks: string, body: string) => {
      code.push(/^ .*\S.* $/.test(body) ? body.slice(1, -1) : body);
      return `\u0000${code.length - 1}\u0000`;
    },
  );
  for (const [pattern, replacement] of INLINE_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(
    CODE_SLOT,
    (_match, index: string) => code[Number(index)] ?? "",
  );
}

export function parseTable(
  lines: readonly string[],
  lineOffsets: readonly number[],
): TableModel | null {
  const headerLine = lines[0];
  const delimiterLine = lines[1];
  if (headerLine === undefined || delimiterLine === undefined) return null;
  const header = splitTableRow(headerLine, lineOffsets[0] ?? 0);
  const align = parseAlignment(delimiterLine);
  const width = header.length;
  const rows = lines.slice(2).map((line, index) => {
    const cells = splitTableRow(line, lineOffsets[index + 2] ?? 0);
    const end =
      cells[cells.length - 1]?.to ??
      (lineOffsets[index + 2] ?? 0) + line.length;
    const padded = cells.slice(0, width);
    while (padded.length < width) padded.push({ text: "", from: end, to: end });
    return padded;
  });
  return {
    header,
    align: Array.from({ length: width }, (_, index) => align[index] ?? null),
    rows,
  };
}

export function sameTable(a: TableModel, b: TableModel): boolean {
  const sameCells = (
    x: readonly TableCell[],
    y: readonly TableCell[],
  ): boolean =>
    x.length === y.length &&
    x.every((cell, index) => {
      const other = y[index];
      return (
        other !== undefined &&
        other.text === cell.text &&
        other.from === cell.from &&
        other.to === cell.to
      );
    });
  return (
    sameCells(a.header, b.header) &&
    a.align.length === b.align.length &&
    a.align.every((value, index) => b.align[index] === value) &&
    a.rows.length === b.rows.length &&
    a.rows.every((row, index) => {
      const other = b.rows[index];
      return other !== undefined && sameCells(row, other);
    })
  );
}
