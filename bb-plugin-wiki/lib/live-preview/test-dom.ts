export function installDomPolyfills(): void {
  if (typeof window === "undefined") return;
  if (typeof Range.prototype.getClientRects !== "function") {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: (): DOMRectList => {
        const list: DOMRect[] = [];
        return Object.assign(list, { item: () => null });
      },
    });
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: (): DOMRect => new DOMRect(),
    });
  }
  if (typeof document.elementFromPoint !== "function") {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => null,
    });
  }
}
