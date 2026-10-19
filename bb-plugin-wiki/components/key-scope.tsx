import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode, type RefObject } from "react";

export type KeyScopeCheck = (event: KeyboardEvent) => boolean;

const KeyScopeContext = createContext<KeyScopeCheck>(() => true);

function isAmbientTarget(target: EventTarget | null): boolean {
  return !(target instanceof Element) || target === target.ownerDocument.body || target === target.ownerDocument.documentElement;
}

export function useKeyScopeRoot(root: RefObject<HTMLElement | null>): KeyScopeCheck {
  const lastPointerInside = useRef(true);
  useEffect(() => {
    const onPointerDown = (event: Event) => {
      const node = root.current;
      lastPointerInside.current = node !== null && event.target instanceof Node && node.contains(event.target);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [root]);
  return useCallback(
    (event: KeyboardEvent) => {
      const node = root.current;
      if (node === null) return false;
      if (isAmbientTarget(event.target)) return lastPointerInside.current;
      return event.target instanceof Node && node.contains(event.target);
    },
    [root],
  );
}

export function KeyScopeProvider({ check, children }: { check: KeyScopeCheck; children: ReactNode }) {
  return <KeyScopeContext.Provider value={check}>{children}</KeyScopeContext.Provider>;
}

export function useKeyScope(): KeyScopeCheck {
  return useContext(KeyScopeContext);
}
