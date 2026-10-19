import type { DocType } from "../lib/wiki.js";

export interface IndexedSection {
  heading: string;
  headingPath: string;
  anchor: string;
  level: number;
  ord: number;
  body: string;
}

export interface IndexedLink {
  targetText: string;
  heading: string;
}

export interface IndexedDoc {
  slug: string;
  title: string;
  type: DocType;
  aliases: string[];
  tag: string;
  path: string;
  mtimeMs: number;
  size: number;
  sha256: string;
  headings: string[];
  sections: IndexedSection[];
  links: IndexedLink[];
}

export interface IndexedFileStamp {
  slug: string;
  mtimeMs: number;
  size: number;
}
