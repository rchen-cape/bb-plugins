import type { Card, CardSource } from "../contract.js";

export const CARD_MEDIA_DIR = "card-media";

const IMAGE_LINE = /^!\[((?:[^\\\]\n]|\\.)*)\]\(([^\s()<>]+)\)$/;

export interface CardMediaLine {
  caption: string;
  path: string;
}

export function imageAlt(caption: string): string {
  return caption.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, (char) => `\\${char}`);
}

function unescapeAlt(alt: string): string {
  return alt.replace(/\\(.)/g, "$1");
}

export function cardMediaPath(cardId: string, file: string): string {
  return `${CARD_MEDIA_DIR}/${cardId}/${file}`;
}

export function isCardMediaTarget(target: string): boolean {
  return target.startsWith(`${CARD_MEDIA_DIR}/`);
}

export function isOwnCardMedia(target: string, cardId: string): boolean {
  const prefix = cardMediaPath(cardId, "");
  return target.startsWith(prefix) && target.length > prefix.length && !target.slice(prefix.length).includes("/");
}

export function parseCardMediaLine(line: string, cardId: string): CardMediaLine | null {
  const match = IMAGE_LINE.exec(line.trim());
  const caption = match?.[1];
  const target = match?.[2];
  if (caption === undefined || target === undefined || !isOwnCardMedia(target, cardId)) return null;
  return { caption: unescapeAlt(caption), path: target };
}

export function cardTextLine(card: Pick<Card, "id" | "lines" | "text" | "source">): string {
  const fallback = card.source.kind === "upload" ? card.source.name : card.text;
  return card.lines.find((line) => line.trim() !== "" && parseCardMediaLine(line, card.id) === null) ?? fallback;
}

export function sentByAgent(source: CardSource): boolean {
  return source.kind === "agent" || (source.kind === "upload" && source.threadId !== null);
}

export function pluginTitle(pluginId: string): string {
  const words = pluginId.split(/[-_.\s]+/).filter((word) => word !== "");
  if (words.length === 0) return pluginId;
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

export function uploadOrigin(pluginId: string | null): string {
  return pluginId === null ? "Upload" : `From ${pluginTitle(pluginId)}`;
}

export function uploadIcon(pluginId: string | null): string {
  return pluginId === null ? "Paperclip" : "Puzzle";
}
