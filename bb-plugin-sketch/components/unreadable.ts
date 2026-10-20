export type UnreadCounts = { readonly dropped: number; readonly placeholders: number };

function elements(count: number): string {
  return count === 1 ? "1 element" : `${count} elements`;
}

export function unreadableNotice(title: string, { dropped, placeholders }: UnreadCounts): string | null {
  if (dropped === 0 && placeholders === 0) return null;
  const subject = `${elements(dropped + placeholders)} in “${title}” couldn't be read.`;
  const kept = placeholders === 1 ? "1 is kept as a placeholder" : `${placeholders} are kept as placeholders`;
  const skipped = `${dropped === 1 ? "1 was" : `${dropped} were`} skipped and will be left out when Sketch saves`;
  if (dropped === 0) return `${subject} Sketch keeps ${placeholders === 1 ? "it" : "them"} as ${placeholders === 1 ? "a placeholder" : "placeholders"}.`;
  if (placeholders === 0) return `${subject} ${dropped === 1 ? "It was" : "They were"} skipped and will be left out when Sketch saves.`;
  return `${subject} ${kept}; ${skipped}.`;
}
