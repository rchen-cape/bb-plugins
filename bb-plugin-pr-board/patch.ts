import type { Side } from "./contract.js";

type LineRange = readonly [first: number, last: number];

export interface HunkRange {
  deletions: LineRange | null;
  additions: LineRange | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function range(start: number, count: number): LineRange | null {
  return count > 0 ? [start, start + count - 1] : null;
}

export function hunkRanges(patch: string): HunkRange[] {
  return patch.split("\n").flatMap((line) => {
    const match = HUNK_HEADER.exec(line);
    if (match === null) return [];
    const [, oldStart, oldCount, newStart, newCount] = match;
    return [
      {
        deletions: range(Number(oldStart), oldCount === undefined ? 1 : Number(oldCount)),
        additions: range(Number(newStart), newCount === undefined ? 1 : Number(newCount)),
      },
    ];
  });
}

export function isCommentable(patch: string | null, side: Side, startLine: number, endLine: number): boolean {
  if (patch === null) return false;
  return hunkRanges(patch).some((hunk) => {
    const lines = hunk[side];
    return lines !== null && startLine >= lines[0] && endLine <= lines[1];
  });
}

/** The part of startLine–endLine that falls inside one hunk, picking the hunk with the most overlap, or null when none overlaps. */
export function commentableRange(
  patch: string | null,
  side: Side,
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } | null {
  if (patch === null) return null;
  let best: { startLine: number; endLine: number } | null = null;
  for (const hunk of hunkRanges(patch)) {
    const lines = hunk[side];
    if (lines === null) continue;
    const first = Math.max(startLine, lines[0]);
    const last = Math.min(endLine, lines[1]);
    if (first > last) continue;
    if (best === null || last - first > best.endLine - best.startLine) best = { startLine: first, endLine: last };
  }
  return best;
}
