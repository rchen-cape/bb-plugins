function isApplePlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export const MOD_KEY_LABEL = isApplePlatform() ? "⌘" : "Ctrl";

export function isModEnter(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}
