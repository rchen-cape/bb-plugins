export const CHUNK_LINES = 40;

export interface FileChunk {
  lines: string[];
  text: string;
  headingPath: string[];
  startLine: number;
}

interface SourceLine {
  text: string;
  index: number;
}

interface Fence {
  marker: string;
  size: number;
}

const OPEN_FENCE = /^\s*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

function fenceOpen(text: string): Fence | null {
  const match = OPEN_FENCE.exec(text);
  const run = match?.[1];
  if (run === undefined) return null;
  const marker = run.charAt(0);
  if (marker === "`" && text.slice((match?.index ?? 0) + (match?.[0].length ?? 0)).includes("`")) return null;
  return { marker, size: run.length };
}

function closesFence(text: string, fence: Fence): boolean {
  const trimmed = text.trim();
  if (trimmed.length < fence.size) return false;
  for (const char of trimmed) if (char !== fence.marker) return false;
  return true;
}

function headingText(text: string): { level: number; text: string } | null {
  const match = ATX.exec(text);
  const hashes = match?.[1];
  if (match === null || hashes === undefined) return null;
  let label = text.slice(match[0].length).trim();
  let end = label.length;
  while (end > 0 && label.charAt(end - 1) === "#") end -= 1;
  if (end < label.length && (end === 0 || label.charAt(end - 1) === " " || label.charAt(end - 1) === "\t")) label = label.slice(0, end).trim();
  return label === "" ? null : { level: hashes.length, text: label };
}

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.replace(/^﻿/, "").trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === "---" || line === "...") return index + 1;
  }
  return 0;
}

function isBlank(text: string): boolean {
  return text.trim() === "";
}

function trimBlankEdges(lines: readonly SourceLine[]): SourceLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlank(lines[start]?.text ?? "")) start += 1;
  while (end > start && isBlank(lines[end - 1]?.text ?? "")) end -= 1;
  return lines.slice(start, end);
}

function cutPoints(lines: readonly SourceLine[]): number[] {
  const cuts = [0];
  let fence: Fence | null = null;
  lines.forEach((line, position) => {
    if (fence !== null) {
      if (closesFence(line.text, fence)) fence = null;
      return;
    }
    if (position > 0 && !isBlank(line.text) && !/^\s/.test(line.text)) {
      const previous = lines[position - 1]?.text ?? "";
      if (isBlank(previous) || LIST_ITEM.test(line.text)) cuts.push(position);
    }
    fence = fenceOpen(line.text);
  });
  return [...new Set(cuts)];
}

function pack(lines: readonly SourceLine[], maxLines: number): SourceLine[][] {
  const cuts = cutPoints(lines);
  const segments = cuts.map((start, index) => lines.slice(start, cuts[index + 1] ?? lines.length));
  const chunks: SourceLine[][] = [];
  let current: SourceLine[] = [];
  for (const segment of segments) {
    if (current.length > 0 && current.length + segment.length > maxLines) {
      chunks.push(current);
      current = [];
    }
    current = [...current, ...segment];
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map(trimBlankEdges).filter((chunk) => chunk.length > 0);
}

function toChunk(lines: readonly SourceLine[], headingPath: readonly string[]): FileChunk {
  const texts = lines.map((line) => line.text.trimEnd());
  return { lines: texts, text: texts.join("\n"), headingPath: [...headingPath], startLine: lines[0]?.index ?? 0 };
}

export function chunkMarkdownFile(content: string, maxLines: number = CHUNK_LINES): FileChunk[] {
  const all = content.replace(/\r\n?/g, "\n").split("\n");
  const start = frontmatterEnd(all);
  const chunks: FileChunk[] = [];
  const trail: Array<{ level: number; text: string }> = [];
  let section: SourceLine[] = [];
  let fence: Fence | null = null;

  const flush = () => {
    const body = trimBlankEdges(section);
    section = [];
    if (body.length === 0) return;
    const path = trail.map((entry) => entry.text);
    for (const part of body.length <= maxLines ? [body] : pack(body, maxLines)) chunks.push(toChunk(part, path));
  };

  for (let index = start; index < all.length; index += 1) {
    const text = all[index] ?? "";
    if (fence !== null) {
      if (closesFence(text, fence)) fence = null;
      section.push({ text, index });
      continue;
    }
    const heading = headingText(text);
    if (heading !== null) {
      flush();
      while ((trail.at(-1)?.level ?? 0) >= heading.level) trail.pop();
      trail.push(heading);
      continue;
    }
    fence = fenceOpen(text);
    section.push({ text, index });
  }
  flush();
  return chunks;
}

export function coveredLines(content: string, chunks: readonly FileChunk[]): { missing: number[]; duplicated: number[] } {
  const all = content.replace(/\r\n?/g, "\n").split("\n");
  const start = frontmatterEnd(all);
  const seen = new Map<number, number>();
  for (const chunk of chunks) {
    chunk.lines.forEach((_, offset) => seen.set(chunk.startLine + offset, (seen.get(chunk.startLine + offset) ?? 0) + 1));
  }
  const missing: number[] = [];
  let fence: Fence | null = null;
  for (let index = start; index < all.length; index += 1) {
    const text = all[index] ?? "";
    const inFence = fence !== null;
    if (fence !== null) {
      if (closesFence(text, fence)) fence = null;
    } else {
      fence = fenceOpen(text);
    }
    const isHeading = !inFence && headingText(text) !== null;
    if (!isBlank(text) && !isHeading && !seen.has(index)) missing.push(index);
  }
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([line]) => line);
  return { missing, duplicated };
}
