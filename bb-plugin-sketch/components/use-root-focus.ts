import { useCallback, useEffect, type RefObject } from "react";

export function focusIsLost(doc: Document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body;
}

function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function reclaim(root: HTMLElement | null): void {
  if (root !== null && root.isConnected && focusIsLost(root.ownerDocument)) root.focus({ preventScroll: true });
}

function watchRemovedFocus(root: HTMLElement): () => void {
  let last: Element | null = null;
  const onFocusIn = (event: FocusEvent) => {
    last = event.target instanceof Element && event.target !== root ? event.target : null;
  };
  const onFocusOut = (event: FocusEvent) => {
    const target = event.target;
    if (event.relatedTarget !== null) {
      last = null;
      return;
    }
    queueMicrotask(() => {
      if (target === last && target instanceof Element && target.isConnected) last = null;
    });
  };
  const observer = new MutationObserver(() => {
    if (last === null || last.isConnected) return;
    last = null;
    reclaim(root);
  });
  observer.observe(root, { childList: true, subtree: true });
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", onFocusOut);
  return () => {
    observer.disconnect();
    root.removeEventListener("focusin", onFocusIn);
    root.removeEventListener("focusout", onFocusOut);
  };
}

export function useRootFocus(rootRef: RefObject<HTMLElement | null>): () => void {
  useEffect(() => {
    const root = rootRef.current;
    return root === null ? undefined : watchRemovedFocus(root);
  }, [rootRef]);
  return useCallback(() => nextFrame(() => reclaim(rootRef.current)), [rootRef]);
}
