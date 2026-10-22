import { Annotation, type Text } from "@codemirror/state";

export interface DocumentFormat {
  lineSeparator: "\n" | "\r\n" | "\r";
  bom: boolean;
}

const BOM = "\uFEFF";

export function openDocument(content: string): {
  text: string;
  format: DocumentFormat;
} {
  const bom = content.startsWith(BOM);
  const body = bom ? content.slice(1) : content;
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    if (code === 10) lf++;
    else if (code === 13) {
      if (body.charCodeAt(index + 1) === 10) {
        crlf++;
        index++;
      } else cr++;
    }
  }
  const lineSeparator =
    crlf > lf && crlf >= cr ? "\r\n" : cr > lf && cr > crlf ? "\r" : "\n";
  return {
    text: body.replace(/\r\n?/g, "\n"),
    format: { lineSeparator, bom },
  };
}

export function saveDocument(doc: Text, format: DocumentFormat): string {
  return (
    (format.bom ? BOM : "") +
    doc.sliceString(0, doc.length, format.lineSeparator)
  );
}

export function contentVersion(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function minimalChange(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (
    prefix < limit &&
    oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)
  ) {
    prefix++;
  }
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (
    suffix > 0 &&
    isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))
  ) {
    suffix--;
  }
  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}

export const externalChange = Annotation.define<boolean>();
